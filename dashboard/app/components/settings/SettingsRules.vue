<script setup lang="ts">
// Fingerprint message-normalization rules (§5.5): regex → replacement, applied before grouping.
import type { Project } from '~/utils/types'

const props = defineProps<{ project: Project }>()
const emit = defineEmits<{ saved: [Project] }>()
const { busy, error, saved, save } = useSave(() => props.project, (p) => emit('saved', p))
const rules = ref(props.project.fingerprint_rules.map((r) => ({ pattern: r.pattern, replace: r.replace ?? '' })))
const bad = computed(() => rules.value.map((r) => {
  try {
    new RegExp(r.pattern)
    return ''
  }
  catch (e) {
    return String((e as Error).message)
  }
}))
function submit() {
  void save({ fingerprint_rules: rules.value.filter((r) => r.pattern).map((r) => (r.replace ? r : { pattern: r.pattern })) })
}
</script>

<template>
  <form
    class="flex flex-col gap-2 text-sm"
    @submit.prevent="submit"
  >
    <p class="text-gray-500">
      Applied to error messages before grouping, after the built-in rules (numbers, UUIDs, MT logins, symbols…).
    </p>
    <div
      v-for="(r, i) in rules"
      :key="i"
      class="flex gap-2"
    >
      <input
        v-model="r.pattern"
        placeholder="regex, e.g. order #\d+"
        class="flex-1 rounded border px-2 py-1 font-mono"
        :class="bad[i] ? 'border-red-400' : 'border-gray-300'"
        :title="bad[i]"
      >
      <input
        v-model="r.replace"
        placeholder="replacement (default <*>)"
        class="w-48 rounded border border-gray-300 px-2 py-1 font-mono"
      >
      <button
        type="button"
        class="text-red-600"
        @click="rules.splice(i, 1)"
      >
        ✕
      </button>
    </div>
    <div class="flex items-center gap-3">
      <button
        type="button"
        class="rounded border border-gray-300 px-3 py-1"
        @click="rules.push({ pattern: '', replace: '' })"
      >
        Add rule
      </button>
      <button
        class="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50"
        :disabled="busy || bad.some(Boolean)"
      >
        Save
      </button>
      <span
        v-if="saved"
        class="text-green-700"
      >Saved</span>
      <span
        v-if="error"
        class="text-red-600"
      >{{ error }}</span>
    </div>
  </form>
</template>
