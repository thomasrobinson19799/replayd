<script setup lang="ts">
import type { IssueDetail, IssueEvent } from '~/utils/types'

const route = useRoute()
const api = useApi()
const pid = computed(() => route.params.pid as string)
const id = computed(() => route.params.id as string)

const issue = ref<IssueDetail | null>(null)
const events = ref<IssueEvent[]>([])
const nextCursor = ref<string | null>(null)
const index = ref(0)
const error = ref('')

const event = computed<IssueEvent | null>(() => events.value[index.value] ?? issue.value?.latest_event ?? null)

async function load() {
  try {
    const [i, ev] = await Promise.all([
      api.get<IssueDetail>(`/issues/${id.value}`),
      api.get<{ events: IssueEvent[], next_cursor: string | null }>(`/issues/${id.value}/events`),
    ])
    issue.value = i
    events.value = ev.events
    nextCursor.value = ev.next_cursor
    index.value = 0
  }
  catch (e) {
    error.value = errorMessage(e)
  }
}

async function older() {
  if (index.value + 1 < events.value.length) {
    index.value++
    return
  }
  if (!nextCursor.value) return
  const ev = await api.get<{ events: IssueEvent[], next_cursor: string | null }>(
    `/issues/${id.value}/events`, { query: { cursor: nextCursor.value } })
  events.value.push(...ev.events)
  nextCursor.value = ev.next_cursor
  if (index.value + 1 < events.value.length) index.value++
}

const tags = computed(() => {
  const e = event.value
  if (!e) return []
  const app = e.payload.ctx?.app as Record<string, string> | undefined
  const rows: [string, string | null | undefined][] = [
    ['platform', e.platform ? platformLabel(e.platform) : null],
    ['release', e.release],
    ['environment', e.environment],
    ['app version', e.app_version],
    ['device', app?.device],
    ['os', e.os],
    ['webview', app?.webview],
    ['browser', e.browser ? `${e.browser} ${e.payload.browser_ver ?? ''}`.trim() : null],
    ['user', e.user_id],
    ['url', e.url],
    ...Object.entries(e.payload.tags ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
  ]
  return rows.filter(([, v]) => v)
})

const http = computed(() => event.value?.payload.ctx?.http as Record<string, unknown> | undefined)
const ws = computed(() => event.value?.payload.ctx?.ws as Record<string, unknown> | undefined)
const component = computed(() => event.value?.payload.ctx?.component as unknown as string | undefined)

// Replay deep link: a couple of seconds before the error (§6.1 "Play replay at this moment").
const replayLink = computed(() =>
  event.value?.session_id ? `/replay/${event.value.session_id}?t=${event.value.ts - 2000}&project=${pid.value}` : null,
)

onMounted(load)
watch(id, load)
</script>

<template>
  <div>
    <NuxtLink
      :to="`/projects/${pid}/issues`"
      class="text-sm text-gray-500 hover:underline"
    >
      ← Issues
    </NuxtLink>
    <p
      v-if="error"
      class="mt-4 text-sm text-red-600"
    >
      {{ error }}
    </p>
    <template v-if="issue">
      <div class="mt-2 flex flex-wrap items-start gap-4">
        <div class="min-w-0 flex-1">
          <h1
            class="text-xl font-semibold break-words"
            data-testid="issue-title"
          >
            <span
              class="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
              :class="issue.level === 'error' ? 'bg-red-500' : 'bg-amber-400'"
            />{{ issue.title }}
          </h1>
          <p class="mt-1 text-sm text-gray-600">
            {{ issue.culprit }} · {{ issue.source }}
          </p>
          <IssueStatusBar
            class="mt-2"
            :issue="issue"
            :can-change="issue.can_change_status"
            @updated="(u) => issue && Object.assign(issue, u)"
          />
        </div>
        <dl class="grid grid-cols-4 gap-x-6 text-sm">
          <dt class="text-gray-500">
            Events
          </dt>
          <dt class="text-gray-500">
            Users
          </dt>
          <dt class="text-gray-500">
            First seen
          </dt>
          <dt class="text-gray-500">
            Last seen
          </dt>
          <dd class="font-semibold tabular-nums">
            {{ compact(issue.times_seen) }}
          </dd>
          <dd class="font-semibold tabular-nums">
            {{ compact(issue.users_seen) }}
          </dd>
          <dd :title="dateTime(issue.first_seen)">
            {{ timeAgo(issue.first_seen) }}<span
              v-if="issue.first_release"
              class="text-gray-500"
            > · {{ issue.first_release }}</span>
          </dd>
          <dd :title="dateTime(issue.last_seen)">
            {{ timeAgo(issue.last_seen) }}<span
              v-if="issue.last_release"
              class="text-gray-500"
            > · {{ issue.last_release }}</span>
          </dd>
        </dl>
      </div>

      <div class="mt-3 flex flex-wrap gap-2 text-xs">
        <span
          v-for="(n, p) in issue.platform_split"
          :key="p"
          class="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700"
        >{{ platformLabel(String(p)) }}: {{ compact(n) }}</span>
      </div>

      <section
        v-if="event"
        class="mt-6 grid gap-6 lg:grid-cols-3"
      >
        <div class="lg:col-span-2">
          <div class="mb-3 flex items-center gap-3 text-sm">
            <h2 class="font-semibold">
              Event
            </h2>
            <span class="text-gray-500">{{ dateTime(event.ts) }}</span>
            <button
              class="rounded border border-gray-300 bg-white px-2 py-0.5 disabled:opacity-40"
              :disabled="index === 0"
              @click="index--"
            >
              Newer
            </button>
            <button
              class="rounded border border-gray-300 bg-white px-2 py-0.5 disabled:opacity-40"
              :disabled="index + 1 >= events.length && !nextCursor"
              @click="older"
            >
              Older
            </button>
            <NuxtLink
              v-if="replayLink"
              :to="replayLink"
              class="ml-auto rounded bg-gray-900 px-3 py-1 text-white hover:bg-gray-700"
              data-testid="play-replay"
            >
              ▶ Play replay at this moment
            </NuxtLink>
          </div>
          <p class="mb-3 rounded bg-gray-100 px-3 py-2 font-mono text-sm break-words">
            {{ event.payload.type ? `${event.payload.type}: ` : '' }}{{ event.payload.message }}
          </p>
          <div
            v-if="http"
            class="mb-3 rounded border border-gray-200 bg-white px-3 py-2 font-mono text-xs"
          >
            {{ http.method }} {{ http.url }} → {{ http.status }} <span class="text-gray-500">({{ http.ms }} ms)</span>
          </div>
          <div
            v-if="ws"
            class="mb-3 rounded border border-gray-200 bg-white px-3 py-2 font-mono text-xs"
          >
            {{ ws.url }} closed with code {{ ws.code }} after {{ ws.reconnects ?? 0 }} reconnects
          </div>
          <p
            v-if="component"
            class="mb-3 text-xs text-gray-600"
          >
            Component: <code>{{ component }}</code>
          </p>
          <StackTrace
            :frames="event.payload.frames ?? []"
            :raw="event.payload.stack"
          />

          <h2 class="mt-6 mb-2 font-semibold">
            Breadcrumbs
          </h2>
          <ol class="divide-y divide-gray-100 rounded border border-gray-200 bg-white text-xs">
            <li
              v-for="(b, i) in [...(event.payload.breadcrumbs ?? [])].reverse()"
              :key="i"
              class="flex gap-3 px-3 py-1.5"
            >
              <span class="w-16 shrink-0 text-gray-500">{{ b.cat }}</span>
              <span class="flex-1 break-all">{{ b.msg }}</span>
              <span class="shrink-0 text-gray-400">{{ b.ts > 1e12 ? new Date(b.ts).toLocaleTimeString('en-GB') : `${b.ts} ms` }}</span>
            </li>
            <li
              v-if="!event.payload.breadcrumbs?.length"
              class="px-3 py-1.5 text-gray-500"
            >
              No breadcrumbs.
            </li>
          </ol>
        </div>
        <aside>
          <h2 class="mb-2 font-semibold">
            Tags
          </h2>
          <dl class="divide-y divide-gray-100 rounded border border-gray-200 bg-white text-xs">
            <div
              v-for="[k, v] in tags"
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
        </aside>
      </section>
    </template>
  </div>
</template>
