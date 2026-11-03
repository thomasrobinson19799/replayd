# Wire format fixtures (T-11)

Cross-language round trip between the TS encoder/reader (`sdk/packages/core/src/wire.ts`) and the Rust
parser/writer (`server/crates/common`).

| File | Produced by | Consumed by |
|---|---|---|
| `events.json`, `segment.meta.json` | hand-written input | both |
| `segment.bin` | TS `encodeSegment` (gzip level 9 of `events.json`, one 12-byte WebP-type asset) | Rust `parse_replay_body` |
| `session.rpl` | Rust `.rpl` writer from `segment.bin` (frames seq 1, 0, duplicate 1, truncated tail) | TS `indexRpl` + Rust `rpl::index` |

Regenerate: `REPLAYD_REGEN_FIXTURES=1 pnpm -C sdk test wire` then `REPLAYD_REGEN_FIXTURES=1 cargo test -p replayd-common --test fixtures` (in `server/`). Without the variable both sides assert byte equality against the committed files.
