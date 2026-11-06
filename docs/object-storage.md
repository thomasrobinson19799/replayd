# Bucket storage for finished replays (T-55, D-37)

Optional. Without these settings, replayd keeps every recording on its local volume, as before.

## What moves and what stays

| Data | Where |
|---|---|
| Finished recordings | Bucket: `replays/<project id>/<YYYY-MM-DD>/<session id>.rpl` |
| Live recordings (no writes for less than 20 minutes) | Local `replay-data` volume |
| Recently played recordings | Local cache `data/_cache/`, at most 2 GB by default, each copy for at most 24 hours |
| Source maps | Local `replay-data` volume |
| Sessions, issues, users (Postgres) | Local `pgdata` volume |

Buckets cannot append, and the writers' guarantee of losing at most 1 second of data in a crash needs a real disk, so
live sessions stay local. Existing local recordings move on the first passes after you enable this.

## Set up

1. Create a bucket. Use one for replayd alone: replayd only ever touches keys under `replays/`, but a separate bucket
   also keeps its size, permissions and lifecycle rules separate.
2. Create an S3 key for it.
3. Add the settings to `deploy/.env` (mode 600) and recreate the container:

```sh
REPLAYD_S3_ENDPOINT=https://fsn1.your-objectstorage.com
REPLAYD_S3_BUCKET=replayd
REPLAYD_S3_REGION=fsn1
REPLAYD_S3_ACCESS_KEY=...
REPLAYD_S3_SECRET_KEY=...
```

```sh
docker compose -f deploy/docker-compose.yml --profile app up -d --no-build --wait replayd
docker compose -f deploy/docker-compose.yml logs replayd | grep "object storage"
```

The log must say `object storage reachable`. Setting only some of the five variables stops the server at start with
the name of the missing one. A bucket that is unreachable at start is logged but does not stop ingest.

Optional: `REPLAYD_S3_UPLOAD_IDLE_SECS` (default 1200; keep it above the 15 minute session end) and
`REPLAYD_S3_CACHE_MB` (default 2048).

## How it behaves

- **Upload:** every minute, recordings untouched for the idle period are uploaded (4 at a time) and their size checked.
  Then the shard writer removes the local file, and only if it has not grown since the upload.
- **Late segments:** a segment for an uploaded session, such as an APK draining its offline queue, starts a new local
  file. It plays back straight away and is merged into the object on a later pass, without duplicates.
- **Playback:** the first play of an uploaded recording downloads it into the cache, then `Range`, `ETag` and viewer
  redaction work as they do for local files. Expect a short extra wait on that first play for large recordings.
- **Retention:** the daily run applies each project's retention to the bucket too, and removes deleted projects.
- **Delete:** deleting a session removes the local file, the object and cached copies. If the bucket is unreachable the
  request fails and the session stays, so it can be retried.

## Bucket outage

Ingest is not affected. Recordings wait on the local volume, and anything still local keeps playing. Recordings that
only exist in the bucket answer 500 until it returns. Uploads resume on their own, but the local volume grows meanwhile:
watch `ReplaydBucketUploadsFailing` and `ReplaydDiskAlmostFull`.

Metrics: `replayd_objstore_uploads_total{result}`, `replayd_objstore_upload_bytes_total`,
`replayd_objstore_pending_files`.

## Turning it off

Removing the settings stops uploads, but recordings already in the bucket are no longer found. First copy `replays/`
back into the volume, keeping the folder layout, for example with `rclone copy`.

Replays are not backed up by replayd, so the bucket holds the only copy of finished recordings. Do not add a lifecycle
rule shorter than the longest project retention (14 days at most). A rule that aborts incomplete multipart uploads
after a few days is useful: an upload cut off by a restart leaves its parts behind.

## Tests

`node e2e/object-storage.e2e.mjs` runs the real SDK and server image against SeaweedFS.
`crates/objstore/tests/s3_live.rs` runs multipart, listing and batch delete against any S3 server you point
`REPLAYD_TEST_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY` and `_SECRET_KEY` at.
