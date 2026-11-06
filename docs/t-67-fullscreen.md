# T-67 — Fullscreen

Reproduced before editing on installed desktop Chrome and Edge, authenticated and public players at 1920×1080: the 412×915 recording stayed at about 291×646, the inspection panel remained inside fullscreen, and the button never changed to Exit fullscreen. Controls were visible in this fixture; a separate missing-controls failure was not reproduced. Headless Escape did not exit the old implementation. Measurements are in `fullscreen-before.json`.

Fullscreen now targets only the replay, timeline and playback controls. The stage uses the remaining screen area and centers the recording with proportional scaling and bars. `fullscreenchange` updates state and sizing after browser exits; Escape also exits explicitly when handled by the page. Normal-view sizing remains capped as before. Inspection and other dialogs are outside the fullscreen subtree; playback controls do not open dialogs.

The `fullscreen` browser suite passes in both browsers and both player modes: the portrait recording grows to about 430×954, controls remain within the 1080 px screen, play/pause and pointer timeline seeking work, and both Escape and the exit button restore the prior 291×646 normal view and button state. See `fullscreen-after.json` and `screenshots/fullscreen-{before,after}-*.png`. No production deployment.
