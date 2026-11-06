# Replay MP4 exports

On an authenticated replay or valid public share, choose **Download MP4**. Progress
is retained when leaving the page. Once ready, the same button downloads the shared
session job. A later recording update leaves that file available with its coverage
time and **Render latest**. A retry or latest render replaces the previous job.

The separate Compose `renderer` service uses Chromium, rrweb 2.2.0 and FFmpeg. The
replayd binary/image contains neither browser nor encoder. Start the existing `app`
profile to run the renderer; its `render-data` volume is shared with replayd.

Output is H.264/yuv420p at 10 frames/second, full real-time duration including idle
periods, with only the recorded page and cursor. Mid-session viewport changes fit
inside the first viewport with black bars. An odd width/height gains one padding
pixel, so 412×915 becomes 412×916 without scaling the recorded page.

The owner chose offline rendering: external images/fonts and other uncaptured
remote assets can be missing. Recorded inline styles are retained. Chromium has
no network, no service credentials and no host mounts; recorded scripts are
disabled by rrweb's iframe sandbox. Compose also uses a nonroot user, read-only
root filesystem, dropped capabilities, no-new-privileges, CPU/memory/PID limits
and a temporary browser profile. The only persistent mount is the render spool.

Limits:

- Two running jobs plus ten waiting; full capacity returns “try later”.
- One job per session. Active/ready reuse does not consume a new-render allowance.
- Public starts: ten per rolling hour/IP across links, using salted in-memory
  hashes and a capped 50,000-entry map. Visitor IPs are not written to disk.
- At most 512 jobs and 32 GiB reserved spool space; each input/output is capped at
  2 GiB. Admission reserves active outputs before starting another job.
- Maximum viewport dimension 8192, 100,000 recording frames, 2 million events,
  64 MiB inflated frame and 61-minute recording duration. Over-limit work fails
  without publishing a partial MP4.
- Finished videos expire after 24 hours. The server sweeps every minute and also
  removes jobs for deleted/retained-out sessions. Interrupted renders can retry.

Both players poll session metadata every five seconds while recording and request
only new recording bytes using Range. Video status also polls every five seconds.

## Encoder license

The tested Ubuntu package is FFmpeg `6.1.1-3ubuntu5`, configured with `--enable-gpl`
and `--enable-libx264`; its `ffmpeg -L` reports GPL version 2 or later. The encoder
is a separate executable in the render image. Distribution of that image must
comply with the bundled software licenses, including corresponding-source and
notice requirements. Codec patent licensing is separate and depends on use and
jurisdiction. This is not a claim that H.264 has no licensing obligations.
See [FFmpeg legal guidance](https://www.ffmpeg.org/legal.html) and
[FFmpeg license documentation](https://ffmpeg.org/doxygen/trunk/md_LICENSE.html).

## Local acceptance (T-61)

- Server formatting, all-target Clippy with warnings denied, full tests with
  PostgreSQL: pass. Tests cover queue refusal, same-job reuse, public rate allowance,
  expiry and session deletion.
- SDK lint, 140 unit tests, four benchmark-gate tests and bundle limits: pass.
- Dashboard lint, types, 27 tests and production build: pass.
- Real Chromium/FFmpeg export: H.264, 412×916, exactly six seconds including idle;
  authenticated/public file retrieval and reuse pass. Partial-note and navigation
  persistence checks pass. Frame image: `screenshots/video-frame.png`.
- Live append and final-ended bytes are covered by `e2e/sharing.e2e.mjs`; the
  60-minute player benchmark remains below its first-frame budget (see bench.md).
- Nothing was pushed or deployed to production.
