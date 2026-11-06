<script setup lang="ts">
import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";
import type { SessionDetail } from "~/utils/types";
import type { DecodeConfig, DecodeMsg, DecodeStart } from "~/workers/decode";
import {
  clock,
  collect,
  emptyPanels,
  lastAtOrBefore,
  prettyFrame,
  sortPanels,
  wsChannels,
  wsConnections,
  wsFilter,
  type NetworkItem,
  type Marker,
  type Panels,
  type RrEvent,
  type WsItem,
} from "~/utils/replay";

const route = useRoute();
const props = defineProps<{ sid?: string; shareToken?: string }>();
const api = useApi();
const config = useRuntimeConfig();
const sid = computed(() => props.sid ?? "");
const publicView = computed(() => !!props.shareToken);
const endpoint = computed(() => publicView.value ? `/public/shares/${encodeURIComponent(props.shareToken!)}` : `/sessions/${sid.value}`);
const shareOpen = ref(false);

const session = ref<SessionDetail | null>(null);
const error = ref("");
const status = ref("Loading…");
const playing = ref(false);
const speed = ref(1);
const skipInactive = ref(true);
const follow = ref(true);
const panelSearch = ref("");
const failedOnly = ref(false);
const networkSel = ref<NetworkItem | null>(null);
const detailOpen = ref(false);
const preview = ref("");
const fullscreenRoot = ref<HTMLElement | null>(null);
const deleteOpen = ref(false);
const deleting = ref(false);
async function removeSession() {
  deleting.value = true;
  try {
    await api.del(`/sessions/${sid.value}`);
    await navigateTo(`/projects/${session.value?.project_slug}/sessions`);
  } catch (e) {
    error.value = errorMessage(e);
    deleteOpen.value = false;
  } finally {
    deleting.value = false;
  }
}
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await fullscreenRoot.value?.requestFullscreen();
    await nextTick();
    fit();
  } catch {
    error.value = "Fullscreen is unavailable in this browser.";
  }
}
function inspectNetwork(item: NetworkItem) {
  seekTo(item.ts);
  networkSel.value = item;
  detailOpen.value = true;
}
function hoverTimeline(e: MouseEvent) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const ts = startTs.value + ((e.clientX - box.left) / box.width) * total.value;
  const index = lastAtOrBefore(markers.value, ts);
  preview.value = `${clock(ts - startTs.value)} · ${index < 0 ? "Session start" : markers.value[index]!.label}`;
}
const startTs = ref(0);
const endTs = ref(0);
const cur = ref(0); // absolute ms of the playhead
const panels = shallowRef<Panels>(emptyPanels());
const panelsVersion = ref(0);
const tab = ref<"console" | "network" | "ws" | "errors" | "crumbs" | "device">(
  "console",
);
// WebSocket tab filters (PRD §6.2: connections with lifecycle; frames by channel, direction filter, search)
const ws = reactive({
  conn: null as number | null,
  channel: "",
  dir: "" as "" | "in" | "out",
  q: "",
});
const wsSel = ref<WsItem | null>(null);
const loaded = reactive({
  frames: 0,
  bytes: 0,
  total: null as number | null,
  done: false,
});

const stage = ref<HTMLElement | null>(null);
const host = ref<HTMLElement | null>(null);
let replayer: Replayer | null = null;
let worker: Worker | null = null;
let pending: RrEvent[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let liveTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
async function followRecording() {
  if (disposed || session.value?.ended) return;
  try {
    const latest = await api.get<SessionDetail>(endpoint.value);
    if (disposed) return;
    session.value = latest;
    endTs.value = Math.max(endTs.value, latest.last_at);
    worker?.postMessage({ type: "poll" });
  } catch {
    error.value = publicView.value ? "This share link is unavailable or has expired." : "Live updates unavailable. Reload to retry.";
    return;
  }
  if (!disposed && !session.value?.ended) liveTimer = setTimeout(followRecording, 5000);
}
const scale = ref(1);

const total = computed(() => Math.max(0, endTs.value - startTs.value));
const offset = computed(() => Math.max(0, cur.value - startTs.value));

function fit() {
  if (!replayer || !stage.value) return;
  const w = replayer.wrapper;
  const iframe = replayer.iframe;
  const vw = Number(iframe.width) || iframe.clientWidth;
  const vh = Number(iframe.height) || iframe.clientHeight;
  if (!vw || !vh) return;
  stage.value.style.height = `${Math.min((stage.value.clientWidth * vh) / vw, window.innerHeight * 0.6)}px`;
  const s = Math.min(
    stage.value.clientWidth / vw,
    stage.value.clientHeight / vh,
    1,
  );
  scale.value = s;
  w.style.transform = `scale(${s})`;
  w.style.transformOrigin = "top left";
}

function seekTo(abs: number) {
  if (!replayer) return;
  const t = Math.min(Math.max(0, abs - startTs.value), total.value);
  if (playing.value) replayer.play(t);
  else replayer.pause(t);
  cur.value = startTs.value + t;
}

function toggle() {
  if (!replayer) return;
  if (playing.value) {
    replayer.pause();
    playing.value = false;
  } else {
    const t = offset.value >= total.value - 50 ? 0 : offset.value;
    replayer.play(t);
    playing.value = true;
  }
}

watch(speed, (s) => replayer?.setConfig({ speed: s }));
watch(skipInactive, (v) => replayer?.setConfig({ skipInactive: v }));

function startReplayer(events: RrEvent[]) {
  if (!host.value) return;
  events.sort((a, b) => a.timestamp - b.timestamp);
  startTs.value = events[0]!.timestamp;
  replayer = new Replayer(events as never, {
    root: host.value,
    speed: speed.value,
    skipInactive: skipInactive.value,
    showWarning: false,
    showDebug: false,
    mouseTail: false,
    triggerFocus: false,
    UNSAFE_replayCanvas: false,
    insertStyleRules: [],
  });
  replayer.on("fullsnapshot-rebuilded", () => {
    const w = window as unknown as {
      __rpFirstFrameMs?: number;
      __rpFirstFrameLoad?: unknown;
    };
    if (w.__rpFirstFrameMs === undefined) {
      w.__rpFirstFrameMs = Math.round(performance.now());
      w.__rpFirstFrameLoad = { ...loaded };
    }
    fit();
  });
  replayer.on("resize", () => nextTick(fit));
  replayer.on("finish", () => {
    playing.value = false;
  });
  const t = Number(route.query.t);
  if (Number.isFinite(t) && t > startTs.value) {
    replayer.play(t - startTs.value);
  } else {
    replayer.play(0);
  }
  playing.value = true;
  status.value = "";
  timer = setInterval(() => {
    if (!replayer) return;
    cur.value = startTs.value + replayer.getCurrentTime();
  }, 100);
}

function onFrame(m: Extract<DecodeMsg, { type: "frame" }>) {
  loaded.frames++;
  const evs = m.events as RrEvent[];
  endTs.value = Math.max(
    endTs.value,
    m.t1,
    ...evs.slice(-1).map((e) => e.timestamp),
  );
  const p = panels.value;
  collect(evs, p);
  if (m.flags & 1)
    p.markers.push({ ts: m.t0, kind: "gap", label: "segment gap" });
  sortPanels(p);
  panelsVersion.value++;
  if (replayer) {
    for (const e of evs) replayer.addEvent(e as never);
    return;
  }
  pending.push(...evs);
  // playback can start as soon as we have meta + a full snapshot
  if (pending.some((e) => e.type === 2) && pending.some((e) => e.type === 4)) {
    const evsAll = pending;
    pending = [];
    startReplayer(evsAll);
  }
}

function startWorker() {
  worker = new Worker(new URL("../workers/decode.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (ev: MessageEvent<DecodeMsg>) => {
    const m = ev.data;
    if (m.type === "frame") onFrame(m);
    else if (m.type === "progress") {
      loaded.bytes = m.bytes;
      loaded.total = m.total;
    } else if (m.type === "done") {
      loaded.done = true;
      (window as unknown as { __rpDoneMs?: number }).__rpDoneMs = Math.round(
        performance.now(),
      );
      if (!replayer)
        status.value = pending.length
          ? "Recording has no full snapshot yet."
          : "No replay data for this session.";
    } else if (m.type === "error") {
      status.value = "";
      error.value = m.message.includes("404")
        ? "No replay recorded for this session."
        : m.message;
    }
  };
  // the download starts in parallel with the session API call; decoding waits for the asset config
  const start: DecodeStart = {
    url: new URL(
      `${config.public.apiBase}${endpoint.value}/recording`,
      location.origin,
    ).toString(),
  };
  worker.postMessage(start);
}

async function load() {
  startWorker();
  try {
    session.value = await api.get<SessionDetail>(endpoint.value);
    const s = session.value;
    startTs.value = s.started_at;
    endTs.value = s.last_at;
    for (const e of s.errors) {
      panels.value.markers.push({
        ts: e.ts,
        kind: e.level === "warning" ? "warning" : "error",
        label: e.title,
      });
    }
    const cfg: DecodeConfig = {
      rewriteFrom: [...(s.asset_rewrite_from ?? [])], // plain array: reactive proxies cannot be cloned
      assetBase: s.asset_base_url,
    };
    worker?.postMessage(cfg);
    if (!s.ended) liveTimer = setTimeout(followRecording, 5000);
  } catch (e) {
    worker?.terminate();
    status.value = "";
    error.value = publicView.value ? "This share link is unavailable or has expired." : errorMessage(e);
  }
}

// side panel indices synced to the playhead
const idx = computed(() => {
  void panelsVersion.value;
  const p = lists.value;
  const t = cur.value;
  return {
    console: lastAtOrBefore(p.console, t),
    network: lastAtOrBefore(p.network, t),
    errors: lastAtOrBefore(p.errors, t),
    crumbs: lastAtOrBefore(p.crumbs, t),
  };
});
const lists = computed(() => {
  void panelsVersion.value;
  const p = panels.value;
  const q = panelSearch.value.toLowerCase();
  return {
    ...p,
    console: p.console.filter(
      (x) => !q || `${x.level} ${x.text}`.toLowerCase().includes(q),
    ),
    network: p.network.filter(
      (x) =>
        (!failedOnly.value || x.status >= 400 || x.status === 0) &&
        (!q || `${x.method} ${x.url} ${x.status}`.toLowerCase().includes(q)),
    ),
    errors: p.errors.filter((x) => !q || x.title.toLowerCase().includes(q)),
    crumbs: p.crumbs.filter(
      (x) => !q || `${x.cat} ${x.msg}`.toLowerCase().includes(q),
    ),
  };
});
const wsConns = computed(() => {
  void panelsVersion.value;
  return wsConnections(panels.value.ws);
});
const wsChans = computed(() => {
  void panelsVersion.value;
  return wsChannels(panels.value.ws);
});
const wsList = computed(() => {
  void panelsVersion.value;
  return wsFilter(panels.value.ws, ws);
});
const wsIdx = computed(() => lastAtOrBefore(wsList.value, cur.value));
const wsLabel = (it: WsItem) =>
  it.k === "frame"
    ? it.binary
      ? `[binary ${it.size ?? 0} B]`
      : it.data.redacted
        ? `[hidden · ${Number(it.data.len ?? 0)} chars]`
        : (it.raw ?? "")
    : `${it.k}${it.code != null ? ` ${it.code}` : ""} ${it.url ?? ""}`;
const markers = computed<Marker[]>(() => {
  void panelsVersion.value;
  return panels.value.markers.slice().sort((a, b) => a.ts - b.ts);
});
// Cap timeline DOM independently of recording duration; the panel lists retain every item.
const timelineMarkers = computed(() => {
  const bins = new Map<string, Marker>();
  for (const m of markers.value) {
    const key = `${m.kind}:${Math.floor(((m.ts - startTs.value) / Math.max(1, total.value)) * 200)}`;
    if (!bins.has(key)) bins.set(key, m);
  }
  return [...bins.values()];
});
const markerColor: Record<string, string> = {
  error: "bg-red-500",
  warning: "bg-amber-400",
  ws: "bg-purple-500",
  nav: "bg-sky-400",
  app: "bg-emerald-500",
  gap: "bg-gray-500",
};

function onScrub(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  seekTo(startTs.value + ((e.clientX - r.left) / r.width) * total.value);
}

const consoleColor = (l: string) =>
  l === "error"
    ? "text-red-600"
    : l === "warn"
      ? "text-amber-600"
      : "text-gray-700";

onMounted(() => {
  // read-only probe for the e2e player benchmark (e2e/player.e2e.mjs)
  (window as unknown as { __rpPlayer?: unknown }).__rpPlayer = {
    loaded,
    time: () => replayer?.getCurrentTime() ?? -1,
  };
  load();
  window.addEventListener("resize", fit);
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(liveTimer);
  clearInterval(timer);
  worker?.terminate();
  replayer?.destroy();
  window.removeEventListener("resize", fit);
});
</script>

<template>
  <div ref="fullscreenRoot" class="flex flex-col gap-3 bg-gray-50">
    <div v-if="!publicView" class="flex flex-wrap items-baseline gap-3 text-sm">
      <NuxtLink
        v-if="session"
        :to="`/projects/${session.project_slug}/sessions`"
        class="text-gray-500 hover:underline"
      >
        ← Sessions
      </NuxtLink>
      <UiButton
        v-if="session?.can_delete && session.ended"
        variant="danger"
        @click="deleteOpen = true"
        >Delete session</UiButton
      >
      <h1 class="text-lg font-semibold">Replay</h1>
      <UiButton v-if="session" @click="shareOpen = true">Share</UiButton>
      <template v-if="session">
        <span class="text-gray-600">{{
          session.user_id ?? session.user_email ?? "anonymous"
        }}</span>
        <span class="text-gray-500"
          >{{ dateTime(session.started_at) }} ·
          {{ duration(session.duration_ms) }} ·
          {{ platformLabel(session.platform) }}</span
        >
        <span v-if="!loaded.done && loaded.bytes" class="text-xs text-gray-400"
          >loading {{ Math.round(loaded.bytes / 1024) }} KB<template
            v-if="loaded.total"
          >
            / {{ Math.round(loaded.total / 1024) }} KB</template
          ></span
        >
      </template>
    </div>
    <p v-if="error" class="text-sm text-red-600">
      {{ error }}
    </p>
    <ReplayDownload v-if="session" :endpoint="endpoint" />

    <div class="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div class="flex min-w-0 flex-col gap-2">
        <div
          ref="stage"
          class="relative h-[60vh] overflow-hidden rounded border border-gray-200 bg-gray-100"
          data-testid="replay-stage"
        >
          <div ref="host" class="replayer-host" />
          <p
            v-if="status"
            class="absolute inset-0 flex items-center justify-center text-sm text-gray-500"
          >
            {{ status }}
          </p>
        </div>

        <!-- timeline with markers -->
        <div
          class="relative h-6 cursor-pointer rounded bg-gray-200"
          data-testid="timeline"
          tabindex="0"
          role="slider"
          aria-label="Replay timeline"
          :aria-valuemin="0"
          :aria-valuemax="total"
          :aria-valuenow="offset"
          :aria-valuetext="clock(offset)"
          @keydown.right.prevent="seekTo(cur + 5000)"
          @keydown.left.prevent="seekTo(cur - 5000)"
          @keydown.home.prevent="seekTo(startTs)"
          @keydown.end.prevent="seekTo(endTs)"
          @mousemove="hoverTimeline"
          @mouseleave="preview = ''"
          @click="onScrub"
        >
          <div
            class="absolute inset-y-0 left-0 rounded bg-gray-400/60"
            :style="{ width: `${total ? (offset / total) * 100 : 0}%` }"
          />
          <span
            v-for="(m, i) in timelineMarkers"
            :key="i"
            class="absolute top-0 h-6 w-1 -translate-x-1/2 rounded"
            :class="markerColor[m.kind]"
            :style="{
              left: `${total ? Math.min(100, Math.max(0, ((m.ts - startTs) / total) * 100)) : 0}%`,
            }"
            :title="`${clock(m.ts - startTs)} ${m.label}`"
            @click.stop="seekTo(m.ts - 1000)"
          />
        </div>
        <p class="marker-preview">
          {{
            preview ||
            "Hover the timeline for context. Use arrow keys to seek five seconds."
          }}
        </p>
        <div class="player-controls text-sm">
          <button
            class="w-20 rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-40"
            :disabled="!startTs"
            data-testid="play-toggle"
            @click="toggle"
          >
            {{ playing ? "Pause" : "Play" }}
          </button>
          <span class="tabular-nums"
            >{{ clock(offset) }} / {{ clock(total) }}</span
          >
          <select
            v-model.number="speed"
            aria-label="Playback speed"
            class="rounded border border-gray-300 bg-white px-1 py-0.5"
          >
            <option v-for="s in [1, 2, 4, 8]" :key="s" :value="s">
              {{ s }}×
            </option>
          </select>
          <label class="flex items-center gap-1"
            ><input v-model="skipInactive" type="checkbox" > Skip
            inactivity</label
          >
          <UiButton @click="fullscreen">Fullscreen</UiButton>
          <span class="ml-auto flex flex-wrap gap-2 text-xs text-gray-500">
            <span
              ><i class="inline-block h-2 w-2 rounded-full bg-red-500" />
              error</span
            >
            <span
              ><i class="inline-block h-2 w-2 rounded-full bg-amber-400" />
              warning</span
            >
            <span
              ><i class="inline-block h-2 w-2 rounded-full bg-purple-500" />
              WS</span
            >
            <span
              ><i class="inline-block h-2 w-2 rounded-full bg-sky-400" />
              nav</span
            >
            <span
              ><i class="inline-block h-2 w-2 rounded-full bg-emerald-500" />
              app</span
            >
            <span
              ><i class="inline-block h-2 w-2 rounded-full bg-gray-500" />
              gap</span
            >
          </span>
        </div>
      </div>

      <aside
        class="player-panel flex h-[calc(60vh+4.5rem)] flex-col rounded border border-gray-200 bg-white text-xs"
      >
        <p
          v-if="session && !session.can_view_sensitive"
          class="border-b border-amber-200 bg-amber-50 px-2 py-1 text-amber-800"
          data-testid="viewer-notice"
        >
          Viewer role: network headers/bodies and WebSocket frame contents are
          removed by the server.
        </p>
        <nav
          class="flex border-b border-gray-200"
          role="tablist"
          aria-label="Replay inspection"
        >
          <button
            v-for="t in [
              'console',
              'network',
              'ws',
              'errors',
              'crumbs',
              'device',
            ] as const"
            :key="t"
            role="tab"
            :aria-selected="tab === t"
            class="flex-1 px-2 py-2 capitalize"
            :class="
              tab === t
                ? 'border-b-2 border-gray-900 font-semibold'
                : 'text-gray-500'
            "
            @keydown.right.prevent="
              ($event.currentTarget as HTMLElement).nextElementSibling &&
              (
                ($event.currentTarget as HTMLElement)
                  .nextElementSibling as HTMLElement
              ).focus()
            "
            @keydown.left.prevent="
              ($event.currentTarget as HTMLElement).previousElementSibling &&
              (
                ($event.currentTarget as HTMLElement)
                  .previousElementSibling as HTMLElement
              ).focus()
            "
            @click="tab = t"
          >
            {{ t === "crumbs" ? "Breadcrumbs" : t === "ws" ? "WS" : t }}
            <span v-if="t !== 'device'" class="text-gray-400">{{
              lists[t].length
            }}</span>
          </button>
        </nav>
        <div class="p-3 flex flex-wrap gap-2 border-b border-gray-200">
          <input
            v-if="tab !== 'ws'"
            v-model="panelSearch"
            type="search"
            aria-label="Search inspection panel"
            placeholder="Search this panel…"
            class="w-full"
          >
          <label class="flex items-center gap-2"
            ><input v-model="follow" type="checkbox" >Follow playhead</label
          >
          <label v-if="tab === 'network'" class="flex items-center gap-2"
            ><input v-model="failedOnly" type="checkbox" >Failed only</label
          >
        </div>
        <div class="min-h-0 flex-1" role="tabpanel" :aria-label="tab">
          <VirtualList
            v-if="tab === 'console'"
            :items="lists.console"
            :active-index="idx.console"
            :follow="follow"
          >
            <template #default="{ item, index }">
              <div
                class="flex cursor-pointer gap-2 truncate border-b border-gray-50 px-2 leading-6"
                :class="[
                  consoleColor(item.level),
                  index > idx.console ? 'bg-gray-50' : '',
                ]"
                :title="item.text"
                role="button"
                tabindex="0"
                @keydown.enter="seekTo(item.ts)"
                @keydown.space.prevent="seekTo(item.ts)"
                @click="seekTo(item.ts)"
              >
                <span class="w-10 shrink-0 text-gray-400">{{
                  clock(item.ts - startTs)
                }}</span>
                <span class="truncate font-mono">{{ item.text }}</span>
              </div>
            </template>
          </VirtualList>
          <VirtualList
            v-else-if="tab === 'network'"
            :items="lists.network"
            :active-index="idx.network"
            :follow="follow"
          >
            <template #default="{ item, index }">
              <div
                class="flex cursor-pointer gap-2 border-b border-gray-50 px-2 leading-6"
                :class="index > idx.network ? 'bg-gray-50' : ''"
                :title="item.url"
                role="button"
                tabindex="0"
                @keydown.enter="inspectNetwork(item)"
                @keydown.space.prevent="inspectNetwork(item)"
                @click="inspectNetwork(item)"
              >
                <span class="w-10 shrink-0 text-gray-400">{{
                  clock(item.ts - startTs)
                }}</span>
                <span class="w-10 shrink-0 font-semibold">{{
                  item.method
                }}</span>
                <span
                  class="w-8 shrink-0"
                  :class="
                    item.status >= 400 || item.status === 0
                      ? 'text-red-600'
                      : 'text-green-700'
                  "
                  >{{ item.status || "ERR" }}</span
                >
                <span class="flex-1 truncate font-mono">{{
                  shortUrl(item.url)
                }}</span>
                <span class="shrink-0 text-gray-400"
                  >{{ item.duration }} ms</span
                >
              </div>
            </template>
          </VirtualList>
          <div
            v-else-if="tab === 'ws'"
            class="flex h-full flex-col"
            data-testid="ws-tab"
          >
            <div class="max-h-28 overflow-auto border-b border-gray-100">
              <button
                v-for="c in wsConns"
                :key="c.id"
                class="flex w-full gap-2 truncate px-2 text-left leading-6"
                :class="ws.conn === c.id ? 'bg-gray-100 font-semibold' : ''"
                :title="c.url"
                data-testid="ws-conn"
                @click="ws.conn = ws.conn === c.id ? null : c.id"
              >
                <span class="w-6 shrink-0 text-gray-400">#{{ c.id }}</span>
                <span class="flex-1 truncate font-mono">{{
                  shortUrl(c.url)
                }}</span>
                <span class="shrink-0 text-gray-500">{{ c.frames }} fr</span>
                <span
                  v-if="c.closed"
                  class="shrink-0"
                  :class="
                    c.code === 1000 || c.code === 1001
                      ? 'text-gray-500'
                      : 'text-red-600'
                  "
                  >closed {{ c.code }}</span
                >
                <span v-else-if="c.opened" class="shrink-0 text-green-700"
                  >open</span
                >
              </button>
            </div>
            <div class="flex gap-1 border-b border-gray-100 p-1">
              <select
                v-model="ws.channel"
                aria-label="WebSocket channel"
                class="min-w-0 flex-1 rounded border border-gray-300 bg-white px-1"
                data-testid="ws-channel"
              >
                <option value="">all channels</option>
                <option v-for="[c, n] in wsChans" :key="c" :value="c">
                  {{ c }} ({{ n }})
                </option>
              </select>
              <select
                v-model="ws.dir"
                aria-label="Frame direction"
                class="rounded border border-gray-300 bg-white px-1"
                data-testid="ws-dir"
              >
                <option value="">in + out</option>
                <option value="in">in</option>
                <option value="out">out</option>
              </select>
              <input
                v-model="ws.q"
                aria-label="Search WebSocket frames"
                placeholder="search"
                class="w-24 rounded border border-gray-300 px-1"
                data-testid="ws-search"
              >
            </div>
            <div class="min-h-0 flex-1">
              <VirtualList
                :items="wsList"
                :active-index="wsIdx"
                :follow="follow"
              >
                <template #default="{ item, index }">
                  <div
                    class="flex cursor-pointer gap-2 truncate border-b border-gray-50 px-2 leading-6"
                    :class="[
                      index > wsIdx ? 'bg-gray-50' : '',
                      item.k === 'frame' ? '' : 'font-semibold',
                      item.k === 'close' &&
                      item.code !== 1000 &&
                      item.code !== 1001
                        ? 'text-red-600'
                        : '',
                    ]"
                    data-testid="ws-row"
                    role="button"
                    tabindex="0"
                    @keydown.enter="
                      seekTo(item.ts);
                      wsSel = item;
                    "
                    @keydown.space.prevent="
                      seekTo(item.ts);
                      wsSel = item;
                    "
                    @click="
                      seekTo(item.ts);
                      wsSel = item;
                    "
                  >
                    <span class="w-10 shrink-0 text-gray-400">{{
                      clock(item.ts - startTs)
                    }}</span>
                    <span
                      class="w-4 shrink-0"
                      :class="
                        item.dir === 'out' ? 'text-sky-600' : 'text-emerald-700'
                      "
                      >{{
                        item.k === "frame"
                          ? item.dir === "out"
                            ? "↑"
                            : "↓"
                          : "•"
                      }}</span
                    >
                    <span class="w-24 shrink-0 truncate text-gray-500">{{
                      item.ch.join(", ")
                    }}</span>
                    <span class="truncate font-mono">{{ wsLabel(item) }}</span>
                  </div>
                </template>
              </VirtualList>
            </div>
            <pre
              v-if="wsSel?.raw"
              class="max-h-48 overflow-auto border-t border-gray-200 bg-gray-50 p-3 font-mono text-xs"
              data-testid="ws-detail"
              >{{ prettyFrame(wsSel.raw) }}</pre
            >
          </div>
          <VirtualList
            v-else-if="tab === 'errors'"
            :items="lists.errors"
            :active-index="idx.errors"
            :follow="follow"
          >
            <template #default="{ item, index }">
              <div
                class="flex cursor-pointer gap-2 truncate border-b border-gray-50 px-2 leading-6"
                :class="[
                  item.level === 'warning' ? 'text-amber-700' : 'text-red-600',
                  index > idx.errors ? 'bg-gray-50' : '',
                ]"
                :title="item.title"
                role="button"
                tabindex="0"
                @keydown.enter="seekTo(item.ts - 1000)"
                @keydown.space.prevent="seekTo(item.ts - 1000)"
                @click="seekTo(item.ts - 1000)"
              >
                <span class="w-10 shrink-0 text-gray-400">{{
                  clock(item.ts - startTs)
                }}</span>
                <span class="truncate">{{ item.title }}</span>
              </div>
            </template>
          </VirtualList>
          <VirtualList
            v-else-if="tab === 'crumbs'"
            :items="lists.crumbs"
            :active-index="idx.crumbs"
            :follow="follow"
          >
            <template #default="{ item, index }">
              <div
                class="flex cursor-pointer gap-2 truncate border-b border-gray-50 px-2 leading-6"
                :class="index > idx.crumbs ? 'bg-gray-50' : ''"
                :title="item.msg"
                role="button"
                tabindex="0"
                @keydown.enter="seekTo(item.ts)"
                @keydown.space.prevent="seekTo(item.ts)"
                @click="seekTo(item.ts)"
              >
                <span class="w-10 shrink-0 text-gray-400">{{
                  clock(item.ts - startTs)
                }}</span>
                <span class="w-14 shrink-0 text-gray-500">{{ item.cat }}</span>
                <span class="truncate">{{ item.msg }}</span>
              </div>
            </template>
          </VirtualList>
          <dl v-else-if="session" class="divide-y divide-gray-100">
            <div
              v-for="[k, v] in (
                [
                  ['platform', platformLabel(session.platform)],
                  ['app version', session.app_version],
                  ['device', session.device_model],
                  ['android', session.os_version],
                  ['webview', session.webview_version],
                  [
                    'browser',
                    `${session.browser ?? ''} ${session.browser_ver ?? ''}`,
                  ],
                  ['os', session.os],
                  [
                    'viewport',
                    session.vw ? `${session.vw}×${session.vh}` : null,
                  ],
                  ['language', session.lang],
                  ['release', session.release],
                  ['environment', session.environment],
                  ['user', session.user_id ?? session.user_email],
                  ['entry', session.entry_url],
                  ['segments', session.segments],
                  ['size', `${Math.round(session.bytes / 1024)} KB`],
                  ['ws disconnects', session.ws_disconnects],
                  ['gaps', session.has_gap ? 'yes' : 'no'],
                  ['session id', session.id],
                ] as [string, unknown][]
              ).filter(
                ([k, v]) =>
                  v !== null &&
                  v !== undefined &&
                  String(v).trim() !== '' &&
                  `${k} ${v}`.toLowerCase().includes(panelSearch.toLowerCase()),
              )"
              :key="k"
              class="flex gap-3 px-3 py-1.5"
            >
              <dt class="w-24 shrink-0 text-gray-500">
                {{ k }}
              </dt>
              <dd class="break-all">
                {{ v }}
              </dd>
            </div>
          </dl>
        </div>
      </aside>
    </div>
    <UiModal v-model="detailOpen" title="Network request">
      <NetworkDetail v-if="networkSel" :item="networkSel" />
    </UiModal>
    <ReplayShareDialog v-if="!publicView && session" v-model="shareOpen" :sid="sid" />
    <UiConfirmDialog
      v-model="deleteOpen"
      title="Delete session?"
      description="The recording will be permanently removed. Issue events remain available."
      action="Delete session"
      :busy="deleting"
      @confirm="removeSession"
    />
  </div>
</template>

<style>
.replayer-host .replayer-wrapper {
  position: absolute;
  top: 0;
  left: 0;
}
.replayer-host iframe {
  border: 0;
  background: white;
}
</style>
