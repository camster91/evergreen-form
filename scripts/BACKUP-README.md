# evergreen-form backup → Google Drive

Daily hot backup of the SQLite submission database and application log
to Google Drive, with Telegram alerts.

## What's in the backup

Every run produces one tarball with:

- `submissions.db` — safe hot snapshot (WAL-consistent) via `sqlite3 .backup`
- `app.log` — current application log file
- `MANIFEST.txt` — backup metadata (timestamp, host, row count, sizes,
  tool versions)

The snapshot uses SQLite's backup API, so the app keeps running and
keeps accepting submissions during the backup. The WAL is folded in
atomically from the app's perspective.

## One-time setup on the VPS (≈ 10 min)

1. **Create a Google Cloud project + service account**
   - Go to https://console.cloud.google.com/
   - Create project (or reuse existing)
   - APIs & Services → Library → enable **Google Drive API**
   - APIs & Services → Credentials → Create Credentials → Service account
   - Skip the "Grant this service account access to project" step (we don't
     need project-level IAM; we just need the SA email)
   - Done → click the new SA → Keys → Add Key → Create new key → JSON
   - Save the JSON file as `/root/.evergreen-form/gdrive-sa.json` on the VPS
   - `chmod 600 /root/.evergreen-form/gdrive-sa.json`
   - `chown root:root /root/.evergreen-form/gdrive-sa.json`

2. **Create the Drive folder + share with the SA**
   - In Google Drive, create a folder called `Evergreen-Form-Backups`
   - Right-click → Share → paste the service account email
     (looks like `evergreen-backup@your-project.iam.gserviceaccount.com`)
   - Grant **Editor** access
   - Uncheck "Notify people" (SA doesn't have a real inbox)

3. **Set up Telegram alerts (optional but recommended)**
   - DM `@BotFather` on Telegram → `/newbot` → save the token
   - Send any message to your bot, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your `chat_id`
   - Fill both into `/opt/evergreen-form-backup/backup.env`

4. **Create the env file**
   ```bash
   cp /opt/evergreen-form-backup/backup.env.example \
      /opt/evergreen-form-backup/backup.env
   chmod 600 /opt/evergreen-form-backup/backup.env
   $EDITOR /opt/evergreen-form-backup/backup.env
   # Fill TG_BOT_TOKEN, TG_CHAT_ID, SA_KEY_FILE
   ```

5. **Test once**
   ```bash
   set -a; . /opt/evergreen-form-backup/backup.env; set +a
   /opt/evergreen-form-backup/evergreen-form-backup.sh
   ```
   You should see "OK: /tmp/evergreen-form_*.tar.gz → gdrive-evergreen:..."
   and a green Telegram alert.

6. **Install the cron entry**
   ```bash
   cat > /etc/cron.d/evergreen-form-backup <<'EOF'
   SHELL=/bin/bash
   PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

   0 2 * * * root set -a; . /opt/evergreen-form-backup/backup.env; set +a; /opt/evergreen-form-backup/evergreen-form-backup.sh >> /var/log/evergreen-form-backup.log 2>&1
   EOF
   chmod 644 /etc/cron.d/evergreen-form-backup
   ```
   Runs at 02:00 UTC daily. Adjust as needed for your timezone.

## Restoring from a backup

```bash
# 1. Find the backup you want
rclone ls gdrive-evergreen:Evergreen-Form-Backups/

# 2. Pull it locally
rclone copy gdrive-evergreen:Evergreen-Form-Backups/evergreen-form_<host>_<ts>.tar.gz /tmp/

# 3. Stop the app (otherwise the WAL will fight the restore)
ssh root@187.77.26.99 "docker stop evergreen-form"

# 4. Replace the live DB
cd /tmp && tar -xzf evergreen-form_<host>_<ts>.tar.gz
cp /tmp/submissions.db /data/submissions.db
chown 9999:9999 /data/submissions.db   # match the container's UID
# Also drop the WAL so SQLite re-checks the main DB cleanly
rm -f /data/submissions.db-wal /data/submissions.db-shm

# 5. Start the app
ssh root@187.77.26.99 "docker start evergreen-form"

# 6. Verify
curl -s https://evergreen-form.ashbi.ca/api/health
# totalSubmissions should match the MANIFEST row count
```

The `MANIFEST.txt` inside the tarball tells you the exact row count
the snapshot had when it was taken, so you can compare.

## Files

| Path | Purpose | Mode |
|---|---|---|
| `/opt/evergreen-form-backup/evergreen-form-backup.sh` | The script | 700 |
| `/opt/evergreen-form-backup/backup.env` | Secrets + config | 600 |
| `/root/.evergreen-form/gdrive-sa.json` | Google service account key | 600 |
| `/etc/cron.d/evergreen-form-backup` | Cron entry | 644 |
| `/var/log/evergreen-form-backup.log` | Cron output (rotated by logrotate if configured) | 644 |

## What if the bot is down

If Telegram is unreachable, the script logs the alert to stderr and
continues. The backup itself is independent of the alert.

If the upload fails, the script exits non-zero with a red Telegram
alert AND the local tarball stays in `/tmp` for manual recovery
(pruned after 7 days).
