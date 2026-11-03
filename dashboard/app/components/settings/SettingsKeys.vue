<script setup lang="ts">
import type { Project } from '~/utils/types'

const props = defineProps<{ project: Project }>()
const emit = defineEmits<{ saved: [] }>()
const api = useApi()
const shown = ref<string | null>(null)
const error = ref('')
async function rotate(kind: 'public' | 'upload') {
  if (!confirm(kind === 'public' ? 'Rotate the public key? Apps with the old DSN stop sending.' : 'Rotate the upload token? CI must use the new one.')) return
  try {
    const r = await api.post<{ upload_token?: string }>(`/projects/${props.project.id}/keys/rotate`, { kind })
    shown.value = r.upload_token ?? null
    emit('saved')
  }
  catch (e) {
    error.value = errorMessage(e)
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 text-sm">
    <div>
      <div class="text-gray-500">
        DSN
      </div>
      <code
        class="block rounded bg-gray-100 px-2 py-1 break-all"
        data-testid="dsn"
      >{{ project.dsn }}</code>
    </div>
    <div class="flex gap-2">
      <button
        class="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50"
        @click="rotate('public')"
      >
        Rotate public key
      </button>
      <button
        class="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50"
        @click="rotate('upload')"
      >
        Rotate upload token
      </button>
    </div>
    <p
      v-if="shown"
      class="rounded border border-amber-300 bg-amber-50 p-2"
    >
      New upload token (shown once): <code class="break-all">{{ shown }}</code>
    </p>
    <p
      v-if="error"
      class="text-red-600"
    >
      {{ error }}
    </p>
  </div>
</template>
