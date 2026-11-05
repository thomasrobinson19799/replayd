<script setup lang="ts">
// Status controls for one issue (T-31): resolve / resolve in next release / ignore (forever, until a time, until
// N more events) / reopen. Hidden for viewers (`can_change_status`).
import type { Issue, StatusChange } from '~/utils/types'
import { ignoreActions, reopenAction, resolveAction, resolveNextAction, statusText } from '~/utils/status'

const props = defineProps<{ issue: Issue, canChange: boolean }>()
const emit = defineEmits<{ updated: [Issue] }>()
const api = useApi()
const busy = ref(false)
const err = ref('')
const open = ref(false)
const ignoreRoot = ref<HTMLElement | null>(null)
const ignoreTrigger = ref<HTMLButtonElement | null>(null)
function closeIgnore() { open.value = false; ignoreTrigger.value?.focus() }
function outside(e: PointerEvent) {
  if (ignoreRoot.value && !ignoreRoot.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
const customOpen = ref(false)
const customKind = ref('date')
const customDate = ref('')
const customCount = ref('10')
const customError = ref('')
async function customIgnore() {
  customError.value = ''
  const until = new Date(customDate.value).getTime()
  const count = Number(customCount.value)
  if (customKind.value === 'date' && (!Number.isFinite(until) || until <= Date.now())) { customError.value = 'Choose a future date and time.'; return }
  if (customKind.value === 'count' && (!Number.isInteger(count) || count < 1 || count > 1000000000)) { customError.value = 'Enter a whole number between 1 and 1,000,000,000.'; return }
  await apply(customKind.value === 'date' ? { status: 'ignored', ignore_until: until } : { status: 'ignored', ignore_count: count })
  if (!err.value) customOpen.value = false
}

async function apply(change: StatusChange) {
  if (busy.value) return
  busy.value = true
  err.value = ''
  open.value = false
  try {
    emit('updated', await api.patch<Issue>(`/issues/${props.issue.id}`, change))
  }
  catch (e) {
    err.value = errorMessage(e)
  }
  finally {
    busy.value = false
  }
}
const text = computed(() => statusText(props.issue, dateTime))
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-2 text-sm"
    data-testid="issue-status"
  >
    <span
      class="rounded px-2 py-0.5"
      :class="issue.status === 'resolved' ? 'bg-green-100 text-green-800' : issue.status === 'ignored' ? 'bg-gray-100 text-gray-700' : issue.regressed_at ? 'bg-red-100 text-red-800' : 'bg-amber-50 text-amber-800'"
      data-testid="issue-status-text"
    >{{ text }}</span>
    <template v-if="canChange">
      <template v-if="issue.status === 'unresolved'">
        <button
          class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
          :disabled="busy"
          data-testid="action-resolve"
          @click="apply(resolveAction.change)"
        >
          {{ resolveAction.label }}
        </button>
        <button
          class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
          :disabled="busy || !issue.last_release"
          :title="issue.last_release ? `Reopen only for releases other than ${issue.last_release}` : 'No release on this issue'"
          data-testid="action-resolve-next"
          @click="apply(resolveNextAction.change)"
        >
          {{ resolveNextAction.label }}
        </button>
        <div ref="ignoreRoot" class="relative ignore-control" :class="{ 'ignore-control--open': open }" @keydown.esc.stop="closeIgnore">
          <button
            ref="ignoreTrigger"
            class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
            :disabled="busy"
            data-testid="action-ignore"
            :aria-expanded="open"
            :aria-controls="`ignore-actions-${issue.id}`"
            @click="open = !open"
          >
            Ignore ▾
          </button>
          <div
            v-if="open"
            :id="`ignore-actions-${issue.id}`"
            class="ignore-menu absolute z-10 mt-1 w-60 rounded border border-gray-200 bg-white py-1 shadow"
            role="group"
            aria-label="Ignore options"
          >
            <button
              v-for="a in ignoreActions()"
              :key="a.key"
              class="block w-full px-3 py-1 text-left hover:bg-gray-50"
              :data-testid="`action-${a.key}`"
              @click="apply(a.change)"
            >
              {{ a.label }}
            </button>
            <button class="block w-full px-3 py-2 text-left hover:bg-gray-50" @click="open = false; customOpen = true">Custom date or event count…</button>
          </div>
        </div>
      </template>
      <button
        v-else
        class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
        :disabled="busy"
        data-testid="action-reopen"
        @click="apply(reopenAction.change)"
      >
        {{ reopenAction.label }}
      </button>
    </template>
    <span
      v-if="err"
      class="text-red-600"
    >{{ err }}</span>
    <UiModal v-model="customOpen" title="Ignore issue"><form class="stack" @submit.prevent="customIgnore"><UiSelect v-model="customKind" label="Ignore until"><option value="date">A date and time</option><option value="count">More events arrive</option></UiSelect><UiInput v-if="customKind === 'date'" v-model="customDate" label="Date and time (local)" type="datetime-local" required /><UiInput v-else v-model="customCount" label="Additional events" type="number" min="1" max="1000000000" required /><p v-if="customError || err" role="alert" class="field-error">{{ customError || err }}</p><UiButton type="submit" variant="primary" :busy="busy">Ignore issue</UiButton></form></UiModal>
  </div>
</template>
