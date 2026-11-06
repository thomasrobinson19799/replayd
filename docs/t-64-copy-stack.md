# T-64 — Copy stack

The issue's Copy stack action produces plain text with the error type/message, visible frames, symbolicated locations and source context when available, raw stack fallback, release/environment/platform/browser/device/URL, existing HTTP/WebSocket/component context, and the **last 30 breadcrumbs**. It shares the in-app toggle with the displayed stack. Identity properties, custom fields, tags, breadcrumb data and arbitrary context are excluded by an explicit formatter allowlist.

Validation: formatter tests cover symbolication/context, both toggle states, raw fallback, the breadcrumb bound and excluded sentinel values. The local `issue-header` browser suite uses the real clipboard, checks the visible-frame toggle and source context, and verifies excluded properties stay out. The action's final placement is covered by T-65.
