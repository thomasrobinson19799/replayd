<script setup lang="ts">
import type { Project } from '~/utils/types'
const props = defineProps<{ project: Project }>()
const api = useApi()
type Rule = { id: number; kind: string; match_type: string; pattern: string; dropped_count: number; last_matched_at: number | null }
const rules = ref<Rule[]>([])
const form = reactive({ kind: 'error', match_type: 'contains', pattern: '' })
const dirty = inject<Ref<boolean> | null>('settings-dirty', null)
let baseline = JSON.stringify(form)
watch(() => JSON.stringify(form), value => { if (dirty) dirty.value = value !== baseline })
const editing = ref<number | null>(null)
const busy = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const base = computed(() => `/projects/${props.project.id}/ignore-rules`)
async function load() { try { rules.value = (await api.get<{ rules: Rule[] }>(base.value)).rules } catch (e) { error.value = errorMessage(e) } }
function reset() { editing.value = null; Object.assign(form, { kind: 'error', match_type: 'contains', pattern: '' }); baseline = JSON.stringify(form); if (dirty) dirty.value = false }
function edit(r: Rule) { editing.value = r.id; Object.assign(form, { kind: r.kind, match_type: r.match_type, pattern: r.pattern }); baseline = JSON.stringify(form); if (dirty) dirty.value = false }
async function save() {
  busy.value = true; error.value = ''
  try {
    if (editing.value === null) await api.post(base.value, { ...form })
    else await api.request(`${base.value}/${editing.value}`, { method: 'PUT', body: { ...form } })
    reset(); await load()
  } catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
}
async function remove(id: number) {
  busy.value = true; error.value = ''
  try { await api.del(`${base.value}/${id}`); if (editing.value === id) reset(); await load() }
  catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
}
async function refresh() { await load(); if (!disposed) timer = setTimeout(refresh, 30000) }
onMounted(refresh)
onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
</script>
<template>
  <section class="grid gap-3">
    <p>Drop matching new events before issues and alerts. Recordings and session counts remain unchanged. Up to 50 rules per project.</p>
    <form class="grid gap-3" @submit.prevent="save">
      <div class="flex flex-wrap gap-3">
        <label class="grid gap-1">Kind<select v-model="form.kind" aria-label="Rule kind"><option value="error">Error</option><option value="console">Console</option><option value="network">Network (including WebSocket)</option></select></label>
        <label class="grid gap-1">Match<select v-model="form.match_type" aria-label="Rule match"><option value="contains">Contains (case-insensitive)</option><option value="regex">Regular expression</option></select></label>
      </div>
      <label class="grid gap-1">{{ form.kind === 'network' ? 'URL pattern' : 'Message pattern' }}<input v-model="form.pattern" required maxlength="1024" aria-label="Rule pattern"></label>
      <div class="flex gap-2"><UiButton type="submit" variant="primary" :disabled="busy || (editing === null && rules.length >= 50)">{{ editing === null ? 'Add rule' : 'Save rule' }}</UiButton><UiButton v-if="editing !== null" type="button" @click="reset">Cancel</UiButton></div>
    </form>
    <p v-if="error" role="alert" class="field-error">{{ error }}</p>
    <p v-if="!rules.length && !busy">No ignore rules.</p>
    <ul class="grid gap-3">
      <li v-for="r in rules" :key="r.id" class="card grid gap-2">
        <p>{{ r.kind }} · {{ r.match_type }} · <code class="break-all">{{ r.pattern }}</code></p>
        <p class="muted">{{ r.dropped_count }} dropped · Last match: {{ r.last_matched_at ? dateTime(r.last_matched_at) : 'Never' }}</p>
        <div class="flex gap-2"><UiButton :disabled="busy" @click="edit(r)">Edit</UiButton><UiButton :disabled="busy" @click="remove(r.id)">Delete</UiButton></div>
      </li>
    </ul>
  </section>
</template>
