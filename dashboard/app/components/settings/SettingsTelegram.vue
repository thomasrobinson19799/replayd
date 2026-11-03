<script setup lang="ts">
// Telegram alerts per project (PRD §5.7, T-32). The bot token comes back masked ("***"); saving "***" keeps it.
import type { Project } from '~/utils/types'

const props = defineProps<{ project: Project }>()
const emit = defineEmits<{ saved: [Project] }>()
const { busy, error, saved, save } = useSave(() => props.project, (p) => emit('saved', p))
const api = useApi()
const t = (props.project.telegram ?? {}) as Record<string, unknown>
const f = reactive({
  enabled: t.enabled !== false,
  bot_token: String(t.bot_token ?? ''),
  chat_id: String(t.chat_id ?? ''),
  new_issue: t.new_issue !== false,
  regression: t.regression !== false,
  spike: t.spike !== false,
  warnings: t.warnings === true,
  spike_threshold: Number(t.spike_threshold ?? 50),
  spike_minutes: Number(t.spike_minutes ?? 5),
})
const testMsg = ref('')
function submit() {
  void save({ telegram: f.bot_token || f.chat_id ? { ...f } : null })
}
async function test() {
  testMsg.value = ''
  try {
    await api.post(`/projects/${props.project.id}/telegram/test`)
    testMsg.value = 'Test message sent.'
  }
  catch (e) {
    testMsg.value = errorMessage(e)
  }
}
</script>

<template>
  <form
    class="flex flex-col gap-3 text-sm"
    data-testid="telegram-form"
    @submit.prevent="submit"
  >
    <label class="flex items-center gap-2"><input
      v-model="f.enabled"
      type="checkbox"
    > Alerts enabled</label>
    <label class="flex flex-col gap-1">Bot token
      <input
        v-model="f.bot_token"
        autocomplete="off"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
        placeholder="123456:ABC…"
      >
    </label>
    <label class="flex flex-col gap-1">Chat id
      <input
        v-model="f.chat_id"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
        placeholder="-1001234567890"
      >
    </label>
    <fieldset class="flex flex-wrap gap-4">
      <label class="flex items-center gap-1"><input
        v-model="f.new_issue"
        type="checkbox"
      > New issues</label>
      <label class="flex items-center gap-1"><input
        v-model="f.warnings"
        type="checkbox"
      > …including warnings</label>
      <label class="flex items-center gap-1"><input
        v-model="f.regression"
        type="checkbox"
      > Regressions</label>
      <label class="flex items-center gap-1"><input
        v-model="f.spike"
        type="checkbox"
      > Spikes</label>
    </fieldset>
    <div class="flex items-center gap-2">
      Spike: ≥
      <input
        v-model.number="f.spike_threshold"
        type="number"
        min="1"
        class="w-20 rounded border border-gray-300 px-1"
      > events in
      <input
        v-model.number="f.spike_minutes"
        type="number"
        min="1"
        max="60"
        class="w-16 rounded border border-gray-300 px-1"
      > min
    </div>
    <p class="text-gray-500">
      One alert per issue and kind per 30 min, at most 20 messages per minute per chat.
    </p>
    <div class="flex items-center gap-3">
      <button
        class="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50"
        :disabled="busy"
      >
        Save
      </button>
      <button
        type="button"
        class="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50"
        @click="test"
      >
        Send test message
      </button>
      <span
        v-if="saved"
        class="text-green-700"
      >Saved</span>
      <span
        v-if="error || testMsg"
        :class="error ? 'text-red-600' : 'text-gray-700'"
      >{{ error || testMsg }}</span>
    </div>
  </form>
</template>
