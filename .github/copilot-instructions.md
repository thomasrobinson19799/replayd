# Agent rules — replayd

Source of truth: [PRD.md](./PRD.md). Progress tracker: [PROGRESS.md](./PROGRESS.md).
At the start of every session read PRD.md, this file and PROGRESS.md, then continue from the first unfinished task.

## Rules (PRD §12.1, verbatim)

1. This PRD is the source of truth; if code and PRD disagree, stop and ask.
2. One task per branch/MR; task ID in branch name (`t-14-ws-capture`).
3. **No new runtime dependency in `sdk/packages/core` ever.** Any new SDK dependency requires running `pnpm size` and staying within §2.1.
4. Never parse, stringify or allocate per WebSocket message / mutation on the main thread beyond what the task specifies; heavy work goes to the worker.
5. Never decompress replay payloads in the server ingest path.
6. Every task ends with: tests passing, `pnpm size` / `cargo clippy -D warnings` clean, acceptance criteria checked in the MR description.
7. Never log tokens, keys, payloads; never weaken redaction defaults.
8. Spikes (T-01…T-04) produce a short `docs/spikes/<id>.md` with findings before dependent tasks start.

## Project-level working agreement (from the project owner)

- Canvas snapshots (T-02, T-24) are out of scope for v1. The wire format keeps the asset section (`asset_count = 0`).
- Deviations from the PRD are recorded in the **Decisions log** at the end of PRD.md (and in the spike doc when a spike caused them).
- Per task: implement → tests → run checks → commit `T-xx: <title>` → tick PROGRESS.md.
- Required checks before each commit:
  - server: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
  - sdk: `pnpm lint`, `pnpm test`, `pnpm size`
  - dashboard: `pnpm lint`, `pnpm typecheck`, `pnpm build`
- Performance is the top requirement. Never "fix" a budget by loosening it; measure and record in `docs/bench.md`.
- Never use unbounded channels or queues. Never log tokens/keys/payloads.
