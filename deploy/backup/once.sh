#!/bin/sh
set -eu
umask 077
backup_dir=${BACKUP_DIR:-/backups}
retention=${BACKUP_RETENTION_DAYS:-14}
case "$backup_dir" in /|/*/../*|*/..) echo 'Invalid backup directory' >&2; exit 2;; /*) ;; *) echo 'Backup directory must be absolute' >&2; exit 2;; esac
case "$retention" in ''|*[!0-9]*) echo 'Invalid backup retention' >&2; exit 2;; esac
[ "$retention" -ge 1 ] && [ "$retention" -le 3650 ] || { echo 'Backup retention must be 1–3650 days' >&2; exit 2; }
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
exec 9>"$backup_dir/.lock"
flock -n 9 || { echo 'Backup already running'; exit 0; }
# Only this job's interrupted files are removed, after acquiring its exclusive lock.
find "$backup_dir" -maxdepth 1 -type f -name '.replayd-*.partial' -delete
stamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp "$backup_dir/.replayd-$stamp-XXXXXX.partial")
trap 'rm -f "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
# libpq reads PGHOST/PGUSER/PGDATABASE/PGPASSWORD from the environment; never print them.
pg_dump --format=custom --no-owner --file="$temporary"
pg_restore --list "$temporary" > /dev/null
filename=$(basename "$temporary" .partial)
mv "$temporary" "$backup_dir/${filename#.}.dump"
find "$backup_dir" -maxdepth 1 -type f -name 'replayd-*.dump' -mmin "+$((retention * 1440))" -delete
echo 'Database backup completed'
