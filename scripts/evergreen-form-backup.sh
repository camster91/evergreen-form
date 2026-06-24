#!/usr/bin/env bash
# evergreen-form-backup.sh
# Hot backup of SQLite DB + log to Google Drive via Maton, with Telegram alerts.
# Run daily via cron. Idempotent. Safe to re-run.

set -euo pipefail

# ── Config (env-overridable) ──────────────────────────────────────────────
SRC_DB="${SRC_DB:-/data/submissions.db}"
SRC_LOG="${SRC_LOG:-/data/app.log}"
STAGE_DIR="${STAGE_DIR:-/tmp/evergreen-form-backup}"
LOCAL_KEEP_DAYS="${LOCAL_KEEP_DAYS:-7}"
DRIVE_KEEP_COUNT="${DRIVE_KEEP_COUNT:-30}"
DRIVE_FOLDER_ID="${DRIVE_FOLDER_ID:-1JlaeAMR0EWle-j3PcaLUGwGgt418CX5W}"
MATON_KEY_FILE="${MATON_KEY_FILE:-/opt/evergreen-form-backup/maton-ashbi.key}"
MATON_BASE="${MATON_BASE:-https://api.maton.ai}"
# Directory holding the helper python scripts (same dir as this bash script by default)
SCRIPT_DIR="${SCRIPT_DIR:-$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")}"

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

if [[ ! -r "${MATON_KEY_FILE}" ]]; then
  tg "❌ *evergreen-form backup FAILED* on \`${HOSTNAME_SHORT}\`
Maton key missing at \`${MATON_KEY_FILE}\`
Run the install steps in the README."
  echo "FATAL: Maton key ${MATON_KEY_FILE} missing" >&2
  exit 1
fi

# Validate the Maton key. A non-empty ASCII string is the minimum
# requirement — we don't have a public validation endpoint that doesn't
# count as a Drive write. A real test is the upload itself.
MATON_KEY="$(cat "${MATON_KEY_FILE}")"
if [[ -z "${MATON_KEY}" || "${#MATON_KEY}" -lt 50 ]]; then
  tg "❌ *evergreen-form backup FAILED* on \`${HOSTNAME_SHORT}\`
Maton key at \`${MATON_KEY_FILE}\` is empty or too short."
  echo "FATAL: Maton key empty" >&2
  exit 1
fi

# ── Snapshot DB safely (WAL-consistent) ──────────────────────────────────
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"
SNAP="${STAGE_DIR}/submissions.db"

sqlite3 "${SRC_DB}" ".backup '${SNAP}'"

# Sanity check the snapshot
SNAP_BYTES="$(stat -c %s "${SNAP}" 2>/dev/null || stat -f %z "${SNAP}")"
SNAP_ROWS="$(sqlite3 "${SNAP}" 'SELECT COUNT(*) FROM submissions;' 2>/dev/null || echo "?")"
if [[ "${SNAP_BYTES}" -lt 1024 ]]; then
  tg "❌ *evergreen-form backup FAILED* on \`${HOSTNAME_SHORT}\`
Snapshot too small: ${SNAP_BYTES} bytes"
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
restore_instructions: tar -xzf <archive>; cp submissions.db /data/submissions.db; chown 9999:9999 /data/submissions.db; rm -f /data/submissions.db-wal /data/submissions.db-shm
EOF

# ── Tarball ──────────────────────────────────────────────────────────────
tar -C "${STAGE_DIR}" -czf "${ARCHIVE_PATH}" \
  submissions.db MANIFEST.txt app.log 2>/dev/null || \
  tar -C "${STAGE_DIR}" -czf "${ARCHIVE_PATH}" \
  submissions.db MANIFEST.txt
ARCHIVE_BYTES="$(stat -c %s "${ARCHIVE_PATH}" 2>/dev/null || stat -f %z "${ARCHIVE_PATH}")"

# ── Upload to Drive via Maton (multipart upload) ────────────────────────
# Drive v3 multipart upload: POST /upload/drive/v3/files?uploadType=multipart
# Body: metadata part (JSON) + file part (binary), CRLF separated by boundary
BOUNDARY="-------hermes-backup-boundary-$$-${RANDOM}"
UPLOAD_URL="${MATON_BASE}/google-drive/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true"

# Build multipart body
TMPBODY="$(mktemp)"
trap 'rm -f "${TMPBODY}"' EXIT
{
  printf -- "--%s\r\n" "${BOUNDARY}"
  printf "Content-Type: application/json; charset=UTF-8\r\n\r\n"
  printf '{"name":"%s.tar.gz","parents":["%s"]}\r\n' "${BASENAME}" "${DRIVE_FOLDER_ID}"
  printf -- "--%s\r\n" "${BOUNDARY}"
  printf "Content-Type: application/gzip\r\n\r\n"
  cat "${ARCHIVE_PATH}"
  printf "\r\n--%s--\r\n" "${BOUNDARY}"
} > "${TMPBODY}"

BODY_BYTES="$(stat -c %s "${TMPBODY}" 2>/dev/null || stat -f %z "${TMPBODY}")"

# Run curl, capture the response
UPLOAD_RESP="$(mktemp)"
UPLOAD_HTTP="$(curl -sS --max-time 120 -o "${UPLOAD_RESP}" -w "%{http_code}" -X POST "${UPLOAD_URL}" -H "Authorization: Bearer ${MATON_KEY}" -H "Content-Type: multipart/related; boundary=${BOUNDARY}" -H "Content-Length: ${BODY_BYTES}" --data-binary "@${TMPBODY}")"
rm -f "${TMPBODY}"

if [[ "${UPLOAD_HTTP}" != "200" ]]; then
  ERR_BODY="$(head -c 1000 "${UPLOAD_RESP}" 2>/dev/null || echo "")"
  rm -f "${UPLOAD_RESP}"
  tg "❌ *evergreen-form backup FAILED* on \`${HOSTNAME_SHORT}\`
Drive upload HTTP ${UPLOAD_HTTP}
Archive: \`${BASENAME}.tar.gz\` (${ARCHIVE_BYTES} bytes)
\`\`\`
${ERR_BODY}
\`\`\`
Local copy at \`${ARCHIVE_PATH}\` is preserved for 7 days."
  echo "FATAL: upload HTTP ${UPLOAD_HTTP}: ${ERR_BODY}" >&2
  exit 1
fi

# Extract the file id from the response for the success message
FILE_ID="$(python3 -c "import json,sys; d=json.load(open('${UPLOAD_RESP}')); print(d.get('id','?'))" 2>/dev/null || echo "?")"
WEB_LINK="$(python3 -c "import json,sys; d=json.load(open('${UPLOAD_RESP}')); print(d.get('webViewLink','?'))" 2>/dev/null || echo "?")"
rm -f "${UPLOAD_RESP}"

# ── Prune Drive copies (keep last N) ─────────────────────────────────────
# Maton's /files list is paginated; for ≤30 items one page is enough.
# We filter by name pattern (starts with `evergreen-form_`) and sort
# by name (which is ISO 8601 basic, sorts correctly by date).
LIST_JSON="$(mktemp)"
# Build the query string with python3 -c. Single-line so bash 3.2 (macOS)
# is happy. Preserves single quotes around folder-id in the q value.
QSTR_FID="${DRIVE_FOLDER_ID}"
LIST_QUERY="$("${SCRIPT_DIR}/_build-list-query.py" "${DRIVE_FOLDER_ID}" 2>/dev/null)"
LIST_URL="${MATON_BASE}/google-drive/drive/v3/files?${LIST_QUERY}"
curl -sS --max-time 30 -X GET "${LIST_URL}" \
  -H "Authorization: Bearer ${MATON_KEY} \
  -H "Accept: application/json" -o "${LIST_JSON}"

PRUNE_MSG=""
DELETE_COUNT="$("${SCRIPT_DIR}/_parse-prune-list.py" "${LIST_JSON}" "${DRIVE_KEEP_COUNT}" 2>/dev/null)"

if [[ -n "${DELETE_COUNT}" ]]; then
  DELETED_N="$(echo "${DELETE_COUNT}" | wc -l | tr -d ' ')"
  while read -r fid; do
    [[ -z "${fid}" ]] && continue
    curl -sS --max-time 30 -X DELETE "${MATON_BASE}/google-drive/drive/v3/files/${fid}" -H "Authorization: Bearer ${MATON_KEY}" -o /dev/null 2>&1; :
  done <<< "${DELETE_COUNT}"
  PRUNE_MSG=" (pruned ${DELETED_N} old, kept ${DRIVE_KEEP_COUNT})"
fi
rm -f "${LIST_JSON}"

# ── Prune local copies ──────────────────────────────────────────────────
find /tmp -maxdepth 1 -name "evergreen-form_*.tar.gz" -mtime "+${LOCAL_KEEP_DAYS}" -delete 2>/dev/null || true

# ── Cleanup staging ─────────────────────────────────────────────────────
rm -rf "${STAGE_DIR}"

# ── Success alert ───────────────────────────────────────────────────────
tg "✅ *evergreen-form backup OK* on \`${HOSTNAME_SHORT}\`
• when:      ${TS}
• size:      ${ARCHIVE_BYTES} bytes (${SNAP_BYTES}B DB)
• rows:      ${SNAP_ROWS}
• file id:   \`${FILE_ID}\`
• [open in Drive](${WEB_LINK})${PRUNE_MSG}"

echo "OK: ${ARCHIVE_PATH} (${ARCHIVE_BYTES}B, ${SNAP_ROWS} rows) → Drive ${FILE_ID}"
