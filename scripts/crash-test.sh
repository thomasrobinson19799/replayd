#!/usr/bin/env bash
# T-21 crash test (PRD §10): replay load → kill -9 mid-load → every segment acked more than 1 s before the
# kill must be on disk, and every .rpl file must be readable.
# Usage: scripts/crash-test.sh [rate=300] [seconds_before_kill=8]
set -euo pipefail
cd "$(dirname "$0")/.."
RATE=${1:-300}
KILL_AFTER=${2:-8}
PORT=${CRASH_PORT:-18081}
PG_URL=${PG_URL:-postgres://replayd:replayd@127.0.0.1:55432/replayd?sslmode=disable}
OUT=target/crash
rm -rf "$OUT" && mkdir -p "$OUT/data"

make -s db >/dev/null
psql "$PG_URL" -q -v ON_ERROR_STOP=1 -c "INSERT INTO projects (slug, name, public_key, upload_token_hash, allowed_origins) VALUES ('bench', 'Bench', 'pk_bench', '\x00', '{https://bench.example}') ON CONFLICT (slug) DO NOTHING"
(cd server && cargo build --release -q -p replayd && cargo build --release -q -p replayd-storage --example rplcheck)

REPLAYD_LISTEN=127.0.0.1:$PORT REPLAYD_DATABASE_URL="$PG_URL" REPLAYD_DATA_DIR="$OUT/data" \
  REPLAYD_IP_RPS=1000000 REPLAYD_IP_BURST=1000000 REPLAYD_PROJECT_RPS=1000000 REPLAYD_PROJECT_BURST=1000000 \
  REPLAYD_LOG=warn server/target/release/replayd &
PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.2; done

node scripts/replay-load.mjs --url "http://127.0.0.1:$PORT" --rate "$RATE" --seconds $((KILL_AFTER + 5)) \
  --sessions 300 --size 20000 --log "$OUT/acks.txt" > "$OUT/load.json" &
LOAD=$!
sleep "$KILL_AFTER"
KILL_MS=$(node -e 'console.log(Date.now())')
kill -9 $PID
wait $LOAD || true
echo "load: $(cat "$OUT/load.json")"
server/target/release/examples/rplcheck "$OUT/data" "$OUT/acks.txt" "$KILL_MS" | tee "$OUT/result.json"
node -e '
const r = require(process.argv[1]);
const lossOk = r.oldest_missing_ack_before_kill_ms === null || r.oldest_missing_ack_before_kill_ms <= 1000;
const ok = r.unreadable_files === 0 && r.bad_bodies === 0 && lossOk && r.acked > 0;
console.log(ok ? "CRASH TEST PASS" : "CRASH TEST FAIL");
process.exit(ok ? 0 : 1);' "$PWD/$OUT/result.json"
