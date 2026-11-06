# Database backups

The optional Compose `backup` profile runs an immediate PostgreSQL custom-format dump,
then one every 24 hours. Failures retry after five minutes. It uses the same database
credentials as replayd without writing them to logs or command arguments.

```sh
docker compose -f deploy/docker-compose.yml --profile backup up -d backup
```

Archives live in the `pgbackups` named volume. They have owner-only permissions and are
published by atomic rename only after `pg_dump` and archive validation succeed. A lock
prevents overlapping jobs. The default retention is 14 days; configure
`REPLAYD_BACKUP_RETENTION_DAYS` (1–3650) before starting the service. Retention touches
only this job's `replayd-*.dump` files. Replay recordings are intentionally not backed up.
The service becomes unhealthy when no successful archive exists within 26 hours.

Run an extra backup without changing the schedule:

```sh
docker compose -f deploy/docker-compose.yml --profile backup run --rm backup /opt/replayd-backup/once.sh
```

## Restore into a separate database

Keep the live database intact while verifying a restore. List the archives, choose the
desired filename, and replace `ARCHIVE.dump` below with that exact basename.

```sh
docker compose -f deploy/docker-compose.yml exec backup ls -1 /backups
docker compose -f deploy/docker-compose.yml exec postgres createdb -U replayd replayd_restore
docker compose -f deploy/docker-compose.yml exec backup pg_restore --exit-on-error --no-owner --dbname=replayd_restore /backups/ARCHIVE.dump
```

Validate the restored database before planning any production cutover. Export archives
to your own protected off-host storage: a volume on the database host cannot protect
against loss of that host. Do not run `docker compose down -v` on retained data.

## Local automated verification

`node scripts/test-backup.mjs` creates an isolated disposable database container with no
network or host ports. It verifies dump/restore, file permissions, failed-dump cleanup,
retention and overlapping-job locking, then removes that container and its temporary
volume. It does not connect to your existing replayd database.
