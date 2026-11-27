#!/usr/bin/env bash
# Nightly Whatix backup: a consistent online copy of the SQLite database (no
# downtime), integrity-checked, compressed, optionally encrypted and copied
# off the server, with old copies pruned. Optionally also the WAHA session
# volume, so paired WhatsApp numbers can be restored without re-pairing.
#
# Install (once, as root):  install -m 0750 deploy/backup.sh /usr/local/sbin/whatix-backup
#   cp deploy/whatix-backup.{service,timer} /etc/systemd/system/ && systemctl enable --now whatix-backup.timer
# Settings (optional) go in /etc/whatix-backup.env:
#   BACKUP_DIR=/var/backups/whatix   KEEP_DAYS=14
#   BACKUP_AGE_RECIPIENT=age1...     # encrypt with `age` (strongly recommended before copying off-site)
#   BACKUP_REMOTE=remote:whatix      # `rclone` destination for an off-site copy
#   WAHA_SESSIONS_VOLUME=whatix_waha_sessions   # see `docker volume ls`; brief WAHA pause is not needed for a tar of files at rest, but schedule off-hours
set -Eeuo pipefail
umask 077
APP_DIR=${APP_DIR:-/opt/whatix}
DATA_DIR=${DATA_DIR:-$APP_DIR/state/data}
DEST=${BACKUP_DIR:-/var/backups/whatix}
KEEP_DAYS=${KEEP_DAYS:-14}
cd "$APP_DIR"
exec 9>.backup.lock
flock -n 9 || { echo "A backup is already running."; exit 1; }
compose=(docker compose -f compose.yaml)
[[ -f compose.override.yaml ]] && compose+=(-f compose.override.yaml)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DEST"
copy="backup-$stamp.db"

# VACUUM INTO inside the running API container: a transactionally consistent
# copy while the app keeps working, then an integrity check of the copy.
"${compose[@]}" exec -T api node -e '
const sqlite3=require("sqlite3"),path=require("path");
const source=process.env.WHATIX_DB_PATH||"/app/data/whatix.db";
const target=path.join(path.dirname(source),process.argv[1]);
const db=new sqlite3.Database(source,sqlite3.OPEN_READONLY);
db.exec("VACUUM INTO '"'"'"+target.replaceAll("'"'"'","'"'"''"'"'")+"'"'"'",err=>{
  db.close();
  if(err){console.error("backup failed: "+err.message);process.exit(1);}
  const check=new sqlite3.Database(target,sqlite3.OPEN_READONLY);
  check.get("PRAGMA integrity_check",(e,row)=>{check.close();
    if(e||row?.integrity_check!=="ok"){console.error("backup copy failed integrity check");process.exit(1);}});
});' "$copy"

mv "$DATA_DIR/$copy" "$DEST/whatix-$stamp.db"
gzip -9 "$DEST/whatix-$stamp.db"
files=("$DEST/whatix-$stamp.db.gz")

if [[ -n ${WAHA_SESSIONS_VOLUME:-} ]]; then
  docker run --rm -v "$WAHA_SESSIONS_VOLUME":/s:ro -v "$DEST":/b alpine:3.20 \
    tar czf "/b/waha-sessions-$stamp.tgz" -C /s .
  files+=("$DEST/waha-sessions-$stamp.tgz")
fi

if [[ -n ${BACKUP_AGE_RECIPIENT:-} ]]; then
  for f in "${files[@]}"; do age -r "$BACKUP_AGE_RECIPIENT" -o "$f.age" "$f" && rm -f "$f"; done
  files=("${files[@]/%/.age}")
fi

if [[ -n ${BACKUP_REMOTE:-} ]]; then
  for f in "${files[@]}"; do rclone copy "$f" "$BACKUP_REMOTE/"; done
fi

find "$DEST" -maxdepth 1 -type f \( -name 'whatix-*.db.gz*' -o -name 'waha-sessions-*.tgz*' \) -mtime +"$KEEP_DAYS" -delete
echo "Backup complete: ${files[*]}"
