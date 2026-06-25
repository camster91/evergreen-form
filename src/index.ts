import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "crypto";

// ════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const DB_PATH = process.env.DB_PATH || "/data/submissions.db";

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error("FATAL: ADMIN_USER and ADMIN_PASS env vars are required");
  process.exit(1);
}

// Rate limiting
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"); // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "5"); // 5 per window
const RATE_LIMIT_CLEANUP_MS = parseInt(process.env.RATE_LIMIT_CLEANUP_MS || "300000"); // cleanup every 5 min

// Email (Maton API) — required for alerts
const MATON_API_KEY = process.env.MATON_API_KEY || "";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "cameron@ashbi.ca";
const FROM_EMAIL = process.env.FROM_EMAIL || "cameron@ashbi.ca";
const ENABLE_EMAIL_ALERTS = !!MATON_API_KEY && !!ALERT_EMAIL;

// Logging
const LOG_PATH = process.env.LOG_PATH || "/data/app.log";
const MAX_LOG_SIZE_MB = parseInt(process.env.MAX_LOG_SIZE_MB || "10", 10);

// Feature flags
const EMAIL_ON_SUBMIT = process.env.EMAIL_ON_SUBMIT === "1";
const ENABLE_CORS = process.env.ENABLE_CORS !== "0";
const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // debug, info, warn, error

// Metrics
let requestCount = 0;
let submitCount = 0;
let errorCount = 0;
const startTime = Date.now();

// ════════════════════════════════════════════
// LOGGING
// ════════════════════════════════════════════
const logFile = LOG_PATH;
let currentLogSize = 0;

try {
  currentLogSize = await Bun.file(logFile).size;
} catch {
  currentLogSize = 0;
}

async function rotateLogIfNeeded(): Promise<void> {
  if (currentLogSize > MAX_LOG_SIZE_MB * 1024 * 1024) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${logFile}.${timestamp}`;
    try {
      await Bun.write(backupPath, await Bun.file(logFile).text());
      await Bun.write(logFile, "");
      currentLogSize = 0;
      info("Log rotated", { backupPath });
    } catch (e) {
      error("Failed to rotate log", { error: String(e) });
    }
  }
}

async function appendLog(line: string): Promise<void> {
  const text = line + "\n";
  currentLogSize += text.length;
  await Bun.write(logFile, text, { append: true });
  if (currentLogSize > MAX_LOG_SIZE_MB * 1024 * 1024) {
    await rotateLogIfNeeded();
  }
}

function logLevelPriority(level: string): number {
  return {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  }[level] ?? 1;
}

function shouldLog(level: string): boolean {
  return logLevelPriority(level) >= logLevelPriority(LOG_LEVEL);
}

function fmt(level: string, msg: string, meta?: Record<string, any>): string {
  const ts = new Date().toISOString();
  const payload = meta ? ` ${JSON.stringify(meta)}` : "";
  return `[${ts}] [${level.toUpperCase()}] ${msg}${payload}`;
}

async function log(level: string, msg: string, meta?: Record<string, any>): Promise<void> {
  if (!shouldLog(level)) return;
  const line = fmt(level, msg, meta);
  // eslint-disable-next-line no-console
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  await appendLog(line);
}

const info = (msg: string, meta?: Record<string, any>) => log("info", msg, meta);
const warn = (msg: string, meta?: Record<string, any>) => log("warn", msg, meta);
const error = (msg: string, meta?: Record<string, any>) => log("error", msg, meta);
const debug = (msg: string, meta?: Record<string, any>) => log("debug", msg, meta);

// ════════════════════════════════════════════
// EMAIL ALERTS (Maton API)
// ════════════════════════════════════════════
async function sendAlert(subject: string, body: string, isError: boolean = false): Promise<void> {
  if (!ENABLE_EMAIL_ALERTS) {
    warn("Email alerts disabled — set MATON_API_KEY and ALERT_EMAIL", { subject });
    return;
  }

  const fullBody = `${body}\n\n---\nApp: Evergreen Form\nTime: ${new Date().toISOString()}\n`;
  const mime = `From: ${FROM_EMAIL}\nTo: ${ALERT_EMAIL}\nSubject: ${isError ? "[ERROR] " : "[INFO] "}${subject}\n\n${fullBody}`;
  const encoded = btoa(mime).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch("https://api.maton.ai/google-mail/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MATON_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: encoded }),
      });
      if (resp.ok) {
        info("Alert email sent", { subject, attempt: i + 1 });
        return;
      }
      const text = await resp.text();
      warn("Alert email failed", { status: resp.status, attempt: i + 1, body: text });
    } catch (e: any) {
      warn("Alert email error", { error: e.message, attempt: i + 1 });
    }
    // Exponential back-off
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }

  error("All alert email retries exhausted", { subject });
}

// ════════════════════════════════════════════
// RATE LIMITER
// ════════════════════════════════════════════
interface RateEntry {
  count: number;
  resetAt: number;
}

const rateMap = new Map<string, RateEntry>();

function getClientIP(request: Request): string {
  const xfwd = request.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0].trim();
  const xreal = request.headers.get("x-real-ip");
  if (xreal) return xreal.trim();
  return "127.0.0.1";
}

const RATE_LIMIT_MAX_ENTRIES = 10000;

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();

  // LRU eviction: if map is at capacity, delete oldest entry
  if (rateMap.size >= RATE_LIMIT_MAX_ENTRIES && !rateMap.has(ip)) {
    const firstKey = rateMap.keys().next().value;
    if (firstKey !== undefined) rateMap.delete(firstKey);
  }

  const entry = rateMap.get(ip);

  if (!entry) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetIn: RATE_LIMIT_WINDOW_MS };
  }

  if (now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetIn: RATE_LIMIT_WINDOW_MS };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const resetIn = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, resetIn };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count, resetIn: Math.ceil((entry.resetAt - now) / 1000) };
}

// Clean stale rate entries periodically
function startRateLimitCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [ip, entry] of rateMap.entries()) {
      if (now > entry.resetAt + RATE_LIMIT_CLEANUP_MS) {
        rateMap.delete(ip);
        cleaned++;
      }
    }
    if (cleaned > 0) debug("Rate limit cleanup", { cleaned });
  }, RATE_LIMIT_CLEANUP_MS);
}
startRateLimitCleanup();

// ════════════════════════════════════════════
// SQLITE
// ════════════════════════════════════════════
function initDatabase() {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;"); // 5s wait for locked pages (concurrent writes)

  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      address1 TEXT NOT NULL,
      address2 TEXT,
      city TEXT,
      region TEXT NOT NULL,
      zip TEXT NOT NULL,
      country TEXT,
      notes TEXT,
      marketing_optin INTEGER DEFAULT 0,
      window TEXT,
      delivery_instructions TEXT,
      instagram_handle TEXT,
      ip TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrate: add window column if missing
  try {
    db.exec(`ALTER TABLE submissions ADD COLUMN window TEXT`);
  } catch {
    // already exists — safe to ignore
  }

  // Migrate: add status column if missing
  try {
    db.exec(`ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'pending'`);
  } catch {
    // already exists — safe to ignore
  }

  // Migrate: add delivery_instructions column if missing
  try {
    db.exec(`ALTER TABLE submissions ADD COLUMN delivery_instructions TEXT`);
  } catch {
    // already exists — safe to ignore
  }

  // Migrate: add instagram_handle column if missing
  try {
    db.exec(`ALTER TABLE submissions ADD COLUMN instagram_handle TEXT`);
  } catch {
    // already exists — safe to ignore
  }

  // Indexes for common queries
  db.exec("CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions(email)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions(submitted_at DESC)");

  return {
    db,
    insert: db.prepare(`
      INSERT INTO submissions (first_name, last_name, email, phone, address1, address2, city, region, zip, country, notes, window, delivery_instructions, instagram_handle, marketing_optin, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listAll: db.prepare(`SELECT * FROM submissions ORDER BY submitted_at DESC`),
    listRecent: db.prepare(`SELECT * FROM submissions ORDER BY submitted_at DESC LIMIT 500`),
    deleteById: db.prepare(`DELETE FROM submissions WHERE id = ?`),
    updateById: db.prepare(`UPDATE submissions SET first_name = ?, last_name = ?, email = ?, phone = ?, address1 = ?, address2 = ?, city = ?, region = ?, zip = ?, country = ?, window = ?, delivery_instructions = ?, instagram_handle = ?, marketing_optin = ? WHERE id = ?`),
    countAll: db.prepare(`SELECT COUNT(*) as count FROM submissions`),
    countToday: db.prepare(`SELECT COUNT(*) as count FROM submissions WHERE DATE(submitted_at) = DATE('now')`),
    countByIPToday: db.prepare(`SELECT COUNT(*) as count FROM submissions WHERE ip = ? AND DATE(submitted_at) = DATE('now')`),
    updateStatus: db.prepare(`UPDATE submissions SET status = ? WHERE id = ?`),
    updateNotes: db.prepare(`UPDATE submissions SET notes = ? WHERE id = ?`),
    countByStatus: db.prepare(`SELECT status, COUNT(*) as count FROM submissions GROUP BY status`),
  };
}

let sql;
try {
  sql = initDatabase();
} catch (e: any) {
  error("Database initialization failed", { error: e.message });
  console.error("FATAL: Cannot initialize database at", DB_PATH);
  process.exit(1);
}
const { db, insert, listAll, listRecent, deleteById, updateById, countAll, countToday, countByIPToday, updateStatus, updateNotes, countByStatus } = sql;

const STATUSES = ["pending", "preparing", "shipped", "delivered", "cancelled"] as const;
type Status = typeof STATUSES[number];

// Periodic DB integrity check
setInterval(() => {
  try {
    const result = db.prepare("PRAGMA integrity_check").get();
    debug("SQLite integrity check", { result });
  } catch (e: any) {
    error("SQLite integrity check failed", { error: e.message });
    sendAlert("Evergreen: DB integrity failure", e.message, true);
  }
}, 3600000); // hourly

info("Database initialized", { path: DB_PATH });

// ════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════
function validateEmail(email: string): boolean {
  // RFC 5322-ish, practical
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email);
}

function sanitizeString(val: string | undefined): string {
  if (!val) return "";
  // Strip null bytes and control chars, limit length
  return val.substring(0, 1000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
}

// ════════════════════════════════════════════
// HTML HELPERS
// ════════════════════════════════════════════
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function formatDate(d: string): string {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short", timeZone: "America/Toronto" });
  } catch {
    return d;
  }
}

// ════════════════════════════════════════════
// BASIC AUTH
// ════════════════════════════════════════════
function secureCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function checkBasicAuth(headers: Record<string, string | undefined>): boolean {
  const auth = headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) return false;
  try {
    const creds = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const idx = creds.indexOf(":");
    if (idx === -1) return false;
    const u = creds.substring(0, idx);
    const p = creds.substring(idx + 1);
    return secureCompare(u, ADMIN_USER) && secureCompare(p, ADMIN_PASS);
  } catch {
    return false;
  }
}

function requireAuth(set: any): string | null {
  if (!checkBasicAuth(set.headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return "Unauthorized";
  }
  return null;
}

// ════════════════════════════════════════════
// SUBMISSION NOTIFICATION EMAIL
// ════════════════════════════════════════════
const SUBMISSION_EMAIL_ON = EMAIL_ON_SUBMIT && ENABLE_EMAIL_ALERTS;

async function notifySubmission(data: {
  first_name: string;
  last_name: string;
  email: string;
  address1: string;
  city: string;
  region: string;
  zip: string;
  country: string;
  phone?: string;
  address2?: string;
  notes?: string;
  delivery_instructions?: string;
  instagram_handle?: string;
  marketing_optin: boolean;
  ip: string;
  id: number;
}) {
  if (!SUBMISSION_EMAIL_ON) return;

  const body = `New free sample submission!

Name: ${data.first_name} ${data.last_name}
Email: ${data.email}
Phone: ${data.phone || "(none)"}
Address: ${data.address1}${data.address2 ? ", " + data.address2 : ""}
City: ${data.city}
Region: ${data.region}
ZIP: ${data.zip}
Country: ${data.country}
Notes: ${data.notes || "(none)"}
Delivery Instructions: ${data.delivery_instructions || "(none)"}
Instagram: ${data.instagram_handle || "(none)"}
Marketing Opt-in: ${data.marketing_optin ? "Yes" : "No"}
IP: ${data.ip}
ID: ${data.id}
Time: ${new Date().toISOString()}

---
View all: https://evergreen-form.ashbi.ca/admin
Export CSV: https://evergreen-form.ashbi.ca/export`;

  await sendAlert("New Evergreen Submission", body, false);
}

// ════════════════════════════════════════════
// CSP / SECURITY HEADERS
// ════════════════════════════════════════════
function setSecurityHeaders(outHeaders: Record<string, string>): void {
  // Strict CSP — only allow self, Google Fonts, inline styles
  outHeaders["Content-Security-Policy"] =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors https://eatevergreen.com https://*.myshopify.com https://evergreen-form.ashbi.ca;";
  outHeaders["X-Content-Type-Options"] = "nosniff";
  // X-Frame-Options omitted — CSP frame-ancestors handles framing policy
  // Explicitly unset to override Elysia default DENY
  outHeaders["X-Frame-Options"] = "";
  outHeaders["Referrer-Policy"] = "strict-origin-when-cross-origin";
  outHeaders["Cache-Control"] = "no-store";
}

// ════════════════════════════════════════════
// PAGES (inline HTML)
// ════════════════════════════════════════════

const FORM_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Free Samples — Evergreen</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@300;400;600;700&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Fredoka', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #FFFFFF;
  margin: 0;
  padding: 0;
  -webkit-font-smoothing: antialiased;
}
.card {
  width: 100%;
  max-width: 100%;
  background: #FFFFFF;
  padding: 12px 16px; /* was 20px 16px — saves 16px */
}
.input-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px; /* was 14px */
  margin-bottom: 10px; /* was 14px */
}
.input-grid input, .full input {
  width: 100%;
  padding: 12px 16px; /* was 14px 18px */
  border: 2px solid #F06464;
  border-radius: 999px;
  font-family: 'Fredoka', sans-serif;
  font-size: 15px;
  font-weight: 400;
  color: #2C2C2C;
  background: #fff;
  outline: none;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.input-grid input::placeholder, .full input::placeholder, .full textarea::placeholder {
  color: #EDA8A8;
  font-weight: 600;
}
.input-grid input:focus, .full input:focus, .full textarea:focus {
  border-color: #F06464;
  box-shadow: 0 0 0 4px rgba(240,100,100,0.15);
}
.full { margin-bottom: 10px; } /* was 14px */
.full textarea {
  width: 100%;
  padding: 10px 14px; /* was 12px 16px */
  border: 2px solid #F06464;
  border-radius: 12px;
  font-family: 'Fredoka', sans-serif;
  font-size: 15px;
  font-weight: 400;
  color: #2C2C2C;
  background: #fff;
  outline: none;
  transition: box-shadow 0.2s, border-color 0.2s;
  resize: vertical;
}
.section-label {
  text-align: center;
  font-size: 18px; /* was 20px */
  font-weight: 700;
  color: #F06464;
  margin: 10px 0 0; /* was 14px 0 2px */
}
.section-hint {
  text-align: center;
  font-size: 11px; /* was 12px */
  color: #F06464;
  font-weight: 400;
  margin-bottom: 8px; /* was 12px */
}
.delivery-row {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.delivery-row label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #F06464;
  font-weight: 400;
  cursor: pointer;
}
.delivery-row input[type="radio"] {
  appearance: none;
  width: 18px;
  height: 18px;
  border: 2px solid #F06464;
  border-radius: 3px;
  cursor: pointer;
  position: relative;
  background: #fff;
  transition: background .2s, border-color .2s;
}
.delivery-row input[type="radio"]:checked {
  background: #F06464;
  border-color: #F06464;
}
.delivery-row input[type="radio"]:checked::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 0px;
  width: 5px;
  height: 10px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.disclaimer {
  text-align: center;
  font-size: 12px; /* was 13px */
  color: #F06464;
  font-weight: 400;
  margin-bottom: 8px; /* was 16px */
}
.disclaimer a {
  color: #F2786D;
  text-decoration: underline;
}
.opt-in {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 12px; /* was 13px */
  color: #F06464;
  font-weight: 400;
  margin-bottom: 10px; /* was 16px */
  cursor: pointer;
}
.opt-in input[type="checkbox"] {
  appearance: none;
  width: 18px;
  height: 18px;
  border: 2px solid #F06464;
  border-radius: 3px;
  cursor: pointer;
  position: relative;
  background: #fff;
  flex-shrink: 0;
  margin-top: 1px;
  transition: background .2s, border-color .2s;
}
.opt-in input[type="checkbox"]:checked {
  background: #F06464;
  border-color: #F06464;
}
.opt-in input[type="checkbox"]:checked::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 0px;
  width: 5px;
  height: 10px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.submit-btn {
  width: 100%;
  padding: 14px 24px; /* was 18px 24px */
  border: none;
  border-radius: 999px;
  font-family: 'Fredoka', sans-serif;
  font-size: 18px; /* was 20px */
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: #fff;
  cursor: pointer;
  background: linear-gradient(180deg, #F87D7D 0%, #F4525C 100%);
  box-shadow: 0 6px 0 #C53838; /* was 0 8px 0 */
  transition: transform 0.08s, box-shadow 0.08s;
}
.submit-btn:hover {
  transform: translateY(2px);
  box-shadow: 0 4px 0 #C53838; /* was 0 6px 0 */
}
.submit-btn:active {
  transform: translateY(4px);
  box-shadow: 0 2px 0 #C53838;
}
.submit-btn:disabled {
  background: #ccc;
  box-shadow: 0 4px 0 #999;
  cursor: not-allowed;
}
.fsf-message {
  display: none;
  padding: 14px 16px;
  border-radius: 14px;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 16px;
  text-align: center;
}
.fsf-message.success {
  display: block;
  background: #e8f5e9;
  color: #2e7d32;
  border: 2px solid #2e7d32;
}
.fsf-message.error {
  display: block;
  background: #ffebee;
  color: #c62828;
  border: 2px solid #c62828;
}
.thank-you {
  display: none;
  text-align: center;
  padding: 40px 20px;
}
.thank-you.show {
  display: block;
}
.thank-you h2 {
  font-size: 28px;
  font-weight: 700;
  color: #F06464;
  margin-bottom: 12px;
}
.thank-you p {
  font-size: 16px;
  color: #2C2C2C;
  line-height: 1.5;
}

@media (max-width: 480px) {
  body { padding: 20px 12px; }
  .card { padding: 24px 14px; }
  .input-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="card">
<div class="thank-you" id="fsf-thankyou">
  <h2>Thank You!</h2>
  <p>Your sample request has been received. We'll be in touch soon.</p>
</div>
<form id="fsf-form" method="post" action="/submit">
  <div class="input-grid">
    <input type="text" name="first_name" placeholder="first name" required maxlength="80">
    <input type="text" name="last_name" placeholder="last name" required maxlength="80">
    <input type="text" name="address1" placeholder="street" required maxlength="256">
    <input type="text" name="address2" placeholder="apartment / unit #" maxlength="128">
    <input type="text" name="city" placeholder="city" required maxlength="80">
    <input type="text" name="region" placeholder="state" required maxlength="64">
    <input type="text" name="zip" placeholder="zip code" required maxlength="20">
  </div>
  <div class="full">
    <input type="text" name="instagram_handle" placeholder="Instagram handle (optional)" maxlength="80" autocomplete="off" pattern="^@?[A-Za-z0-9._\\-]{1,80}$">
  </div>
  <div class="full">
    <textarea name="delivery_instructions" placeholder="Additional delivery instructions; Example - gate code" rows="2" maxlength="500"></textarea>
  </div>
  <div class="section-label">Preferred Delivery Window</div>
  <div class="section-hint">please select only one - all delivery windows in local time</div>
  <div class="delivery-row">
    <label><input type="radio" name="window" value="tue-am" required><span>Tuesday 9-11am</span></label>
    <label><input type="radio" name="window" value="tue-pm"><span>Tuesday 4-6pm</span></label>
    <label><input type="radio" name="window" value="thu-am"><span>Thursday 9-11am</span></label>
    <label><input type="radio" name="window" value="thu-pm"><span>Thursday 4-6pm</span></label>
  </div>
  <div class="disclaimer">
    Orders will be delivered via Instacart or local grocery delivery service.
  </div>
  <div class="full">
    <input type="email" name="email" placeholder="email" required maxlength="256">
  </div>
  <label class="opt-in">
    <input type="checkbox" name="marketing_optin" value="1">
    <span>*Send me special offers, coupons and new breakfast drops!</span>
  </label>
  <div class="fsf-message" id="fsf-message"></div>
  <button type="submit" class="submit-btn">SUBMIT</button>
  <input type="text" name="company" style="display:none !important;" tabindex="-1" autocomplete="off" aria-hidden="true">
</form>
</div>
<script>
(function() {
  var form = document.getElementById('fsf-form');
  var msg = document.getElementById('fsf-message');
  var btn = form.querySelector('button[type="submit"]');
  var thankyou = document.getElementById('fsf-thankyou');
  var originalText = btn.textContent;
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    msg.style.display = 'none'; msg.className = 'fsf-message';
    btn.disabled = true; btn.textContent = 'Submitting...';
    var data = new FormData(form);
    fetch('/submit', { method: 'POST', body: data })
    .then(function(r) { return r.json(); })
    .then(function(json) {
      if (json.success) {
        form.style.display = 'none';
        thankyou.classList.add('show');
        form.reset();
      } else {
        msg.style.display = 'block';
        msg.textContent = json.message || 'Something went wrong.';
        msg.className = 'fsf-message error';
      }
    })
    .catch(function() { msg.style.display = 'block'; msg.textContent = 'Network error.'; msg.className = 'fsf-message error'; })
    .finally(function() { btn.disabled = false; btn.textContent = originalText; });
  });
})();
</script>
</body>
</html>`;

const EMBED_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Embed Evergreen Form</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:40px;background:#f7f7f7;color:#1a1a1a;max-width:700px;margin:40px auto;}
h1{margin:0 0 8px;font-size:24px;font-weight:700;}
p{margin:0 0 16px;color:#555;font-size:15px;}
code{background:#1a1a1a;color:#fff;padding:16px 20px;border-radius:10px;display:block;font-size:13px;line-height:1.6;overflow-x:auto;white-space:pre;}
.btn{background:#ff6b35;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;border:none;cursor:pointer;}
.btn:hover{background:#e55a2b;}
.field{margin-bottom:16px;}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;}
input{width:100%;padding:12px 14px;border:2px solid #ddd;border-radius:8px;font-size:14px;}
input:focus{outline:none;border-color:#ff6b35;}
.preview{background:#fff;padding:24px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-top:20px;}
</style>
</head>
<body>
<h1>Embed on Shopify</h1>
<p>Copy the iframe code below into any Shopify page, landing page, or external site.</p>
<div class="field">
  <label>iFrame Embed Code</label>
  <code id="embed-code">&lt;iframe
    src="https://evergreen-form.ashbi.ca/"
    width="100%"
    height="100%"
    style="border:none;overflow:hidden;display:block;"
    frameborder="0"
    scrolling="no"
  &gt;&lt;/iframe&gt;</code>
</div>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('embed-code').textContent);this.textContent='Copied!';">Copy to Clipboard</button>
<div class="preview">
  <h3 style="margin-top:0;font-size:18px;">Preview</h3>
  <iframe src="/" width="100%" height="500" style="border:2px solid #eee;border-radius:8px;" frameborder="0"></iframe>
</div>
<h2 style="margin-top:32px;font-size:20px;">Direct Link</h2>
<p>If you prefer to link out instead of embedding:</p>
<code>https://evergreen-form.ashbi.ca/</code>
<h2 style="margin-top:32px;font-size:20px;">Shopify Instructions</h2>
<ol>
  <li>In Shopify Admin, go to <b>Online Store → Pages</b></li>
  <li>Add a new page or edit an existing one</li>
  <li>Click the <b>&lt;/&gt; Show HTML</b> button in the rich text editor</li>
  <li>Paste the iframe code above</li>
  <li>Save the page</li>
</ol>
</body>
</html>`;

// ════════════════════════════════════════════
// RATE-LIMIT ERROR HTML
// ════════════════════════════════════════════
function rateLimitHTML(resetIn: number): string {
  const seconds = resetIn || 60;
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h1>⏳ Rate Limit Exceeded</h1><p>You've submitted too many requests. Please wait <b>${seconds}</b> seconds and try again.</p><p><a href="/">Go back</a></p></body></html>`;
}

// ════════════════════════════════════════════
// ELYSIA APP
// ════════════════════════════════════════════
const app = new Elysia()
  .onRequest(ctx => {
    requestCount++;
    ctx.store = {
      startTime: performance.now(),
      clientIP: getClientIP(ctx.request),
    } as any;
    debug("Request", {
      method: ctx.request.method,
      path: new URL(ctx.request.url).pathname,
      ip: (ctx.store as any).clientIP,
      ua: ctx.request.headers.get("user-agent")?.substring(0, 64) || "",
    });
  })
  .onError(ctx => {
    errorCount++;
    const err = ctx.error as Error;
    const path = new URL(ctx.request.url).pathname;
    error("Unhandled error", {
      path,
      message: err?.message || String(ctx.error),
      stack: err?.stack,
    });
    sendAlert("Evergreen: Unhandled error", `Path: ${path}\nMessage: ${err?.message || "unknown"}`, true);
    ctx.set.status = 500;
    return "Internal Server Error";
  })
  .onAfterResponse(ctx => {
    const elapsed = performance.now() - ((ctx.store as any)?.startTime || performance.now());
    const status = ctx.set.status || 200;
    if (status >= 500) {
      error("HTTP 5xx", { path: new URL(ctx.request.url).pathname, status, elapsed });
    } else if (status >= 400) {
      warn("HTTP 4xx", { path: new URL(ctx.request.url).pathname, status, elapsed });
    } else {
      debug("Response", { path: new URL(ctx.request.url).pathname, status, elapsed });
    }
  });

// ── CORS ──
if (ENABLE_CORS) {
  app.use(cors({ origin: ["https://eatevergreen.com", "https://*.myshopify.com", "https://evergreen-form.ashbi.ca", "https://ashbi.ca"], credentials: false }));
}

// ════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════

// ── Health check (Traefik + monitoring) ──
app.get("/health", () => {
  try {
    const total = (countAll.get() as any).count as number;
    const today = (countToday.get() as any).count as number;
    return {
      status: "ok",
      uptimeMs: Date.now() - startTime,
      requestCount,
      submitCount,
      errorCount,
      totalSubmissions: total,
      todaySubmissions: today,
      version: "1.2.0",
    };
  } catch (e: any) {
    error("Health check failed", { error: e.message });
    return { status: "degraded", reason: e.message };
  }
});

// Alias for monitoring tools expecting /api/health
app.get("/api/health", () => {
  try {
    const total = (countAll.get() as any).count as number;
    const today = (countToday.get() as any).count as number;
    return {
      status: "ok",
      uptimeMs: Date.now() - startTime,
      requestCount,
      submitCount,
      errorCount,
      totalSubmissions: total,
      todaySubmissions: today,
      version: "1.2.0",
    };
  } catch (e: any) {
    return { status: "degraded", reason: e.message };
  }
});

// ── Form page (GET /) ──
app.get("/", ({ set }) => {
  set.headers["Content-Type"] = "text/html";
  setSecurityHeaders(set.headers as Record<string, string>);
  return FORM_PAGE;
});

// ── Submission (POST /submit) ──
app.post("/submit", async ({ body, request, set }) => {
  const ip = getClientIP(request);

  // Rate limit
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    warn("Rate limit hit", { ip });
    set.status = 429;
    set.headers["Retry-After"] = String(rl.resetIn);
    return rateLimitHTML(rl.resetIn);
  }

  // Anti-spam: max 10 per IP per day
  const ipCountToday = ((countByIPToday.get(ip) as any)?.count as number) || 0;
  if (ipCountToday >= 10) {
    warn("IP daily limit hit", { ip, count: ipCountToday });
    set.status = 429;
    return JSON.stringify({ success: false, message: "Daily submission limit reached. Please try again tomorrow." });
  }

  // Honeypot: if "company" field is filled, reject (bot)
  const rawBody = body as Record<string, any>;
  if (rawBody.company && String(rawBody.company).trim()) {
    warn("Honeypot triggered", { ip, company: rawBody.company });
    set.status = 400;
    return JSON.stringify({ success: false, message: "Invalid submission." });
  }

  const data = body as Record<string, any>;

  // Sanitize + trim
  const first_name = sanitizeString(data.first_name);
  const last_name = sanitizeString(data.last_name);
  const email = sanitizeString(data.email)?.toLowerCase();
  const address1 = sanitizeString(data.address1);
  const address2 = sanitizeString(data.address2);
  const city = sanitizeString(data.city);
  const region = sanitizeString(data.region);
  const zip = sanitizeString(data.zip);
  const windowVal = sanitizeString(data.window);
  const marketing_optin = data.marketing_optin === "1" ? 1 : 0;
  const delivery_instructions = sanitizeString(data.delivery_instructions);
  const instagram_handle = sanitizeString(data.instagram_handle);

  // Validation
  const required = { first_name, last_name, email, address1, city, region, zip };
  const missing: string[] = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    warn("Validation failed", { missing: missing.join(", "), ip });
    set.status = 400;
    return { success: false, message: "Please fill in: " + missing.join(", ") };
  }
  if (!validateEmail(email)) {
    warn("Invalid email", { email, ip });
    set.status = 400;
    return { success: false, message: "Please enter a valid email." };
  }

  // Duplicate check: same email + address1 today
  try {
    const dupStmt = db.prepare(`SELECT COUNT(*) as count FROM submissions WHERE email = ? AND address1 = ? AND DATE(submitted_at) = DATE('now')`);
    const dupCount = ((dupStmt.get(email, address1) as any)?.count as number) || 0;
    if (dupCount > 0) {
      warn("Duplicate submission blocked", { email, ip });
      // Silently accept but show success to avoid leaking duplicates
      return { success: true, message: "Thank you! Your request is confirmed." };
    }
  } catch (e: any) {
    error("Duplicate check failed", { error: e.message });
  }

  // Insert
  let result;
  try {
    result = insert.run(first_name, last_name, email, null, address1, address2, city, region, zip, null, null, windowVal, delivery_instructions, instagram_handle, marketing_optin, ip);
  } catch (e: any) {
    error("DB insert failed", { error: e.message, ip });
    sendAlert("Evergreen: DB insert error", e.message, true);
    set.status = 500;
    return { success: false, message: "Something went wrong. Please try again later." };
  }

  submitCount++;
  const id = Number(result.lastInsertRowid);

  info("Submission saved", {
    id,
    email,
    ip,
    window: windowVal,
    marketing_optin: marketing_optin === 1,
  });

  // Notify via email
  if (SUBMISSION_EMAIL_ON) {
    await notifySubmission({
      first_name, last_name, email, phone: sanitizeString(data.phone || ""), address1, city, region, zip, country: sanitizeString(data.country || ""), address2, notes: windowVal ? `Window: ${windowVal}` : "", delivery_instructions, instagram_handle, marketing_optin: marketing_optin === 1, ip, id,
    });
  }

  return { success: true, message: "Thank you! Your request is confirmed." };
});

// ── Admin dashboard ──
app.get("/admin", ({ headers, set }) => {
  set.headers["Content-Type"] = "text/html";
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return "Unauthorized";
  }

  const total = ((countAll.get() as any).count as number) || 0;
  const today = ((countToday.get() as any).count as number) || 0;
  const rows = (listRecent.all() as any[]) || [];

  // Status counts
  const statusCounts: Record<string, number> = {};
  for (const s of STATUSES) statusCounts[s] = 0;
  const srows = (countByStatus.all() as any[]) || [];
  for (const s of srows) {
    if (statusCounts.hasOwnProperty(s.status)) statusCounts[s.status] = s.count;
  }

  const statusBadge = (status: string) => {
    const s = (status || "pending").toLowerCase();
    const labels: Record<string, string> = {
      pending: '<span class="badge badge-pending">Pending</span>',
      preparing: '<span class="badge badge-preparing">Preparing</span>',
      shipped: '<span class="badge badge-shipped">Shipped</span>',
      delivered: '<span class="badge badge-delivered">Delivered</span>',
      cancelled: '<span class="badge badge-cancelled">Cancelled</span>',
    };
    return labels[s] || labels["pending"];
  };

  let tableRows = "";
  for (const r of rows) {
    const name = escapeHtml(String(r.first_name || "")) + " " + escapeHtml(String(r.last_name || ""));
    const addr = escapeHtml(String(r.address1 || "") + (r.address2 ? ", " + String(r.address2) : ""));
    const st = (r.status || "pending").toLowerCase();
    const dinst = String(r.delivery_instructions || "");
    const dinstShort = dinst.length > 40 ? dinst.substring(0, 40) + "…" : dinst;
    // Build a single lowercase haystack for fast client-side search
    const searchHaystack = [
      r.id, r.first_name, r.last_name, r.email, r.phone,
      r.address1, r.address2, r.city, r.region, r.zip, r.country,
      r.window, r.delivery_instructions, r.instagram_handle, r.status, r.notes,
      r.marketing_optin ? "yes" : "no",
    ].map(v => String(v || "").toLowerCase()).join(" ");
    tableRows += `<tr data-id="${r.id}" data-status="${st}" data-notes="${escapeHtml(String(r.notes || ""))}" data-dinst="${escapeHtml(dinst)}" data-instagram="${escapeHtml(String(r.instagram_handle || ""))}" data-search="${escapeHtml(searchHaystack)}">
      <td><input type="checkbox" class="row-check" value="${r.id}"></td>
      <td>${r.id}</td>
      <td class="td-name">${name}</td>
      <td class="td-email">${escapeHtml(String(r.email || ""))}</td>
      <td class="td-phone">${escapeHtml(String(r.phone || ""))}</td>
      <td class="td-addr">${addr}</td>
      <td class="td-city">${escapeHtml(String(r.city || ""))}</td>
      <td class="td-region">${escapeHtml(String(r.region || ""))}</td>
      <td class="td-zip">${escapeHtml(String(r.zip || ""))}</td>
      <td class="td-country">${escapeHtml(String(r.country || ""))}</td>
      <td class="td-window">${escapeHtml(String(r.window || ""))}</td>
      <td class="td-dinst" title="${escapeHtml(dinst)}">${escapeHtml(dinstShort) || '<span style="color:#ccc">—</span>'}</td>
      <td class="td-instagram">${escapeHtml(String(r.instagram_handle || ""))}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="td-optin">${r.marketing_optin ? "Yes" : "No"}</td>
      <td>${formatDate(r.submitted_at)}</td>
      <td class="actions">
        <button class="btn-small btn-ship" onclick="shipRow(${r.id})" title="Mark as Shipped">Ship</button>
        <button class="btn-small btn-edit" onclick="editRow(${r.id})">Edit</button>
        <button class="btn-small btn-delete" onclick="deleteRow(${r.id})">Del</button>
      </td>
    </tr>`;
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Evergreen Submissions</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--coral:#F2786D;--coral-dark:#E55A2B;--yellow:#fce55d;--bg:#FFF8F0;--text:#2C2C2C;--white:#fff;--gray:#888;--light:#fafafa;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Fredoka',system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px 16px;line-height:1.5;}
.header{display:flex;align-items:center;gap:14px;margin-bottom:24px;}
.header img{width:56px;height:56px;border-radius:50%;object-fit:cover;background:var(--yellow);}
.header h1{font-size:28px;font-weight:700;color:var(--coral);margin:0;}
.header p{color:var(--gray);font-size:14px;margin:0;}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px;}
.toolbar-left{display:flex;gap:10px;flex-wrap:wrap;flex:1;}
.toolbar-right{display:flex;gap:10px;}
.btn{background:var(--coral);color:var(--white);padding:10px 18px;border-radius:999px;border:none;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;text-decoration:none;display:inline-block;}
.btn:hover{background:var(--coral-dark);}
.btn-outline{background:transparent;color:var(--coral);border:2px solid var(--coral);}
.btn-outline:hover{background:var(--coral);color:var(--white);}
.btn-small{padding:6px 12px;font-size:12px;border-radius:8px;}
.btn-delete{background:#c62828;}
.btn-delete:hover{background:#a31818;}
.btn-edit{background:#2d7d32;}
.btn-edit:hover{background:#1b5e20;}
.btn-ship{background:#1565c0;color:#fff;}
.btn-ship:hover{background:#0d47a1;}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;white-space:nowrap;}
.badge-pending{background:#FFF3E0;color:#E65100;}
.badge-preparing{background:#E3F2FD;color:#1565C0;}
.badge-shipped{background:#E8F5E9;color:#2E7D32;}
.badge-delivered{background:#E8F5E9;color:#1B5E20;}
.badge-cancelled{background:#FFEBEE;color:#C62828;}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:16px;}
.filter-btn{background:transparent;color:var(--gray);padding:5px 14px;border-radius:999px;border:1.5px solid #e0e0e0;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;}
.filter-btn:hover{border-color:var(--coral);color:var(--coral);}
.filter-active{background:var(--coral);color:var(--white);border-color:var(--coral);}
.filter-active:hover{background:var(--coral-dark);color:var(--white);}
tr.hidden-row{display:none;}
.stats{display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap;}
.stat{background:var(--white);padding:16px 24px;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.06);text-align:center;min-width:110px;}
.stat-num{font-size:28px;font-weight:700;color:var(--coral);}
.stat-label{font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:0.6px;margin-top:4px;}
.table-wrap{background:var(--white);border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th{background:var(--coral);color:var(--white);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;padding:12px 10px;text-align:left;position:sticky;top:0;}
td{padding:10px;border-bottom:1px solid #f0f0f0;vertical-align:top;}
tr:hover{background:var(--light);}
tr.editing td{background:#fff9c4;}
.actions{white-space:nowrap;}
.row-check{width:16px;height:16px;cursor:pointer;accent-color:var(--coral);}
.empty{padding:60px;text-align:center;color:var(--gray);font-size:16px;}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);align-items:center;justify-content:center;z-index:100;}
.modal.show{display:flex;}
.modal-box{background:var(--white);padding:28px;border-radius:20px;max-width:420px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.15);}
.modal-box h3{margin:0 0 16px;color:var(--coral);font-size:22px;}
.modal-box label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px;color:var(--gray);}
.modal-box input{width:100%;padding:10px 14px;border:2px solid var(--coral);border-radius:12px;font-family:inherit;font-size:14px;outline:none;}
.modal-box input:focus{box-shadow:0 0 0 3px rgba(242,120,109,0.2);}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px;}
@media(max-width:900px){body{padding:12px;} th,td{padding:8px 6px;font-size:12px;} .actions{display:flex;flex-direction:column;gap:4px;}}
</style></head><body>
<div class="header">
  <img src="data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgNDEyLjYgNDEyLjYiIHZlcnNpb249IjEuMSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiBpZD0iTGF5ZXJfMSI+CiAgCiAgPGRlZnM+CiAgICA8c3R5bGU+CiAgICAgIC5zdDAgewogICAgICAgIGZpbGw6ICNmNDViNWI7CiAgICAgIH0KCiAgICAgIC5zdDEgewogICAgICAgIGZpbGw6ICNmZmY7CiAgICAgIH0KCiAgICAgIC5zdDIgewogICAgICAgIGZpbGw6ICNmY2U1NWQ7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxjaXJjbGUgcj0iMjA2LjMiIGN5PSIyMDYuMyIgY3g9IjIwNi4zIiBjbGFzcz0ic3QyIj48L2NpcmNsZT4KICA8Zz4KICAgIDxnPgogICAgICA8cGF0aCBkPSJNMzMxLjcsMTM0LjZjLTUuMi0xNC4xLTE2LjYtMjUuNi0zMC45LTMyLjItMzQuOC0xNi4yLTY2LjYuNS04OC42LDc3LjctLjQsMS41LTEuNSwzLjYtMi4xLDQuOS0xLjksMy45LTkuMiwzLjgtMTEuNywwLS44LTEuMi0xLjctMy40LTIuMS00LjktMjItNzcuMi01My44LTkzLjktODguNi03Ny43LTE0LjIsNi42LTI1LjYsMTguMS0zMC45LDMyLjItNi4xLDE2LjMtNS4zLDM0LjQtMi4yLDUxLjMsNi44LDM2LjcsMjQuNiw3MC43LDUwLjIsOTksMTkuMSwyMSw0MC42LDQzLjcsNjYuOCw1OC40LDkuNCw0LjksMTUuMiw2LjIsMjUuMywwLDI2LjItMTQuNyw0Ny43LTM3LjMsNjYuOC01OC40LDI1LjYtMjguMyw0My41LTYyLjMsNTAuMi05OSwzLjEtMTYuOSwzLjktMzQuOS0yLjItNTEuM1oiIGNsYXNzPSJzdDAiPjwvcGF0aD4KICAgICAgPGc+CiAgICAgICAgPHJlY3QgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTIzLjUgLTQ2LjIpIHJvdGF0ZSgzMy43KSIgcnk9IjYuNiIgcng9IjYuNiIgaGVpZ2h0PSI1NC4xIiB3aWR0aD0iNTQuMSIgeT0iMTUzLjciIHg9IjExMSIgY2xhc3M9InN0MiI+PC9yZWN0PgogICAgICAgIDxwYXRoIGQ9Ik0xMTMsMTgxLjhjMTMuOS04LjksMzAuNy0xMi4zLDQ3LTkuOCwyLjguNCw0LjYuNyw0LjQuNWwtMzAuMy0yMC4yYy0xLjItLjgtMi45LS41LTMuNy43bC0yMC4yLDMwLjNjLS4xLjIuOS0uNSwyLjctMS42WiIgY2xhc3M9InN0MSI+PC9wYXRoPgogICAgICA8L2c+CiAgICA8L2c+CiAgICA8cGF0aCBkPSJNMTQ5LjEsMjI5LjJjLS4zLTEuNC0xLjEtMi43LTEuNC00LjItLjctMi44LS4yLTUuOC40LTguNi42LTIuNSwxLjgtNS40LDEuNS04LS40LTIuOC0zLjItMy45LTUuNy0zLjQtMi42LjUtNC43LDIuNC01LjgsNC44LS4xLjMtLjEuNiwwLC44LS4yLjMtLjMuNS0uMy44LDAsLjQsMCwuOC4zLDEuMiwyLDIuMSwzLjgsNC4xLDMuOSw3LjEuMSwzLjEtLjQsNi4xLTEuMyw5LjEtLjcsMi40LTEuNCw1LjEuMSw3LjQsMS4yLDEuOSwzLjUsMi44LDUuNiwxLjcsMS44LTEsMi41LTMuMiwyLjgtNS4xLjEtMS4yLjEtMi41LS4xLTMuN1oiIGNsYXNzPSJzdDIiPjwvcGF0aD4KICA8L2c+CiAgPHBhdGggZD0iTTM4Ny41LDc3LjFjLTIuMiwwLTQuMS0uNC01LjktMS4xcy0zLjMtMS44LTQuNi0zLjFjLTEuMy0xLjMtMi4yLTIuOS0yLjktNC43LS43LTEuOC0xLTMuOC0xLTUuOXMuNi01LjMsMS44LTcuNWMxLjItMi4xLDIuOS0zLjgsNS4xLTUsMi4yLTEuMiw0LjctMS44LDcuNi0xLjhzNCwuMyw1LjgsMWMxLjguNywzLjMsMS43LDQuNiwyLjksMS4zLDEuMywyLjMsMi44LDMsNC41LjcsMS43LDEuMSwzLjcsMS4xLDUuOHMtLjQsNC4yLTEuMSw2Yy0uNywxLjgtMS44LDMuNC0zLjEsNC43LTEuMywxLjMtMi45LDIuMy00LjYsMy4xLTEuOC43LTMuNywxLjEtNS43LDEuMVpNMzg3LjYsNzMuNmMxLjYsMCwzLjEtLjMsNC40LS45czIuNC0xLjQsMy40LTIuNCwxLjctMi4yLDIuMi0zLjZjLjUtMS40LjctMi45LjctNC41cy0uNC00LTEuMy01LjZjLS45LTEuNi0yLjEtMi45LTMuNy0zLjgtMS42LS45LTMuNS0xLjQtNS42LTEuNHMtNC4xLjUtNS43LDEuNC0yLjgsMi4yLTMuNiwzLjhjLS44LDEuNi0xLjMsMy41LTEuMyw1LjZzLjIsMy4xLjcsNC40Yy41LDEuNCwxLjIsMi42LDIuMSwzLjYuOSwxLDIsMS45LDMuMywyLjRzMi44LjksNC41LjlaTTM4NC4zLDY5LjhjLS42LDAtMS0uMS0xLjMtLjQtLjMtLjItLjUtLjctLjYtMS4zLDAtMS0uMi0yLS4yLTMsMC0xLDAtMS45LDAtMi44czAtMS43LDAtMi43YzAtLjkuMS0xLjguMi0yLjYsMC0uNS4zLS45LjYtMS4yLjMtLjMuNy0uNSwxLjQtLjYuNi0uMSwxLjUtLjIsMi43LS4yLDIuMiwwLDMuOC40LDQuNiwxczEuMywxLjcsMS4zLDMtLjIsMS41LS41LDJjLS4zLjUtLjcsMS0xLjIsMS4zLDAsMC0uMS4xLS4yLjIsMCwwLDAsLjEsMCwuMnMwLC4yLDAsLjNjMCwwLDAsLjIuMi4yLjIuMy40LjYuNywxcy41LjguOCwxLjJjLjMuNC41LjkuNywxLjMuMi40LjMuOC4zLDEsMCwuNS0uMS44LS40LDEuMi0uMi4zLS43LjUtMS4yLjVzLS45LS4yLTEuMi0uNWMtLjMtLjMtLjctLjgtMS0xLjMtLjUtLjgtLjgtMS40LTEuMS0xLjktLjMtLjUtLjUtLjktLjctMS4yLS4yLS40LS40LS42LS42LS43LS4yLDAtLjUtLjEtLjgtLjFzLS42LDAtLjguMmMtLjIuMS0uMi4zLS4yLjUsMCwuNCwwLC44LDAsMS4xLDAsLjMsMCwuNywwLDEuMXMwLC45LDAsMS41LS4xLjctLjQsMWMtLjIuMy0uNi41LTEuMi41Wk0zODcsNjEuM2MxLDAsMS43LS4yLDIuMS0uNS40LS4zLjYtLjcuNi0xLjEsMC0uNi0uMi0xLS42LTEuMy0uNC0uMi0xLjEtLjQtMi0uNHMtLjgsMC0xLDBjLS4yLDAtLjMuMi0uNC4zLDAsLjIsMCwuNSwwLC45LDAsLjYsMCwxLjEsMCwxLjQsMCwuMy4yLjUuNC42LjIsMCwuNS4xLDEsLjFaIiBjbGFzcz0ic3QwIj48L3BhdGg+Cjwvc3ZnPg==" alt="Evergreen">
  <div><h1>Evergreen Submissions</h1><p>Admin Dashboard</p></div>
</div>
<div class="stats">
  <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total</div></div>
  <div class="stat"><div class="stat-num">${today}</div><div class="stat-label">Today</div></div>
  <div class="stat"><div class="stat-num" style="color:#F2786D">${statusCounts.pending}</div><div class="stat-label">Pending</div></div>
  <div class="stat"><div class="stat-num" style="color:#2d7d32">${statusCounts.shipped + statusCounts.delivered}</div><div class="stat-label">Fulfilled</div></div>
  <div class="stat"><div class="stat-num">${errorCount}</div><div class="stat-label">Errors</div></div>
  <div class="stat"><div class="stat-num">${((Date.now()-startTime)/1000/60).toFixed(0)}</div><div class="stat-label">Uptime (min)</div></div>
</div>
<div class="toolbar">
  <div class="toolbar-left">
    <button class="btn btn-outline" onclick="toggleAll()">Select All</button>
    <select id="bulk-status" class="btn btn-outline" style="padding:8px 12px">
      <option value="">Bulk Status...</option>
      <option value="pending">Pending</option>
      <option value="preparing">Preparing</option>
      <option value="shipped">Shipped</option>
      <option value="delivered">Delivered</option>
      <option value="cancelled">Cancelled</option>
    </select>
    <button class="btn btn-outline" onclick="bulkStatus()">Apply</button>
    <button class="btn btn-delete" onclick="bulkDelete()">Delete Selected</button>
  </div>
  <div class="toolbar-right">
    <a class="btn" id="csv-link" href="/export" onclick="return updateCsvLink(event)">Download CSV</a>
    <a class="btn btn-outline" href="/">View Form</a>
  </div>
</div>
<div class="filters">
  <span style="font-size:12px;color:#888;margin-right:8px;font-weight:600">Filter:</span>
  <button class="filter-btn filter-active" onclick="filterStatus('all', event)">All</button>
  <button class="filter-btn" onclick="filterStatus('pending', event)">Pending</button>
  <button class="filter-btn" onclick="filterStatus('preparing', event)">Preparing</button>
  <button class="filter-btn" onclick="filterStatus('shipped', event)">Shipped</button>
  <button class="filter-btn" onclick="filterStatus('delivered', event)">Delivered</button>
  <button class="filter-btn" onclick="filterStatus('cancelled', event)">Cancelled</button>
  <span style="margin:0 8px;color:#ddd">|</span>
  <button class="filter-btn" onclick="filterWindow('Tue 9-11', event)">Tue 9-11</button>
  <button class="filter-btn" onclick="filterWindow('Tue 4-6', event)">Tue 4-6</button>
  <button class="filter-btn" onclick="filterWindow('Thu 9-11', event)">Thu 9-11</button>
  <button class="filter-btn" onclick="filterWindow('Thu 4-6', event)">Thu 4-6</button>
  <span style="margin:0 8px;color:#ddd">|</span>
  <input id="search-input" type="search" placeholder="Search (name, email, address, delivery instructions…)" style="padding:6px 12px;border:1.5px solid #e0e0e0;border-radius:999px;font-family:inherit;font-size:12px;font-weight:600;color:var(--text);min-width:280px;outline:none;transition:border-color .15s;" oninput="applySearch()" onkeydown="if(event.key==='Escape'){this.value='';applySearch();}">
  <button class="filter-btn" id="search-clear" onclick="clearSearch()" style="display:none">×</button>
  <span id="search-count" style="margin-left:8px;font-size:12px;color:#888;font-weight:600"></span>
</div>
<div class="table-wrap">
  <table>
    <thead><tr>
      <th style="width:30px"><input type="checkbox" id="check-all" onclick="toggleAll()"></th>
      <th>ID</th><th>Name</th><th>Email</th><th>Phone</th><th>Address</th><th>City</th>
      <th>Region</th><th>Zip</th><th>Country</th><th>Window</th><th>Delivery Inst.</th><th>Instagram</th><th>Status</th><th>Opt-in</th><th>Date</th><th>Actions</th>
    </tr></thead>
    <tbody>${rows.length===0?`<tr><td colspan="17" class="empty">No submissions yet.</td></tr>`:tableRows}</tbody>
  </table>
</div>
<div class="modal" id="edit-modal"><div class="modal-box">
  <h3>Edit Submission #<span id="edit-id-display"></span></h3>
  <input type="hidden" id="edit-id">
  <label>First Name</label><input id="edit-first">
  <label>Last Name</label><input id="edit-last">
  <label>Email</label><input id="edit-email">
  <label>Phone</label><input id="edit-phone">
  <label>Address</label><input id="edit-addr">
  <label>City</label><input id="edit-city">
  <label>Region</label><input id="edit-region">
  <label>Zip</label><input id="edit-zip">
  <label>Country</label><input id="edit-country">
  <label>Window</label><input id="edit-window">
  <label>Delivery Instructions</label>
  <textarea id="edit-dinst" style="width:100%;padding:10px 14px;border:2px solid var(--coral);border-radius:12px;font-family:inherit;font-size:14px;outline:none;resize:vertical;min-height:60px" placeholder="Gate code, leave at door, etc."></textarea>
  <label>Instagram Handle</label><input id="edit-instagram" placeholder="@yourhandle">
  <label>Marketing Opt-in</label><input id="edit-optin" placeholder="yes or no">
  <label>Status</label>
  <select id="edit-status" style="width:100%;padding:10px 14px;border:2px solid var(--coral);border-radius:12px;font-family:inherit;font-size:14px;outline:none">
    <option value="pending">Pending</option>
    <option value="preparing">Preparing</option>
    <option value="shipped">Shipped</option>
    <option value="delivered">Delivered</option>
    <option value="cancelled">Cancelled</option>
  </select>
  <label>Internal Notes</label>
  <textarea id="edit-notes" style="width:100%;padding:10px 14px;border:2px solid var(--coral);border-radius:12px;font-family:inherit;font-size:14px;outline:none;resize:vertical;min-height:60px" placeholder="Instacart order #, delivery notes..."></textarea>
  <div class="modal-actions">
    <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    <button class="btn" onclick="saveEdit()">Save</button>
  </div>
</div></div>
<script>
const $=id=>document.getElementById(id);
function toggleAll(){
  const all=$('check-all').checked;
  document.querySelectorAll('.row-check').forEach(c=>c.checked=all);
}
async function deleteRow(id){
  if(!confirm('Delete submission #'+id+'?'))return;
  const r=await fetch('/admin/delete/'+id,{method:'DELETE'});
  const j=await r.json();
  if(j.success)document.querySelector('tr[data-id="'+id+'"]').remove();
  else alert(j.message||'Delete failed');
}
async function shipRow(id){
  if(!confirm('Mark #'+id+' as shipped?'))return;
  fetch('/admin/status/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'shipped'})})
    .then(r=>r.json()).then(j=>{if(j.success)location.reload();else alert(j.message||'Update failed')})
    .catch(()=>alert('Network error'));
}
async function bulkDelete(){
  const ids=Array.from(document.querySelectorAll('.row-check:checked')).map(c=>parseInt(c.value));
  if(!ids.length){alert('No rows selected');return;}
  if(!confirm('Delete '+ids.length+' submissions?'))return;
  const r=await fetch('/admin/bulk-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
  const j=await r.json();
  if(j.success)ids.forEach(id=>{const tr=document.querySelector('tr[data-id="'+id+'"]');if(tr)tr.remove();});
  else alert(j.message||'Bulk delete failed');
}
async function bulkStatus(){
  const sel=$('bulk-status');const status=sel.value;
  if(!status){alert('Select a status');return;}
  const ids=Array.from(document.querySelectorAll('.row-check:checked')).map(c=>parseInt(c.value));
  if(!ids.length){alert('No rows selected');return;}
  if(!confirm('Set '+ids.length+' submissions to '+status+'?'))return;
  fetch('/admin/bulk-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,status})})
    .then(r=>r.json()).then(j=>{if(j.success)location.reload();else alert(j.message||'Bulk status failed')})
    .catch(()=>alert('Network error'));
}
function filterStatus(s, evt){
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('filter-active'));
  if(evt?.target) evt.target.classList.add('filter-active');
  activeStatus = s;
  applySearch();
}
function filterWindow(w, evt){
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('filter-active'));
  evt.target.classList.add('filter-active');
  activeWindow = w;
  applySearch();
}
let activeStatus = 'all';
let activeWindow = '';
function applySearch(){
  const q=($('search-input')?.value || '').trim().toLowerCase();
  const clr=$('search-clear'); if(clr) clr.style.display = q ? 'inline-block' : 'none';
  // Multi-term AND search: split on whitespace, every term must match somewhere
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const winLabel = activeWindow; // e.g. "Tue 9-11"
  let visible = 0, total = 0;
  document.querySelectorAll('tr[data-id]').forEach(r=>{
    total++;
    const hay = r.dataset.search || '';
    const status = r.dataset.status || '';
    const winCell = r.querySelector('.td-window')?.textContent || '';
    const matchesText = terms.every(t => hay.includes(t));
    const matchesStatus = activeStatus === 'all' || status === activeStatus;
    const matchesWindow = !activeWindow || winCell.includes(winLabel);
    if (matchesText && matchesStatus && matchesWindow) {
      r.classList.remove('hidden-row');
      visible++;
    } else {
      r.classList.add('hidden-row');
    }
  });
  const cnt=$('search-count');
  if(cnt){
    if(q) cnt.textContent = visible + ' of ' + total;
    else cnt.textContent = '';
  }
  // Persist + update CSV link + highlight
  try { localStorage.setItem('evergreen-search-q', $('search-input')?.value || ''); } catch(e){}
  const link = $('csv-link'); if(link){ link.href = q ? '/export?q=' + encodeURIComponent($('search-input').value) : '/export'; }
  highlightMatches();
}
function clearSearch(){
  $('search-input').value = '';
  localStorage.removeItem('evergreen-search-q');
  applySearch();
}
function loadSearchFromStorage(){
  try {
    const saved = localStorage.getItem('evergreen-search-q') || '';
    if(saved){ $('search-input').value = saved; }
  } catch(e) { /* localStorage unavailable */ }
}
function updateCsvLink(e){
  // Append ?q=... so the server filters and names the file accordingly
  const q = ($('search-input')?.value || '').trim();
  const link = $('csv-link');
  link.href = q ? '/export?q=' + encodeURIComponent(q) : '/export';
  return true; // allow default click
}
function highlightMatches(){
  const q = ($('search-input')?.value || '').trim();
  // Remove existing highlights first
  document.querySelectorAll('mark.evergreen-hl').forEach(m => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  if(!q) return;
  const terms = q.split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^$()|[\]\\]/g, '\\$&'));
  if(!terms.length) return;
  const re = new RegExp('(' + terms.join('|') + ')', 'gi');
  // Only highlight text-bearing td cells (skip id, checkbox, status, date, actions)
  const cells = document.querySelectorAll('tr[data-id]:not(.hidden-row) td');
  cells.forEach(td => {
    if(td.querySelector('input,button,select')) return;
    // Skip cells that have child structure (status badge span)
    if(td.children.length > 0 && !/^td-(name|email|phone|addr|city|region|zip|country|window|optin|dinst)$/.test(td.className) && td.children.length > 0 && td.firstElementChild?.tagName === 'SPAN') return;
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while((node = walker.nextNode())){
      if(node.nodeValue && node.nodeValue.trim()) targets.push(node);
    }
    targets.forEach(textNode => {
      const html = textNode.nodeValue.replace(re, '<mark class="evergreen-hl" style="background:#fff3a0;color:inherit;padding:0 2px;border-radius:3px;">$1</mark>');
      if(html !== textNode.nodeValue){
        const span = document.createElement('span');
        span.innerHTML = html;
        textNode.parentNode.replaceChild(span, textNode);
      }
    });
  });
}
function editRow(id){
  const tr=document.querySelector('tr[data-id="'+id+'"]');if(!tr)return;
  $('edit-id').value=id;$('edit-id-display').textContent=id;
  $('edit-first').value=tr.querySelector('.td-name').textContent.split(' ')[0]||'';
  $('edit-last').value=tr.querySelector('.td-name').textContent.split(' ').slice(1).join(' ')||'';
  $('edit-email').value=tr.querySelector('.td-email').textContent;
  $('edit-phone').value=tr.querySelector('.td-phone').textContent;
  $('edit-addr').value=tr.querySelector('.td-addr').textContent;
  $('edit-city').value=tr.querySelector('.td-city').textContent;
  $('edit-region').value=tr.querySelector('.td-region').textContent;
  $('edit-zip').value=tr.querySelector('.td-zip').textContent;
  $('edit-country').value=tr.querySelector('.td-country').textContent;
  $('edit-window').value=tr.querySelector('.td-window').textContent;
  $('edit-dinst').value=tr.dataset.dinst||'';
  $('edit-instagram').value=tr.dataset.instagram||'';
  $('edit-optin').value=tr.querySelector('.td-optin').textContent;
  const st=tr.dataset.status||'pending';
  $('edit-status').value=st;
  $('edit-notes').value=tr.dataset.notes||'';
  $('edit-modal').classList.add('show');
}
function closeModal(){$('edit-modal').classList.remove('show');}
async function saveEdit(){
  const id=$('edit-id').value;
  const body={
    first_name:$('edit-first').value,
    last_name:$('edit-last').value,
    email:$('edit-email').value,
    phone:$('edit-phone').value,
    address1:$('edit-addr').value,
    city:$('edit-city').value,
    region:$('edit-region').value,
    zip:$('edit-zip').value,
    country:$('edit-country').value,
    window:$('edit-window').value,
    delivery_instructions:$('edit-dinst').value,
    instagram_handle:$('edit-instagram').value,
    marketing_optin:$('edit-optin').value.toLowerCase()==='yes'?1:0,
  };
  const r=await fetch('/admin/edit/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(()=>null);
  if(!r){alert('Network error');return;}
  const j=await r.json();
  if(!j.success){alert(j.message||'Update failed');return;}
  const newStatus=$('edit-status').value;
  const newNotes=$('edit-notes').value;
  // Always send status (dropdown always has a value)
  await fetch('/admin/status/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:newStatus})});
  // Always send notes (server handles empty string = clear)
  await fetch('/admin/notes/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:newNotes})});
  location.reload();
}
// Init: restore search from localStorage, apply filter + highlight
loadSearchFromStorage();
applySearch();
</script>
</body></html>`;
});

// -- Admin delete submission --
app.delete("/admin/delete/:id", ({ headers, params, set }) => {
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return { success: false, message: "Unauthorized" };
  }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    set.status = 400;
    return { success: false, message: "Invalid ID" };
  }
  const result = deleteById.run(id);
  info("Submission deleted", { id, changes: result.changes });
  return { success: true, deleted: result.changes };
});

// -- Admin edit submission --
app.put("/admin/edit/:id", async ({ headers, params, body, set }) => {
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return { success: false, message: "Unauthorized" };
  }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    set.status = 400;
    return { success: false, message: "Invalid ID" };
  }
  const b = body as Record<string, any>;
  const email = sanitizeString(b.email)?.toLowerCase();
  if (email && !validateEmail(email)) {
    set.status = 400;
    return { success: false, message: "Invalid email." };
  }
  const result = updateById.run(
    sanitizeString(b.first_name),
    sanitizeString(b.last_name),
    email || "",
    sanitizeString(b.phone),
    sanitizeString(b.address1),
    sanitizeString(b.address2),
    sanitizeString(b.city),
    sanitizeString(b.region),
    sanitizeString(b.zip),
    sanitizeString(b.country),
    sanitizeString(b.window),
    sanitizeString(b.delivery_instructions),
    sanitizeString(b.instagram_handle),
    b.marketing_optin ? 1 : 0,
    id
  );
  info("Submission updated", { id, changes: result.changes });
  return { success: true, updated: result.changes };
});

// -- Admin bulk delete --
app.post("/admin/bulk-delete", async ({ headers, body, set }) => {
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return { success: false, message: "Unauthorized" };
  }
  const b = body as Record<string, any>;
  const ids = (b.ids || []).map((x: any) => parseInt(x, 10)).filter((x: number) => !isNaN(x));
  if (!ids.length) {
    set.status = 400;
    return { success: false, message: "No IDs provided" };
  }
  if (ids.length > 100) {
    set.status = 400;
    return { success: false, message: "Max 100 IDs per request." };
  }
  // Use raw SQL for dynamic IN clause since prepared statement has fixed param count
  const placeholders = ids.map(() => "?").join(",");
  const stmt = db.prepare(`DELETE FROM submissions WHERE id IN (${placeholders})`);
  const result = stmt.run(...ids);
  info("Bulk delete", { count: ids.length, deleted: result.changes });
  return { success: true, deleted: result.changes };
});

// -- Admin update status (single) --
app.put("/admin/status/:id", async ({ headers, params, body, set }) => {
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return { success: false, message: "Unauthorized" };
  }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { set.status = 400; return { success: false, message: "Invalid ID" }; }
  const b = body as Record<string, any>;
  const status = String(b.status || "").toLowerCase();
  if (!(STATUSES as readonly string[]).includes(status)) {
    set.status = 400;
    return { success: false, message: "Invalid status. Use: " + STATUSES.join(", ") };
  }
  const result = updateStatus.run(status, id);
  info("Status updated", { id, status, changes: result.changes });
  return { success: true, updated: result.changes };
});

// -- Admin bulk status update --
app.post("/admin/bulk-status", async ({ headers, body, set }) => {
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return { success: false, message: "Unauthorized" };
  }
  const b = body as Record<string, any>;
  const ids = (b.ids || []).map((x: any) => parseInt(x, 10)).filter((x: number) => !isNaN(x));
  const status = String(b.status || "").toLowerCase();
  if (!ids.length) { set.status = 400; return { success: false, message: "No IDs provided" }; }
  if (ids.length > 100) { set.status = 400; return { success: false, message: "Max 100 IDs per request." }; }
  if (!(STATUSES as readonly string[]).includes(status)) {
    set.status = 400;
    return { success: false, message: "Invalid status. Use: " + STATUSES.join(", ") };
  }
  const placeholders = ids.map(() => "?").join(",");
  const stmt = db.prepare(`UPDATE submissions SET status = ? WHERE id IN (${placeholders})`);
  const result = stmt.run(status, ...ids);
  info("Bulk status update", { count: ids.length, status, updated: result.changes });
  return { success: true, updated: result.changes };
});

// -- Admin update notes --
app.put("/admin/notes/:id", async ({ headers, params, body, set }) => {
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return { success: false, message: "Unauthorized" };
  }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { set.status = 400; return { success: false, message: "Invalid ID" }; }
  const b = body as Record<string, any>;
  const notes = String(b.notes || "").slice(0, 1000);
  const result = updateNotes.run(notes, id);
  info("Notes updated", { id, changes: result.changes });
  return { success: true, updated: result.changes };
});

// -- CSV export (Klaviyo format) --
app.get("/export", ({ headers, request, set }) => {
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return "Unauthorized";
  }
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const terms = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const allRows = (listAll.all() as any[]) || [];
  const rows = terms.length === 0
    ? allRows
    : allRows.filter((r: any) => {
        const hay = [
          r.id, r.first_name, r.last_name, r.email, r.phone,
          r.address1, r.address2, r.city, r.region, r.zip, r.country,
          r.window, r.delivery_instructions, r.instagram_handle, r.status, r.notes,
          r.marketing_optin ? "yes" : "no",
        ].map(v => String(v ?? "").toLowerCase()).join(" ");
        return terms.every((t: string) => hay.includes(t));
      });
  let csv = "Email,$first_name,$last_name,$phone_number,$address1,$address2,$city,$region,$zip,$country,Status,Notes,Delivery_Instructions,Instagram_Handle,Marketing_Opt_In,Submitted_At\n";
  for (const r of rows) {
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    csv += `${esc(r.email)},${esc(r.first_name)},${esc(r.last_name)},${esc(r.phone)},${esc(r.address1)},${esc(r.address2)},${esc(r.city)},${esc(r.region)},${esc(r.zip)},${esc(r.country)},${esc(r.status||'pending')},${esc(r.notes)},${esc(r.delivery_instructions)},${esc(r.instagram_handle)},${r.marketing_optin ? "Yes" : "No"},${esc(r.submitted_at)}\n`;
  }
  set.headers["Content-Type"] = "text/csv";
  // Sanitize search term for filename: keep alnum + dash, cap at 40 chars
  const slug = q
    ? q.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "search"
    : "";
  const fname = slug
    ? `evergreen-klaviyo-${slug}-${new Date().toISOString().slice(0, 10)}.csv`
    : `evergreen-klaviyo-${new Date().toISOString().slice(0, 10)}.csv`;
  set.headers["Content-Disposition"] = `attachment; filename="${fname}"`;
  return csv;
});

// ── Embed helper ──
app.get("/embed", ({ set }) => {
  set.headers["Content-Type"] = "text/html";
  return EMBED_PAGE;
});

// ── 404 catch-all ──
app.all("*", ({ set }) => {
  set.status = 404;
  return { success: false, message: "Not found" };
});

// ════════════════════════════════════════════
// LISTEN
// ════════════════════════════════════════════
app.listen(PORT);

info("Server started", {
  port: PORT,
  db: DB_PATH,
  emailAlerts: ENABLE_EMAIL_ALERTS,
  logLevel: LOG_LEVEL,
  cors: ENABLE_CORS,
});

// Startup alert
if (ENABLE_EMAIL_ALERTS) {
  sendAlert("Evergreen Form started", `Server is up.\nDB: ${DB_PATH}\nPort: ${PORT}`);
}

// ════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ════════════════════════════════════════════
async function gracefulShutdown(signal: string) {
  info("Shutting down", { signal });
  db.close(false); // close gracefully, let WAL commit
  info("Database closed");
  if (ENABLE_EMAIL_ALERTS) {
    await sendAlert("Evergreen Form stopped", `Signal: ${signal}`);
  }
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Unhandled rejections / uncaught exceptions
process.on("unhandledRejection", (reason: any) => {
  error("Unhandled rejection", { reason: String(reason) });
  sendAlert("Evergreen: Unhandled rejection", String(reason), true);
});
process.on("uncaughtException", (err: Error) => {
  error("Uncaught exception", { message: err.message, stack: err.stack });
  sendAlert("Evergreen: Uncaught exception", err.message, true);
  process.exit(1);
});
