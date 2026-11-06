# T-66 — Network filters

Network requests now carry `type: "fetch" | "xhr"`, including failed requests. The replay parser preserves this metadata. Authenticated viewer filtering continues to remove headers/bodies and preserves request type.

Method, Status, Type and Slower than dropdowns combine with AND and the existing text search/Failed only. Method includes the common methods and any other recorded method. Status includes 2xx–5xx and no-response failures. Duration thresholds are strictly greater than 500/1000/3000/5000 ms. Clear filters resets the four dropdowns, leaving text and Failed only intact. Legacy/unknown request types are included only when Type is All types. Lists remain virtualized and synchronized to the playhead.

Validation: pure filter tests exercise each condition, combinations, clear state and old recordings. SDK tests assert fetch/XHR metadata; server filtering tests preserve it. The local `network-filters` browser suite exercises the dropdowns, search, Failed only, clear, old requests and opening a request with a real pointer, plus six theme/width views.
