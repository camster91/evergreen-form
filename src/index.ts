import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { Database } from "bun:sqlite";

// ════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const ADMIN_USER = process.env.ADMIN_USER || "evergreen";
const ADMIN_PASS = process.env.ADMIN_PASS || "team2026";
const DB_PATH = process.env.DB_PATH || "/data/submissions.db";

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

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
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

  // Indexes for common queries
  db.exec("CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions(email)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions(submitted_at DESC)");

  return {
    db,
    insert: db.prepare(`
      INSERT INTO submissions (first_name, last_name, email, phone, address1, address2, city, region, zip, country, notes, window, marketing_optin, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listAll: db.prepare(`SELECT * FROM submissions ORDER BY submitted_at DESC`),
    listRecent: db.prepare(`SELECT * FROM submissions ORDER BY submitted_at DESC LIMIT 500`),
    countAll: db.prepare(`SELECT COUNT(*) as count FROM submissions`),
    countToday: db.prepare(`SELECT COUNT(*) as count FROM submissions WHERE DATE(submitted_at) = DATE('now')`),
    countByIPToday: db.prepare(`SELECT COUNT(*) as count FROM submissions WHERE ip = ? AND DATE(submitted_at) = DATE('now')`),
  };
}

const sql = initDatabase();
const { db, insert, listAll, listRecent, countAll, countToday, countByIPToday } = sql;

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
function checkBasicAuth(headers: Record<string, string | undefined>): boolean {
  const auth = headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) return false;
  try {
    const creds = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const idx = creds.indexOf(":");
    if (idx === -1) return false;
    const u = creds.substring(0, idx);
    const p = creds.substring(idx + 1);
    return u === ADMIN_USER && p === ADMIN_PASS;
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
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors https://*.myshopify.com https://evergreen-form.ashbi.ca *;";
  outHeaders["X-Content-Type-Options"] = "nosniff";
  outHeaders["X-Frame-Options"] = "SAMEORIGIN";
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
  min-height: 100vh;
  padding: 40px 16px;
  -webkit-font-smoothing: antialiased;
}
.card {
  max-width: 560px;
  margin: 0 auto;
  background: #FFFFFF;
  padding: 32px 28px;
}
.input-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 14px;
}
.input-grid input, .full input {
  width: 100%;
  padding: 14px 18px;
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
.input-grid input::placeholder, .full input::placeholder {
  color: #EDA8A8;
  font-weight: 600;
}
.input-grid input:focus, .full input:focus {
  border-color: #F06464;
  box-shadow: 0 0 0 4px rgba(240,100,100,0.15);
}
.full { margin-bottom: 14px; }
.section-label {
  text-align: center;
  font-size: 22px;
  font-weight: 700;
  color: #F06464;
  margin: 24px 0 4px;
}
.section-hint {
  text-align: center;
  font-size: 13px;
  color: #F06464;
  font-weight: 400;
  margin-bottom: 16px;
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
  font-size: 13px;
  color: #F06464;
  font-weight: 400;
  margin-bottom: 16px;
}
.disclaimer a {
  color: #F2786D;
  text-decoration: underline;
}
.opt-in {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  color: #F06464;
  font-weight: 400;
  margin-bottom: 16px;
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
  padding: 18px 24px;
  border: none;
  border-radius: 999px;
  font-family: 'Fredoka', sans-serif;
  font-size: 20px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: #fff;
  cursor: pointer;
  background: linear-gradient(180deg, #F87D7D 0%, #F4525C 100%);
  box-shadow: 0 8px 0 #C53838;
  transition: transform 0.08s, box-shadow 0.08s;
}
.submit-btn:hover {
  transform: translateY(2px);
  box-shadow: 0 6px 0 #C53838;
}
.submit-btn:active {
  transform: translateY(6px);
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

@media (max-width: 480px) {
  body { padding: 20px 12px; }
  .card { padding: 24px 14px; }
  .input-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="card">
<form id="fsf-form" method="post" action="/submit">
  <div class="input-grid">
    <input type="text" name="first_name" placeholder="first name" required maxlength="80">
    <input type="text" name="last_name" placeholder="last name" required maxlength="80">
    <input type="text" name="address1" placeholder="street" required maxlength="256">
    <input type="text" name="address2" placeholder="apartment / unit #" maxlength="128">
    <input type="text" name="region" placeholder="state" required maxlength="64">
    <input type="text" name="zip" placeholder="zip code" required maxlength="20">
  </div>
  <div class="section-label">Preferred Delivery Window</div>
  <div class="section-hint">please select only one</div>
  <div class="delivery-row">
    <label><input type="radio" name="window" value="tue-am" required><span>Tuesday 9-11am CT</span></label>
    <label><input type="radio" name="window" value="tue-pm"><span>Tuesday 4-6pm CT</span></label>
    <label><input type="radio" name="window" value="thu-am"><span>Thursday 9-11am CT</span></label>
    <label><input type="radio" name="window" value="thu-pm"><span>Thursday 4-6pm CT</span></label>
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
</form>
</div>
<script>
(function() {
  var form = document.getElementById('fsf-form');
  var msg = document.getElementById('fsf-message');
  var btn = form.querySelector('button[type="submit"]');
  var originalText = btn.textContent;
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    msg.style.display = 'none'; msg.className = 'fsf-message';
    btn.disabled = true; btn.textContent = 'Submitting...';
    var data = new FormData(form);
    fetch('/submit', { method: 'POST', body: data })
    .then(function(r) { return r.json(); })
    .then(function(json) {
      msg.style.display = 'block';
      if (json.success) { msg.textContent = json.message; msg.className = 'fsf-message success'; form.reset(); }
      else { msg.textContent = json.message || 'Something went wrong.'; msg.className = 'fsf-message error'; }
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
    height="700"
    style="border:none;overflow:hidden;"
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
  app.use(cors({ origin: ["https://*.myshopify.com", "https://evergreen-form.ashbi.ca", "https://ashbi.ca"], credentials: false }));
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
      version: "1.1.1",
    };
  } catch (e: any) {
    error("Health check failed", { error: e.message });
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

  const data = body as Record<string, any>;

  // Sanitize + trim
  const first_name = sanitizeString(data.first_name);
  const last_name = sanitizeString(data.last_name);
  const email = sanitizeString(data.email)?.toLowerCase();
  const address1 = sanitizeString(data.address1);
  const address2 = sanitizeString(data.address2);
  const region = sanitizeString(data.region);
  const zip = sanitizeString(data.zip);
  const windowVal = sanitizeString(data.window);
  const marketing_optin = data.marketing_optin === "1" ? 1 : 0;

  // Validation
  const required = { first_name, last_name, email, address1, region, zip };
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
    result = insert.run(first_name, last_name, email, null, address1, address2, null, region, zip, null, null, windowVal, marketing_optin, ip);
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
      first_name, last_name, email, phone: "", address1, city: "", region, zip, country: "", address2, notes: windowVal ? `Window: ${windowVal}` : "", marketing_optin: marketing_optin === 1, ip, id,
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

  let tableRows = "";
  for (const r of rows) {
    tableRows += `<tr>
      <td>${r.id}</td>
      <td>${escapeHtml(String(r.first_name || ""))} ${escapeHtml(String(r.last_name || ""))}</td>
      <td>${escapeHtml(String(r.email || ""))}</td>
      <td>${escapeHtml(String(r.phone || ""))}</td>
      <td>${escapeHtml(String(r.address1 || "") + (r.address2 ? ", " + String(r.address2) : ""))}</td>
      <td>${escapeHtml(String(r.city || ""))}</td>
      <td>${escapeHtml(String(r.region || ""))}</td>
      <td>${escapeHtml(String(r.zip || ""))}</td>
      <td>${escapeHtml(String(r.country || ""))}</td>
      <td>${r.marketing_optin ? "✅" : "—"}</td>
      <td>${formatDate(r.submitted_at)}</td>
    </tr>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Evergreen Submissions</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:40px;background:#f7f7f7;color:#1a1a1a;}
h1{margin:0 0 8px;font-size:28px;font-weight:700;}
.stats{display:flex;gap:20px;margin:20px 0;flex-wrap:wrap;}
.stat{background:#fff;padding:20px 28px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.08);text-align:center;}
.stat-num{font-size:32px;font-weight:700;color:#2d2d2d;}
.stat-label{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.6px;}
.btn{background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;margin:4px 4px 4px 0;border:none;cursor:pointer;}
.btn:hover{background:#ff6b35;}
table{width:100%;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.08);border-collapse:collapse;margin-top:20px;overflow:hidden;}
th,td{padding:12px 14px;text-align:left;font-size:13px;}
th{background:#1a1a1a;color:#fff;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;}
tr:nth-child(even){background:#fafafa;}
tr:hover{background:#f0f0f0;}
.empty{padding:40px;text-align:center;color:#888;font-size:15px;}
@media (max-width:640px){ body{margin:16px;} .stats{flex-direction:column;} }
</style></head><body>
<h1>Evergreen Submissions</h1>
<div class="stats">
  <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total</div></div>
  <div class="stat"><div class="stat-num">${today}</div><div class="stat-label">Today</div></div>
  <div class="stat"><div class="stat-num">${errorCount}</div><div class="stat-label">Errors</div></div>
  <div class="stat"><div class="stat-num">${((Date.now() - startTime) / 1000 / 60).toFixed(0)}</div><div class="stat-label">Uptime (min)</div></div>
</div>
<a class="btn" href="/export">Download CSV</a>
<a class="btn" href="/">View Form</a>
${rows.length === 0 ? '<div class="empty">No submissions yet.</div>' : `
<table><thead><tr>
  <th>ID</th><th>Name</th><th>Email</th><th>Phone</th><th>Address</th><th>City</th>
  <th>Region</th><th>Zip</th><th>Country</th><th>Opt-in</th><th>Date</th>
</tr></thead><tbody>${tableRows}</tbody></table>`}
</body></html>`;
});

// ── CSV export (Klaviyo format) ──
app.get("/export", ({ headers, set }) => {
  setSecurityHeaders(set.headers as Record<string, string>);
  if (!checkBasicAuth(headers as Record<string, string | undefined>)) {
    set.status = 401;
    set.headers["WWW-Authenticate"] = 'Basic realm="Evergreen Admin"';
    return "Unauthorized";
  }
  const rows = (listAll.all() as any[]) || [];
  let csv = "Email,$first_name,$last_name,$phone_number,$address1,$address2,$city,$region,$zip,$country,Notes,Marketing_Opt_In,Submitted_At\n";
  for (const r of rows) {
    const esc = (v: string) => `"${(v || "").replace(/"/g, '""')}"`;
    csv += `${esc(r.email)},${esc(r.first_name)},${esc(r.last_name)},${esc(r.phone)},${esc(r.address1)},${esc(r.address2)},${esc(r.city)},${esc(r.region)},${esc(r.zip)},${esc(r.country)},${esc(r.notes)},${r.marketing_optin ? "Yes" : "No"},${esc(r.submitted_at)}\n`;
  }
  set.headers["Content-Type"] = "text/csv";
  set.headers["Content-Disposition"] = `attachment; filename="evergreen-klaviyo-${new Date().toISOString().slice(0, 10)}.csv"`;
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
