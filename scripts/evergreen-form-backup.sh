#!/usr/bin/env bash
# evergreen-form-backup.sh
# Hot backup of SQLite DB + log to Google Drive, with Telegram alerts.
# Run daily via cron. Idempotent. Safe to re-run.

set -euo pipefail

# ── Config (env-overridable) ──────────────────────────────────────────────
SRC_DB="${SRC_DB:-/data/submissions.db}"
SRC_LOG="${SRC_LOG:-/data/app.log}"
STAGE_DIR="${STAGE_DIR:-/tmp/evergreen-form-backup}"
LOCAL_KEEP_DAYS="${LOCAL_KEEP_DAYS:-7}"
DRIVE_KEEP_COUNT="${DRIVE_KEEP_COUNT:-30}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive-evergreen:Evergreen-Form-Backups}"
SA_KEY_FILE="${SA_KEY_FILE:-/root/.evergreen-form/gdrive-sa.json}"

TG_BOT_TOKEN="${TG_BOT_TOKEN:-}"
TG_CHAT_ID="${TG_CHAT_ID:-}"
HOSTNAME_SHORT="$(hostname -s)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="evergreen-form_${HOSTNAME_SHORT}_${TS}"
ARCHIVE_PATH="/tmp/${BASENAME}.tar.gz"

# ── Telegram helper ──────────────────────────────────────────────────────
tg() {
  local msg="$1"
  if [[ -z "${TG_BOT_TOKEN}" || -z "${TG_CHAT_ID}" ]]; then
    echo "[tg-skip] ${msg}" >&2
    return 0
  fi
  curl -sS --max-time 10 -X POST \
    "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TG_CHAT_ID}" \
    -d "parse_mode=Markdown" \
    -d "disable_web_page_preview=true" \
    --data-urlencode "text=${msg}" >/dev/null || \
    echo "[tg-fail] ${msg}" >&2
}

# ── Pre-flight ───────────────────────────────────────────────────────────
if [[ ! -r "${SRC_DB}" ]]; then
  tg "❌ *evergreen-form backup FAILED* on \`${HOSTNAME_SHORT}\`
DB not readable at \`${SRC_DB}\`"
  echo "FATAL: ${SRC_DB} not readable" >&2
  exit 1
fi

if [[ ! -r "${SA_KEY_FILE}" ]]; then
  tg "❌ *evergreen-form backup FAILED* on \`${HOSTNAME_SHORT}\`
Service account key missing at \`${SA_KEY_FILE}\`
Run the install steps in the README."
  echo "FATAL: SA key ${SA_KEY_FILE} missing" >&2
  exit 1
fi

# Validate the SA JSON is non-empty + has the required fields. rclone
# will fail on an empty file with a cryptic "empty token" error;
# fail fast here with a clearer message.
if ! python3 -c "import json,sys; d=json.load(open('${SA_KEY_FILE}')); assert d.get('type')=='service_account', 'not a service account key'; assert d.get('client_email'); assert d.get('private_key')" 2>/dev/null; then
  tg "❌ *evergreen-form backup FAILED* on \`${HOSTNAME_SHORT}\`
Service account key at \`${SA_KEY_FILE}\` is missing required fields.
Need: type=service_account, client_email, private_key."
  echo "FATAL: SA key ${SA_KEY_FILE} is invalid or empty" >&2
  exit 1
fi

# ── Snapshot DB safely (WAL-consistent) ──────────────────────────────────
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"
SNAP="${STAGE_DIR}/submissions.db"

# .backup is the official SQLite hot-backup command. It uses the
# backup API internally: opens a second connection, acquires shared
# lock, copies page by page, integrates the WAL. Safe to run while
# the app is writing. Atomic from the app's perspective.
sqlite3 "${SRC_DB}" ".backup '${SNAP}'"

# Sanity check the snapshot
SNAP_BYTES="$(stat -c %s "${SNAP}" 2>/dev/null || stat -f %z "${SNAP}")"
SNAP_ROWS="$(sqlite3 "${SNAP}" 'SELECT COUNT(*) FROM submissions;' 2>/dev/null || echo "?")"
if [[ "${SNAP_BYTES}" -lt 1024 ]]; then
  tg "❌ *evergreen-form backup FAILED* on \`${HOSTNAME_SHORT}\`
Snapshot too small: ${SNAP_BYTES} bytes (DB is ${SNAP_BYTES:-?})"
  echo "FATAL: snapshot ${SNAP_BYTES} bytes" >&2
  exit 1
fi

# ── Stage log file ───────────────────────────────────────────────────────
if [[ -r "${SRC_LOG}" ]]; then
  cp -a "${SRC_LOG}" "${STAGE_DIR}/app.log"
fi

# Manifest for restore
cat > "${STAGE_DIR}/MANIFEST.txt" <<EOF
backup_created_utc: ${TS}
source_host:        ${HOSTNAME_SHORT}
source_db:          ${SRC_DB}
source_log:         ${SRC_LOG}
snapshot_bytes:     ${SNAP_BYTES}
snapshot_rows:      ${SNAP_ROWS}
sqlite_version:     $(sqlite3 -version | head -1)
rclone_version:     $(rclone version | head -1)
EOF

# ── Tarball ──────────────────────────────────────────────────────────────
tar -C "${STAGE_DIR}" -czf "${ARCHIVE_PATH}" \
  submissions.db MANIFEST.txt app.log 2>/dev/null || \
  tar -C "${STAGE_DIR}" -czf "${ARCHIVE_PATH}" \
  submissions.db MANIFEST.txt
ARCHIVE_BYTES="$(stat -c %s "${ARCHIVE_PATH}" 2>/dev/null || stat -f %z "${ARCHIVE_PATH}")"

# ── Upload to Drive ─────────────────────────────────────────────────────
RCLONE_CONFIG="$(mktemp)"
trap 'rm -f "${RCLONE_CONFIG}"' EXIT
cat > "${RCLONE_CONFIG}" <<EOF
[gdrive-evergreen]
type = drive
service_account_file = ${SA_KEY_FILE}
scope = drive.file
EOF

export RCLONE_CONFIG
# --drive-import-formats=docx,xlsx,pptx,csv is OFF by default. Force keep
# original .tar.gz filename; otherwise rclone will treat it as a native
# format and convert it (catastrophic for tarballs).
rclone copy "${ARCHIVE_PATH}" "${RCLONE_REMOTE}/" \
  --config "${RCLONE_CONFIG}" \
  --drive-acknowledge-abuse \
  --transfers 1 \
  --checkers 1 \
  --retries 3 \
  --low-level-retries 5 \
  --log-level INFO \
  --stats 30s

# ── Prune Drive copies (keep last N) ─────────────────────────────────────
# rclone doesn't have a built-in "keep last N" for a single folder, so
# list + sort + delete from index N onwards.
PRUNED="$(rclone lsjson "${RCLONE_REMOTE}/" --config "${RCLONE_CONFIG}" 2>/dev/null \
  | python3 -c "import json,sys; files=sorted([f for f in json.load(sys.stdin) if f.get('Name','').startswith('evergreen-form_')], key=lambda f: f['Name']); print(len(files))" 2>/dev/null || echo "0")"

if [[ "${PRUNED}" -gt "${DRIVE_KEEP_COUNT}" ]]; then
  DELETE_COUNT=$(( PRUNED - DRIVE_KEEP_COUNT ))
  rclone lsjson "${RCLONE_REMOTE}/" --config "${RCLONE_CONFIG}" \
    | python3 -c "import json,sys; files=sorted([f for f in json.load(sys.stdin) if f.get('Name','').startswith('evergreen-form_')], key=lambda f: f['Name']); [print(f['Name']) for f in files[:${DELETE_COUNT}]]" \
    | while read -r old; do
        rclone deletefile "${RCLONE_REMOTE}/${old}" --config "${RCLONE_CONFIG}" 2>/dev/null
      done
  PRUNE_MSG=" (pruned ${DELETE_COUNT} old, kept ${DRIVE_KEEP_COUNT})"
else
  PRUNE_MSG=" (Drive total: ${PRUNED}/${DRIVE_KEEP_COUNT})"
fi

# ── Prune local copies ──────────────────────────────────────────────────
find /tmp -maxdepth 1 -name "evergreen-form_*.tar.gz" -mtime "+${LOCAL_KEEP_DAYS}" -delete 2>/dev/null || true

# ── Cleanup staging ─────────────────────────────────────────────────────
rm -rf "${STAGE_DIR}"

# ── Success alert ───────────────────────────────────────────────────────
tg "✅ *evergreen-form backup OK* on \`${HOSTNAME_SHORT}\`
• when:      ${TS}
• size:      ${ARCHIVE_BYTES} bytes (${SNAP_BYTES}B DB)
• rows:      ${SNAP_ROWS}
• dest:      ${RCLONE_REMOTE}/${PRUNE_MSG}"

echo "OK: ${ARCHIVE_PATH} (${ARCHIVE_BYTES}B, ${SNAP_ROWS} rows) → ${RCLONE_REMOTE}/"
