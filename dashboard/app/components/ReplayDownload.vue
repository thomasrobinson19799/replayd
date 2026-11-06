<script setup lang="ts">
const props = defineProps<{ endpoint: string }>()
const api = useApi()
const config = useRuntimeConfig()
const result = ref<{ state: string; progress?: number; partial?: boolean; covered_until?: number }>({ state: 'none' })
const error = ref('')
const busy = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
async function refresh() {
  try { result.value = await api.get(`${props.endpoint}/video`); error.value = '' }
  catch { error.value = 'Video status unavailable. Retrying…' }
  if (!disposed) timer = setTimeout(refresh, 5000)
}
async function start(latest = false) {
  busy.value = true; error.value = ''
  try { result.value = await api.post(`${props.endpoint}/video`, { latest }) }
  catch (e) { error.value = errorMessage(e) }
  finally { busy.value = false }
}
onMounted(refresh)
onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
</script>
<template>
  <div class="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
    <a v-if="result.state === 'ready'" class="btn" :href="`${config.public.apiBase}${endpoint}/video/download`" download>Download MP4</a>
    <span v-else-if="result.state === 'queued'">Video queued…</span>
    <span v-else-if="result.state === 'rendering'">Rendering video · {{ result.progress ?? 0 }}%</span>
    <UiButton v-else :disabled="busy" @click="start()">{{ result.state === 'failed' ? 'Retry MP4 render' : 'Download MP4' }}</UiButton>
    <template v-if="result.state === 'ready' && result.partial">
      <span>This video covers the session through {{ dateTime(result.covered_until!) }}.</span>
      <UiButton :disabled="busy" @click="start(true)">Render latest</UiButton>
    </template>
    <span v-if="result.state === 'failed'">Video rendering failed. You can try again.</span>
    <span v-if="error" role="alert">{{ error }}</span>
  </div>
</template>
