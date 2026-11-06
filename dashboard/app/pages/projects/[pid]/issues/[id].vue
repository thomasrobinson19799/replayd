<script setup lang="ts">
import type { IssueDetail, IssueEvent } from "~/utils/types";
import { copyStack } from "~/utils/copy-stack";

const route = useRoute();
const api = useApi();
const pid = computed(() => route.params.pid as string);
const id = computed(() => route.params.id as string);

const issue = ref<IssueDetail | null>(null);
const events = ref<IssueEvent[]>([]);
const nextCursor = ref<string | null>(null);
const index = ref(0);
const error = ref("");
const deleting = ref(false);
const deleteOpen = ref(false);
const olderBusy = ref(false);
const eventError = ref("");
const breadcrumbSearch = ref("");
const inAppOnly = ref(true);
const stackText = computed(() => event.value ? copyStack(event.value, inAppOnly.value) : "");
const shareUrl = computed(() => typeof window === "undefined" ? route.fullPath : `${window.location.origin}${route.fullPath}`);
const breadcrumbs = computed(() => [...(event.value?.payload.breadcrumbs ?? [])].reverse().filter(b => `${b.cat} ${b.msg}`.toLowerCase().includes(breadcrumbSearch.value.toLowerCase())));
let request = 0;
async function remove() {
  deleting.value = true;
  try {
    await api.del(`/issues/${id.value}`);
    await navigateTo(`/projects/${pid.value}/issues`);
  } catch (e) {
    error.value = errorMessage(e);
    deleteOpen.value = false;
  } finally {
    deleting.value = false;
  }
}

const event = computed<IssueEvent | null>(
  () => events.value[index.value] ?? issue.value?.latest_event ?? null,
);

async function load() {
  const ticket = ++request;
  error.value = "";
  eventError.value = "";
  olderBusy.value = false;
  breadcrumbSearch.value = "";
  issue.value = null;
  try {
    const [i, ev] = await Promise.all([
      api.get<IssueDetail>(`/issues/${id.value}`),
      api.get<{ events: IssueEvent[]; next_cursor: string | null }>(
        `/issues/${id.value}/events`,
      ),
    ]);
    if (ticket !== request) return;
    issue.value = i;
    events.value = ev.events;
    nextCursor.value = ev.next_cursor;
    index.value = 0;
  } catch (e) {
    if (ticket === request) error.value = errorMessage(e);
  }
}

async function older() {
  if (olderBusy.value) return;
  if (index.value + 1 < events.value.length) {
    index.value++;
    return;
  }
  if (!nextCursor.value) return;
  const ticket = request;
  olderBusy.value = true;
  eventError.value = "";
  try {
    const ev = await api.get<{ events: IssueEvent[]; next_cursor: string | null }>(`/issues/${id.value}/events`, { query: { cursor: nextCursor.value } });
    if (ticket !== request) return;
    events.value.push(...ev.events);
    nextCursor.value = ev.next_cursor;
    if (index.value + 1 < events.value.length) index.value++;
  } catch (e) {
    if (ticket === request) eventError.value = errorMessage(e);
  } finally {
    if (ticket === request) olderBusy.value = false;
  }
}

const tags = computed(() => {
  const e = event.value;
  if (!e) return [];
  const app = e.payload.ctx?.app as Record<string, string> | undefined;
  const rows: [string, string | null | undefined][] = [
    ["platform", e.platform ? platformLabel(e.platform) : null],
    ["release", e.release],
    ["environment", e.environment],
    ["app version", e.app_version],
    ["device", app?.device],
    ["os", e.os],
    ["webview", app?.webview],
    [
      "browser",
      e.browser ? `${e.browser} ${e.payload.browser_ver ?? ""}`.trim() : null,
    ],
    ["user", e.user_id],
    ["url", e.url],
    ...Object.entries(e.payload.tags ?? {}).map(
      ([k, v]) => [k, String(v)] as [string, string],
    ),
  ];
  return rows.filter(([, v]) => v);
});

const http = computed(
  () => event.value?.payload.ctx?.http as Record<string, unknown> | undefined,
);
const ws = computed(
  () => event.value?.payload.ctx?.ws as Record<string, unknown> | undefined,
);
const component = computed(
  () => event.value?.payload.ctx?.component as unknown as string | undefined,
);

// Replay deep link: a couple of seconds before the error (§6.1 "Play replay at this moment").
const replayLink = computed(() =>
  event.value?.session_id
    ? `/replay/${event.value.session_id}?t=${event.value.ts - 2000}&project=${pid.value}`
    : null,
);

onMounted(load);
watch(id, load);
</script>

<template>
  <div class="issue-detail">
  <!-- THESIS: an evidence-first triage workspace, following the owner's Sentry reference.
       OWN-WORLD: semantic dark/light surfaces, indigo actions, compact controls.
       STORY: identify impact, resolve or ignore, inspect an event, jump into its recording.
       FIRST VIEWPORT: issue and impact above actions; stack left, issue context right.
       FORM: owner-selected developer-tool convention; preserve real data and access controls. -->
    <NuxtLink :to="`/projects/${pid}/issues`" class="issue-back">← All issues</NuxtLink>
    <p v-if="error" class="field-error mt-4" role="alert">{{ error }}</p>
    <UiButton v-if="error && !issue" class="mt-3" @click="load">Try again</UiButton>
    <UiSkeleton v-if="!issue && !error" :rows="5" />
    <template v-if="issue">
      <header class="issue-header">
        <div class="min-w-0">
          <div class="issue-label"><UiBadge :tone="issue.level">{{ issue.level }}</UiBadge><span class="font-mono tabular-nums">{{ issue.source }} · Issue #{{ issue.id }}</span></div>
          <h1 data-testid="issue-title">{{ issue.title }}</h1>
          <p class="muted break-words">{{ issue.culprit || 'No culprit recorded' }}</p>
        </div>
        <dl class="issue-impact">
          <div><dt>Events</dt><dd>{{ compact(issue.times_seen) }}</dd></div>
          <div><dt>Users</dt><dd>{{ compact(issue.users_seen) }}</dd></div>
        </dl>
      </header>
      <dl class="issue-header-facts">
        <div><dt>First seen</dt><dd><UiRelativeTime :value="issue.first_seen" /></dd></div>
        <div><dt>Last seen</dt><dd><UiRelativeTime :value="issue.last_seen" /></dd></div>
        <div><dt>First release</dt><dd>{{ issue.first_release || 'Not recorded' }}</dd></div>
        <div><dt>Latest release</dt><dd>{{ issue.last_release || 'Not recorded' }}</dd></div>
        <div><dt>Platforms</dt><dd>{{ Object.keys(issue.platform_split).map(platformLabel).join(', ') || 'Not recorded' }}</dd></div>
      </dl>
      <div class="issue-workflow">
        <div class="issue-workflow-main">
        <IssueStatusBar :issue="issue" :can-change="issue.can_change_status" @updated="u => issue && Object.assign(issue, u)" />
        <NuxtLink v-if="replayLink" :to="replayLink" class="ui-button" data-testid="header-play-replay">Play replay</NuxtLink>
        <UiCopyButton v-if="event" :text="stackText" label="Copy stack" />
        </div>
        <UiDropdown label="More"><UiCopyButton :text="shareUrl" label="Copy link" /><UiButton v-if="issue.can_delete" variant="danger" @click="deleteOpen = true">Delete issue</UiButton></UiDropdown>
      </div>
      <div class="issue-columns">
        <section v-if="event" class="issue-evidence" aria-label="Event details">
          <header class="event-toolbar">
            <div><h2>Event details</h2><p class="muted text-xs mt-1">{{ dateTime(event.ts) }}</p></div>
            <div class="flex flex-wrap gap-2"><UiButton :disabled="index === 0 || olderBusy" @click="index--">Newer</UiButton><UiButton :disabled="index + 1 >= events.length && !nextCursor" :busy="olderBusy" @click="older">Older</UiButton></div>
          </header>
          <p v-if="eventError" class="field-error px-5 py-3" role="alert">{{ eventError }}</p>
          <div class="event-context-strip">
            <span v-if="event.user_id">User <strong>{{ event.user_id }}</strong></span>
            <span v-if="event.browser">{{ event.browser }}</span><span v-if="event.os">{{ event.os }}</span>
            <UiBadge v-if="event.platform">{{ platformLabel(event.platform) }}</UiBadge>
            <UiBadge v-if="event.environment">{{ event.environment }}</UiBadge>
          </div>
          <div v-if="replayLink" class="event-replay-link">
            <div><strong>See what happened</strong><p class="muted text-xs">Open the recording just before this event.</p></div>
            <NuxtLink :to="replayLink" class="ui-button ui-button--primary" data-testid="play-replay">▶ Play replay at this moment</NuxtLink>
          </div>
          <details class="evidence-section" open>
            <summary><h2>Stack trace</h2><span class="muted text-xs">{{ event.payload.frames?.length || 0 }} {{ event.payload.frames?.length === 1 ? 'frame' : 'frames' }}</span></summary>
            <div class="evidence-content">
              <p class="event-message">{{ event.payload.type ? `${event.payload.type}: ` : '' }}{{ event.payload.message }}</p>
              <p v-if="http" class="code-block mb-4">{{ http.method }} {{ http.url }} → {{ http.status }} ({{ http.ms }} ms)</p>
              <p v-if="ws" class="code-block mb-4">{{ ws.url }} closed with code {{ ws.code }} after {{ ws.reconnects ?? 0 }} reconnects</p>
              <p v-if="component" class="muted text-xs mb-3">Component: <code>{{ component }}</code></p>
              <StackTrace v-model:in-app-only="inAppOnly" :frames="event.payload.frames ?? []" :raw="event.payload.stack" />
            </div>
          </details>
          <details class="evidence-section" open>
            <summary><h2>Breadcrumbs</h2><span class="muted text-xs">{{ event.payload.breadcrumbs?.length || 0 }} recorded</span></summary>
            <div class="evidence-content">
              <UiInput v-model="breadcrumbSearch" type="search" label="Search breadcrumbs" placeholder="Search message or category" class="mb-4" />
              <ol class="breadcrumb-list">
                <li v-for="(b,i) in breadcrumbs" :key="i" class="breadcrumb-entry"><UiBadge>{{ b.cat }}</UiBadge><span class="break-all">{{ b.msg }}</span><span class="muted">{{ b.ts > 1e12 ? new Date(b.ts).toLocaleTimeString('en-GB') : `${b.ts} ms` }}</span></li>
                <li v-if="!breadcrumbs.length" class="muted p-4">{{ breadcrumbSearch ? 'No breadcrumbs match.' : 'No breadcrumbs.' }}</li>
              </ol>
            </div>
          </details>
        </section>
        <UiEmptyState v-else title="No retained events" description="This issue's event details have expired under the project's retention policy." />
        <aside class="issue-sidebar" aria-label="Issue context">
          <section><h2>Issue overview</h2><dl class="issue-facts">
            <div><dt>Last seen</dt><dd><UiRelativeTime :value="issue.last_seen" /><small v-if="issue.last_release">{{ issue.last_release }}</small></dd></div>
            <div><dt>First seen</dt><dd><UiRelativeTime :value="issue.first_seen" /><small v-if="issue.first_release">{{ issue.first_release }}</small></dd></div>
          </dl></section>
          <section><h2>Platforms</h2><dl class="platform-breakdown"><div v-for="(n,p) in issue.platform_split" :key="p"><dt>{{ platformLabel(String(p)) }}</dt><dd>{{ compact(n) }}</dd></div></dl></section>
          <section><h2>Tags &amp; context</h2><dl class="issue-tags"><div v-for="[k,v] in tags" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></div></dl></section>
        </aside>
      </div>
    </template>
    <UiConfirmDialog v-model="deleteOpen" title="Delete issue?" description="This permanently removes the issue and its stored events. New occurrences can create a new issue." action="Delete issue" :busy="deleting" @confirm="remove" />
  </div>
</template>
