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

async function apply(change: StatusChange) {
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
        <div class="relative">
          <button
            class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
            :disabled="busy"
            data-testid="action-ignore"
            @click="open = !open"
          >
            Ignore ▾
          </button>
          <div
            v-if="open"
            class="absolute z-10 mt-1 w-60 rounded border border-gray-200 bg-white py-1 shadow"
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
  </div>
</template>
