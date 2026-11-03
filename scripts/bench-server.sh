#!/usr/bin/env bash
# Server ingest load test (PRD §2.2 / §10). Requires: docker (Postgres via `make db`), oha (`cargo install oha`).
# Usage: scripts/bench-server.sh [duration=60s] [rate=2000] [kind=events|config|replay]
set -euo pipefail
cd "$(dirname "$0")/.."
DURATION=${1:-60s}
RATE=${2:-2000}
KIND=${3:-events}
PORT=${BENCH_PORT:-18080}
PG_URL=${PG_URL:-postgres://replayd:replayd@127.0.0.1:55432/replayd?sslmode=disable}
OUT=${BENCH_OUT:-target/bench}
mkdir -p "$OUT"

make -s db >/dev/null
psql "$PG_URL" -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO projects (slug, name, public_key, upload_token_hash, allowed_origins)
VALUES ('bench', 'Bench', 'pk_bench', '\x00', '{https://bench.example}')
ON CONFLICT (slug) DO NOTHING;
SQL

(cd server && cargo build --release -q -p replayd)
DATA=$(mktemp -d)
REPLAYD_LISTEN=127.0.0.1:$PORT REPLAYD_DATABASE_URL="$PG_URL" REPLAYD_DATA_DIR="$DATA" \
  REPLAYD_IP_RPS=1000000 REPLAYD_IP_BURST=1000000 REPLAYD_PROJECT_RPS=1000000 REPLAYD_PROJECT_BURST=1000000 \
  REPLAYD_LOG=warn server/target/release/replayd &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.2; done
RSS_IDLE=$(awk '/VmRSS/{print $2}' /proc/$PID/status)

# realistic payloads: a gzip batch of 3 error events (~1 KB) and a 60 KB replay segment
BODY_EVENTS="$OUT/events.gz"
node -e '
const zlib=require("zlib");const ev=i=>({id:"0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8"+i,ts:Date.now(),sid:"0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d",level:"error",source:"onerror",type:"TypeError",message:"Cannot read properties of undefined (reading \x27price\x27)",stack:"TypeError: Cannot read properties of undefined (reading \x27price\x27)\n    at OrderPanel.submit (https://terminal.fxglory.com/_nuxt/OrderPanel.Cx1.js:1:2345)\n    at HTMLButtonElement.<anonymous> (https://terminal.fxglory.com/_nuxt/entry.B2.js:3:999)",url:"https://terminal.fxglory.com/trade",release:"1.42.0",env:"production",platform:"web",breadcrumbs:Array.from({length:10},(_,k)=>({ts:k,cat:"click",msg:"button#buy"})),count:1});
process.stdout.write(zlib.gzipSync(JSON.stringify([ev(1),ev(2),ev(3)])));' > "$BODY_EVENTS"

case "$KIND" in
  events) ARGS=(-m POST -T text/plain -D "$BODY_EVENTS" "http://127.0.0.1:$PORT/ingest/bench/events?key=pk_bench") ;;
  config) ARGS=("http://127.0.0.1:$PORT/ingest/bench/config?key=pk_bench") ;;
  replay) node -e 'const z=require("zlib"),c=require("crypto");const m=Buffer.from(JSON.stringify({sid:"0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d",seq:1,t0:Date.now(),t1:Date.now()+5000,n:400}));const ev=z.gzipSync(c.randomBytes(45000).toString("base64"));const b=Buffer.alloc(2+m.length+4+ev.length+2);let p=b.writeUInt16LE(m.length,0);m.copy(b,p);p+=m.length;p=b.writeUInt32LE(ev.length,p);ev.copy(b,p);p+=ev.length;b.writeUInt16LE(0,p);process.stdout.write(b)' > "$OUT/replay.bin"
          ARGS=(-m POST -T text/plain -D "$OUT/replay.bin" "http://127.0.0.1:$PORT/ingest/bench/replay?key=pk_bench") ;;
esac

oha --no-tui -z "$DURATION" -q "$RATE" -c 64 -H "Origin: https://bench.example" --output-format json "${ARGS[@]}" > "$OUT/oha-$KIND.json" &
OHA=$!
PEAK=0
while kill -0 $OHA 2>/dev/null; do
  R=$(awk '/VmRSS/{print $2}' /proc/$PID/status); [ "$R" -gt "$PEAK" ] && PEAK=$R; sleep 1
done
wait $OHA
node -e '
const r=require(process.argv[1]);const s=r.summary,p=r.latencyPercentiles,codes=r.statusCodeDistribution;
const ms=x=>(x*1000).toFixed(2)+" ms";
console.log(JSON.stringify({kind:process.argv[2],rps:+s.requestsPerSec.toFixed(1),success:s.successRate,p50:ms(p.p50),p95:ms(p.p95),p99:ms(p.p99),p999:ms(p["p99.9"]),max:ms(s.slowest),status:codes,rss_idle_mb:+(process.argv[3]/1024).toFixed(1),rss_peak_mb:+(process.argv[4]/1024).toFixed(1)}));
' "$PWD/$OUT/oha-$KIND.json" "$KIND" "$RSS_IDLE" "$PEAK" | tee "$OUT/summary-$KIND.json"
