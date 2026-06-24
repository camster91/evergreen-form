# evergreen-form backup → Google Drive (via Maton)

Daily hot backup of the SQLite submission database and application log
to Google Drive, with Telegram alerts.

## What's in the backup

Every run produces one tarball with:

- `submissions.db` — safe hot snapshot (WAL-consistent) via `sqlite3 .backup`
- `app.log` — current application log file
- `MANIFEST.txt` — backup metadata (timestamp, host, row count, sizes,
  sqlite version, restore instructions)

The snapshot uses SQLite's backup API, so the app keeps running and
keeps accepting submissions during the backup. The WAL is folded in
atomically from the app's perspective.

## Where it goes

Backups land in Google Drive at `camster91+ashbi@gmail.com`'s Ashbi
account, under the folder `Evergreen/Form-Backups/` (id
`1JlaeAMR0EWle-j3PcaLUGwGgt418CX5W`).

Drive is reached via the **Maton.ai API gateway** using the ASHBI key
(`MATON_API_KEY_ASHBI`). The key is stored on disk at
`/opt/evergreen-form-backup/maton-ashbi.key` (mode 600), not in the
cron env. The script reads the key from the file and uses it as a
Bearer token in the multipart upload.

**Why Maton, not rclone + service account:** you already pay for
Maton, it has the Google connection authorized, and there's no service
account / Drive-folder-sharing dance. One file with the API key is
the entire credential.

## One-time setup on the VPS (≈ 2 min)

1. **Drop the Maton key on disk** (mode 600):
   ```bash
   # Pull from your local vault, then push to the VPS:
   #   ssh user@local "hermes-vault get maton-ashbi --account"
   #   ssh root@187.77.26.99 "cat > /opt/evergreen-form-backup/maton-ashbi.key"
   #   ssh root@187.77.26.99 "chmod 600 /opt/evergreen-form-backup/maton-ashbi.key"
   ```
   (Or just paste the key into the file via `nano` / `vim`.)

2. **Create the env file**:
   ```bash
   cp /opt/evergreen-form-backup/backup.env.example \
      /opt/evergreen-form-backup/backup.env
   chmod 600 /opt/evergreen-form-backup/backup.env
   $EDITOR /opt/evergreen-form-backup/backup.env
   # Fill TG_BOT_TOKEN + TG_CHAT_ID. MATON_KEY_FILE + DRIVE_FOLDER_ID
   # already have the right defaults.
   ```

3. **Test once**:
   ```bash
   set -a; . /opt/evergreen-form-backup/backup.env; set +a
   /opt/evergreen-form-backup/evergreen-form-backup.sh
   ```
   You should see "OK: /tmp/evergreen-form_*.tar.gz → Drive <id>" and a
   green Telegram alert with a [open in Drive] link.

4. **Cron is already installed** at `/etc/cron.d/evergreen-form-backup`.
   Runs at 02:00 UTC daily. Verify with:
   ```bash
   ls -la /etc/cron.d/evergreen-form-backup
   cat /etc/cron.d/evergreen-form-backup
   ```
   Adjust the schedule in that file if 02:00 UTC is wrong (5pm ET, etc.).

## Restoring from a backup

```bash
# 1. Find the backup you want. Either:
#    a) open https://drive.google.com/drive/folders/1JlaeAMR0EWle-j3PcaLUGwGgt418CX5W
#    b) or list via Maton (from local):
#       curl -sS -H "Authorization: Bearer *** \
#         "https://api.maton.ai/google-drive/drive/v3/files?q=name%20contains%20%27evergreen-form_%27%20and%20%271JlaeAMR0EWle-j3PcaLUGwGgt418CX5W%27%20in%20parents%20and%20trashed=false&orderBy=name"

# 2. Download to VPS
#    From the Drive web UI: download to local, then scp to VPS.
#    Or use Maton (run from local with the ASHBI key):
#       curl -L -o /tmp/<file>.tar.gz \
#         -H "Authorization: Bearer *** \
#         "https://api.maton.ai/google-drive/drive/v3/files/<file-id>?alt=media"
#       scp /tmp/<file>.tar.gz root@187.77.26.99:/tmp/

# 3. Stop the app (otherwise the WAL will fight the restore)
ssh root@187.77.26.99 "docker stop evergreen-form"

# 4. Replace the live DB
cd /tmp && tar -xzf evergreen-form_<host>_<ts>.tar.gz
cp /tmp/submissions.db /data/submissions.db
chown 9999:9999 /data/submissions.db   # match the container's UID
# Drop the WAL so SQLite re-checks the main DB cleanly
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
| `/opt/evergreen-form-backup/backup.env` | TG bot + drive folder + maton key path | 600 |
| `/opt/evergreen-form-backup/maton-ashbi.key` | Maton ASHBI API key | 600 |
| `/etc/cron.d/evergreen-form-backup` | Cron entry | 644 |
| `/var/log/evergreen-form-backup.log` | Cron output (rotated by logrotate) | 644 |

## What if the bot is down

If Telegram is unreachable, the script logs the alert to stderr and
continues. The backup itself is independent of the alert.

If the Drive upload fails, the script exits non-zero with a red Telegram
alert AND the local tarball stays in `/tmp` for manual recovery
(pruned after 7 days).

## Pitfalls

- **Don't paste the Maton key in chat** — pull it from the vault. The
  key file is mode 600, owned by root, never displayed in logs.
- **Don't change the cron entry to send the key inline.** The key
  contains characters that bash will mangle (`$`, backticks, etc.).
  Always source from the file.
- **The Maton `supportsAllDrives=true` query param is required** for
  folder-list operations on shared drives. We pass it on the upload
  to be safe. The Drive folder we target is a personal folder, not a
  shared drive, but the flag is harmless there.
- **Maton API has rate limits** — the docs say "a few hundred requests
  per minute" per connection. We make 2 requests per run (upload +
  list for prune). With one cron per day, we're nowhere near.
