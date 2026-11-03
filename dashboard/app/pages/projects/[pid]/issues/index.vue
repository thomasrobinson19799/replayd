<script setup lang="ts">
import type { Issue, StatusChange } from '~/utils/types'
import { ignoreActions, reopenAction, resolveAction, resolveNextAction } from '~/utils/status'

const route = useRoute()
const router = useRouter()
const api = useApi()
const pid = computed(() => route.params.pid as string)

// filters live in the URL so views are shareable
const q = computed(() => route.query)
const filters = reactive({
  status: (q.value.status as string) ?? 'unresolved',
  level: (q.value.level as string) ?? '',
  source: (q.value.source as string) ?? '',
  platform: (q.value.platform as string) ?? '',
  release: (q.value.release as string) ?? '',
  q: (q.value.q as string) ?? '',
  sort: (q.value.sort as string) ?? 'last_seen',
})
const page = ref(Number(q.value.page ?? 0))
const issues = ref<Issue[]>([])
const hasMore = ref(false)
const loading = ref(true)
const error = ref('')
const now = ref(Date.now())

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    const query: Record<string, string | number> = { page: page.value }
    for (const [k, v] of Object.entries(filters)) if (v) query[k] = v
    const r = await api.get<{ issues: Issue[], has_more: boolean }>(`/projects/${pid.value}/issues`, { query })
    issues.value = r.issues
    hasMore.value = r.has_more
    error.value = ''
    now.value = Date.now()
  }
  catch (e) {
    error.value = errorMessage(e)
  }
  finally {
    loading.value = false
  }
}

// bulk status changes (T-31)
const selected = ref(new Set<number>())
const allSelected = computed(() => issues.value.length > 0 && issues.value.every((i) => selected.value.has(i.id)))
function toggle(id: number) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(issues.value.map((i) => i.id))
}
const bulkActions = computed(() => [resolveAction, resolveNextAction, ignoreActions()[0]!, reopenAction])
const bulkBusy = ref(false)
async function bulk(change: StatusChange) {
  bulkBusy.value = true
  try {
    await api.patch(`/issues`, { ids: [...selected.value], ...change })
    selected.value = new Set()
    await load(true)
  }
  catch (e) {
    error.value = errorMessage(e)
  }
  finally {
    bulkBusy.value = false
  }
}

function apply() {
  page.value = 0
  const query: Record<string, string> = {}
  for (const [k, v] of Object.entries(filters)) if (v) query[k] = v
  router.replace({ query })
  load()
}

function go(delta: number) {
  page.value = Math.max(0, page.value + delta)
  load()
}

// new issues show up without a reload (the pipeline flushes every second)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  load()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') load(true)
  }, 2000)
})
onBeforeUnmount(() => clearInterval(timer))
watch(pid, () => apply())
</script>

<template>
  <div>
    <h1 class="mb-4 text-xl font-semibold">
      Issues
    </h1>
    <form
      class="mb-4 flex flex-wrap items-center gap-2 text-sm"
      @submit.prevent="apply"
    >
      <select
        v-model="filters.status"
        name="status"
        class="rounded border border-gray-300 bg-white px-2 py-1.5"
        @change="apply"
      >
        <option value="unresolved">
          Unresolved
        </option>
        <option value="resolved">
          Resolved
        </option>
        <option value="ignored">
          Ignored
        </option>
        <option value="all">
          All
        </option>
      </select>
      <select
        v-model="filters.level"
        class="rounded border border-gray-300 bg-white px-2 py-1.5"
        @change="apply"
      >
        <option value="">
          Any level
        </option>
        <option value="error">
          Errors
        </option>
        <option value="warning">
          Warnings
        </option>
      </select>
      <select
        v-model="filters.source"
        class="rounded border border-gray-300 bg-white px-2 py-1.5"
        @change="apply"
      >
        <option value="">
          Any source
        </option>
        <option
          v-for="s in ['onerror', 'unhandledrejection', 'console', 'http', 'ws', 'vue', 'react', 'manual']"
          :key="s"
          :value="s"
        >
          {{ s }}
        </option>
      </select>
      <select
        v-model="filters.platform"
        class="rounded border border-gray-300 bg-white px-2 py-1.5"
        @change="apply"
      >
        <option value="">
          Web + APK
        </option>
        <option value="web">
          Web
        </option>
        <option value="capacitor-android">
          APK
        </option>
      </select>
      <input
        v-model="filters.release"
        placeholder="Release"
        class="w-28 rounded border border-gray-300 px-2 py-1.5"
      >
      <input
        v-model="filters.q"
        placeholder="Search title or culprit"
        class="min-w-48 flex-1 rounded border border-gray-300 px-2 py-1.5"
      >
      <select
        v-model="filters.sort"
        class="rounded border border-gray-300 bg-white px-2 py-1.5"
        @change="apply"
      >
        <option value="last_seen">
          Last seen
        </option>
        <option value="first_seen">
          First seen
        </option>
        <option value="times_seen">
          Events
        </option>
        <option value="users_seen">
          Users
        </option>
      </select>
      <button class="rounded bg-gray-900 px-3 py-1.5 text-white">
        Filter
      </button>
    </form>

    <p
      v-if="error"
      class="mb-3 text-sm text-red-600"
    >
      {{ error }}
    </p>
    <div
      v-if="selected.size"
      class="mb-2 flex flex-wrap items-center gap-2 text-sm"
      data-testid="bulk-bar"
    >
      <span class="text-gray-600">{{ selected.size }} selected</span>
      <button
        v-for="a in bulkActions"
        :key="a.key"
        class="rounded border border-gray-300 bg-white px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
        :disabled="bulkBusy"
        :data-testid="`bulk-${a.key}`"
        @click="bulk(a.change)"
      >
        {{ a.label }}
      </button>
    </div>
    <div class="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-left text-gray-500">
          <tr>
            <th class="w-8 py-2 pl-4">
              <input
                type="checkbox"
                :checked="allSelected"
                aria-label="Select all"
                @change="toggleAll"
              >
            </th>
            <th class="px-4 py-2 font-medium">
              Issue
            </th>
            <th class="w-28 px-2 py-2 font-medium">
              Last seen
            </th>
            <th class="w-28 px-2 py-2 font-medium">
              First seen
            </th>
            <th class="w-20 px-2 py-2 text-right font-medium">
              Events
            </th>
            <th class="w-20 px-2 py-2 text-right font-medium">
              Users
            </th>
            <th class="w-28 px-4 py-2 font-medium">
              Platform
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading && !issues.length">
            <td
              colspan="7"
              class="px-4 py-6 text-center text-gray-500"
            >
              Loading…
            </td>
          </tr>
          <tr v-else-if="!issues.length">
            <td
              colspan="7"
              class="px-4 py-6 text-center text-gray-500"
            >
              No issues match.
            </td>
          </tr>
          <tr
            v-for="i in issues"
            :key="i.id"
            class="border-t border-gray-100 hover:bg-gray-50"
            data-testid="issue-row"
          >
            <td class="py-2 pl-4">
              <input
                type="checkbox"
                :checked="selected.has(i.id)"
                :aria-label="`Select ${i.title}`"
                data-testid="issue-select"
                @change="toggle(i.id)"
              >
            </td>
            <td class="px-4 py-2">
              <NuxtLink
                :to="`/projects/${pid}/issues/${i.id}`"
                class="block"
              >
                <span
                  class="mr-2 inline-block h-2 w-2 rounded-full"
                  :class="i.level === 'error' ? 'bg-red-500' : 'bg-amber-400'"
                />
                <span class="font-medium hover:underline">{{ i.title }}</span>
                <span class="block truncate pl-4 text-xs text-gray-500">
                  {{ i.culprit ?? '' }} · {{ i.source }}<template v-if="i.last_release"> · {{ i.last_release }}</template>
                </span>
              </NuxtLink>
            </td>
            <td
              class="px-2 py-2 text-gray-600"
              :title="dateTime(i.last_seen)"
            >
              {{ timeAgo(i.last_seen, now) }}
            </td>
            <td
              class="px-2 py-2 text-gray-600"
              :title="dateTime(i.first_seen)"
            >
              {{ timeAgo(i.first_seen, now) }}
            </td>
            <td class="px-2 py-2 text-right tabular-nums">
              {{ compact(i.times_seen) }}
            </td>
            <td class="px-2 py-2 text-right tabular-nums">
              {{ compact(i.users_seen) }}
            </td>
            <td class="px-4 py-2 text-gray-600">
              {{ i.platforms.map(platformLabel).join(' + ') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="mt-3 flex gap-2 text-sm">
      <button
        :disabled="page === 0"
        class="rounded border border-gray-300 bg-white px-3 py-1 disabled:opacity-40"
        @click="go(-1)"
      >
        Previous
      </button>
      <button
        :disabled="!hasMore"
        class="rounded border border-gray-300 bg-white px-3 py-1 disabled:opacity-40"
        @click="go(1)"
      >
        Next
      </button>
    </div>
  </div>
</template>
