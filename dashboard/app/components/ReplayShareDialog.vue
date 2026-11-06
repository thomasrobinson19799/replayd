<script setup lang="ts">
const props = defineProps<{ sid: string }>()
const open = defineModel<boolean>({ default: false })
const api = useApi()
const expiry = ref('24h')
const expiryId = useId()
const links = ref<{ id: string; creator: string; expires_at: number }[]>([])
const url = ref('')
const busy = ref(false)
const error = ref('')
async function load() {
  const data = await api.get<{ links: typeof links.value }>(`/sessions/${props.sid}/shares`)
  links.value = data.links
}
watch(open, async (v) => {
  url.value = ''
  error.value = ''
  if (v) {
    busy.value = true
    try { await load() } catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
  }
})
async function create() {
  busy.value = true
  error.value = ''
  try {
    const data = await api.post<{ url: string }>(`/sessions/${props.sid}/shares`, { expiry: expiry.value })
    url.value = data.url
    await load()
  } catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
}
async function revoke(id: string) {
  busy.value = true
  error.value = ''
  try { await api.del(`/sessions/${props.sid}/shares/${id}`); await load() }
  catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
}
</script>
<template>
  <UiModal v-model="open" title="Share replay">
    <div class="grid gap-3 p-4">
      <p>Anyone with a link can see this recording and all its network and WebSocket data.</p>
      <div class="grid gap-1"><label :for="expiryId">Expires</label>
        <select :id="expiryId" v-model="expiry">
          <option value="1h">1 hour</option><option value="24h">24 hours</option>
          <option value="7d">7 days</option><option value="retention">Until retention</option>
        </select>
      </div>
      <p class="text-sm text-muted-foreground">Links never outlive the recording. Save the new URL now; it cannot be recovered later.</p>
      <UiButton :disabled="busy" variant="primary" @click="create">Create link</UiButton>
      <div v-if="url" class="grid gap-2">
        <label class="grid gap-1">New share link<input :value="url" readonly @focus="($event.target as HTMLInputElement).select()"></label>
        <UiCopyButton :text="url" label="Copy share link" />
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <h3>Active links</h3>
      <p v-if="busy" role="status">Updating links…</p>
      <p v-else-if="!links.length">No active links.</p>
      <ul class="grid gap-2">
        <li v-for="link in links" :key="link.id" class="flex flex-wrap items-center justify-between gap-2">
          <span>{{ link.creator }} · Expires {{ dateTime(link.expires_at) }}</span>
          <UiButton :disabled="busy" @click="revoke(link.id)">Revoke</UiButton>
        </li>
      </ul>
    </div>
  </UiModal>
</template>
