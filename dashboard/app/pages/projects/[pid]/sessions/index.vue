<script setup lang="ts">
import type { SessionRow } from "~/utils/types";

const route = useRoute();
const router = useRouter();
const api = useApi();
const pid = computed(() => route.params.pid as string);

const q = route.query;
const range = ref((q.range as string) ?? "14d");
const f = reactive({
  user: (q.user as string) ?? "",
  url: (q.url as string) ?? "",
  release: (q.release as string) ?? "",
  platform: (q.platform as string) ?? "",
  app_version: (q.app_version as string) ?? "",
  browser: (q.browser as string) ?? "",
  os: (q.os as string) ?? "",
  has_error: q.has_error === "true",
  has_ws_disconnect: q.has_ws_disconnect === "true",
  min_duration: (q.min_duration as string) ?? "",
});
const rows = ref<SessionRow[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(false);
const error = ref("");
const tookMs = ref(0);
let requestId = 0;

const RANGES: Record<string, number> = {
  "1h": 3600e3,
  "24h": 86400e3,
  "7d": 7 * 86400e3,
  "14d": 14 * 86400e3,
};

function query(): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    from: Date.now() - (RANGES[range.value] ?? RANGES["14d"]!),
  };
  for (const [k, v] of Object.entries(f))
    if (v !== "" && v !== false) out[k] = v;
  return out;
}

async function load(more = false) {
  const ticket = ++requestId;
  loading.value = true;
  error.value = "";
  const t = performance.now();
  try {
    const params = query();
    if (more && cursor.value) {
      void router.push({ query: { ...route.query, cursor: cursor.value } });
      return;
    }
    if (typeof route.query.cursor === "string")
      params.cursor = route.query.cursor;
    const r = await api.get<{
      sessions: SessionRow[];
      next_cursor: string | null;
    }>(`/projects/${pid.value}/sessions`, { query: params });
    if (ticket !== requestId) return;
    rows.value = r.sessions;
    cursor.value = r.next_cursor;
    tookMs.value = Math.round(performance.now() - t);
  } catch (e) {
    if (ticket === requestId) error.value = errorMessage(e);
  } finally {
    if (ticket === requestId) loading.value = false;
  }
}

function apply() {
  const qs: Record<string, string> = { range: range.value };
  for (const [k, v] of Object.entries(f))
    if (v !== "" && v !== false) qs[k] = String(v);
  if (JSON.stringify(route.query) === JSON.stringify(qs)) load();
  else void router.push({ query: qs });
}

onMounted(() => load());
watch(
  () => route.fullPath,
  () => {
    range.value = String(route.query.range || "14d");
    for (const k of Object.keys(f) as (keyof typeof f)[]) {
      if (k === "has_error" || k === "has_ws_disconnect")
        f[k] = route.query[k] === "true";
      else
        f[k] =
          typeof route.query[k] === "string" ? (route.query[k] as string) : "";
    }
    void load();
  },
);
</script>

<template>
  <div>
    <div class="page-heading">
      <h1 class="text-xl font-semibold">Sessions</h1>
      <p class="muted">
        Explore recorded sessions by user, platform, release, and activity.
      </p>
      <span v-if="tookMs" class="text-xs text-gray-400">{{ tookMs }} ms</span>
    </div>
    <form
      class="filter-bar mb-4 flex flex-wrap items-center gap-2 text-sm"
      @submit.prevent="apply"
    >
      <select
        v-model="range"
        aria-label="range"
        class="rounded border border-gray-300 bg-white px-2 py-1.5"
        @change="apply"
      >
        <option value="1h">Last hour</option>
        <option value="24h">Last 24 h</option>
        <option value="7d">Last 7 days</option>
        <option value="14d">Last 14 days</option>
      </select>
      <input
        v-model="f.user"
        aria-label="User id / email"
        type="search"
        placeholder="User id / email"
        class="w-36 rounded border border-gray-300 px-2 py-1.5"
      >
      <input
        v-model="f.url"
        aria-label="URL contains"
        placeholder="URL contains"
        class="w-40 rounded border border-gray-300 px-2 py-1.5"
      >
      <select
        v-model="f.platform"
        aria-label="platform"
        class="rounded border border-gray-300 bg-white px-2 py-1.5"
        @change="apply"
      >
        <option value="">Web + APK</option>
        <option value="web">Web</option>
        <option value="capacitor-android">APK</option>
      </select>
      <input
        v-model="f.release"
        aria-label="Release"
        placeholder="Release"
        class="w-24 rounded border border-gray-300 px-2 py-1.5"
      >
      <input
        v-model="f.app_version"
        aria-label="App version"
        placeholder="App version"
        class="w-28 rounded border border-gray-300 px-2 py-1.5"
      >
      <input
        v-model="f.browser"
        aria-label="Browser"
        placeholder="Browser"
        class="w-24 rounded border border-gray-300 px-2 py-1.5"
      >
      <input
        v-model="f.os"
        aria-label="OS"
        placeholder="OS"
        class="w-24 rounded border border-gray-300 px-2 py-1.5"
      >
      <input
        v-model="f.min_duration"
        aria-label="Min sec"
        type="number"
        min="0"
        placeholder="Min sec"
        class="w-20 rounded border border-gray-300 px-2 py-1.5"
      >
      <label class="flex items-center gap-1"
        ><input
          v-model="f.has_error"
          aria-label="has error"
          type="checkbox"
          @change="apply"
        >
        Errors</label
      >
      <label class="flex items-center gap-1"
        ><input
          v-model="f.has_ws_disconnect"
          aria-label="has ws disconnect"
          type="checkbox"
          @change="apply"
        >
        WS disconnects</label
      >
      <button class="rounded bg-gray-900 px-3 py-1.5 text-white">Filter</button>
    </form>
    <p v-if="error" class="mb-3 text-sm text-red-600">
      {{ error }}
    </p>
    <UiSkeleton v-if="loading" :rows="3" />
    <UiDataTable label="Sessions">
      <thead class="bg-gray-50 text-left text-gray-500">
        <tr>
          <th class="px-3 py-2 font-medium">Started</th>
          <th class="px-3 py-2 font-medium">Duration</th>
          <th class="px-3 py-2 font-medium">User</th>
          <th class="px-3 py-2 font-medium">Entry</th>
          <th class="px-3 py-2 font-medium">Platform</th>
          <th class="px-3 py-2 font-medium">Browser / OS</th>
          <th class="px-3 py-2 text-right font-medium">Errors</th>
          <th class="px-3 py-2 text-right font-medium">Clicks</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!rows.length && !loading">
          <td colspan="8" class="px-3 py-6 text-center text-gray-500">
            No sessions match.
          </td>
        </tr>
        <tr
          v-for="s in rows"
          :key="s.id"
          class="cursor-pointer border-t border-gray-100 hover:bg-gray-50"
          data-testid="session-row"
          data-row
          tabindex="0"
          @keydown.enter="navigateTo(`/replay/${s.id}?project=${pid}`)"
          @click="navigateTo(`/replay/${s.id}?project=${pid}`)"
        >
          <td
            class="px-3 py-2 whitespace-nowrap"
            :title="dateTime(s.started_at)"
          >
            <span
              v-if="!s.ended"
              class="mr-1 inline-block h-2 w-2 rounded-full bg-green-500"
              title="live"
            />{{ timeAgo(s.started_at) }}
          </td>
          <td class="px-3 py-2 whitespace-nowrap tabular-nums">
            {{ duration(s.duration_ms) }}
          </td>
          <td class="px-3 py-2">
            {{ s.user_id ?? s.user_email ?? "—" }}
          </td>
          <td class="max-w-xs truncate px-3 py-2 text-gray-600">
            {{ shortUrl(s.entry_url) }}
          </td>
          <td class="px-3 py-2 whitespace-nowrap text-gray-600">
            {{ platformLabel(s.platform)
            }}<template v-if="s.device_model"> · {{ s.device_model }} </template
            ><template v-if="s.app_version"> · {{ s.app_version }} </template>
          </td>
          <td class="px-3 py-2 whitespace-nowrap text-gray-600">
            {{ s.browser ?? "" }} {{ s.browser_ver ?? "" }} · {{ s.os ?? "" }}
          </td>
          <td
            class="px-3 py-2 text-right tabular-nums"
            :class="
              s.error_count ? 'font-semibold text-red-600' : 'text-gray-400'
            "
          >
            {{ s.error_count
            }}<span
              v-if="s.ws_disconnects"
              class="ml-1 text-amber-600"
              title="WebSocket disconnects"
              >⚡{{ s.ws_disconnects }}</span
            >
          </td>
          <td class="px-3 py-2 text-right text-gray-600 tabular-nums">
            {{ s.click_count }}
          </td>
        </tr>
      </tbody>
    </UiDataTable>
    <UiButton v-if="route.query.cursor" class="mt-3 mr-2" @click="router.back()"
      >Previous page</UiButton
    >
    <button
      v-if="cursor"
      :disabled="loading"
      class="mt-3 rounded border border-gray-300 bg-white px-3 py-1 text-sm disabled:opacity-40"
      @click="load(true)"
    >
      {{ loading ? "Loading…" : "Next 50 sessions" }}
    </button>
  </div>
</template>
