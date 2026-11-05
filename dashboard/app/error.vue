<script setup lang="ts">
import type { NuxtError } from '#app'
const props = defineProps<{ error: NuxtError }>()
const missing = computed(() => props.error.statusCode === 404)
const busy = ref(false)
useColorTheme()
async function recover() {
  if (busy.value) return
  busy.value = true
  await clearError({ redirect: '/' })
}
useHead({ title: computed(() => `${missing.value ? 'Page not found' : 'Something went wrong'} · replayd`) })
</script>
<template>
  <main class="error-page">
    <a href="/" class="brand"><span class="brand-mark" aria-hidden="true">▸▸</span>replayd</a>
    <div class="error-content">
      <p class="muted text-sm">{{ missing ? '404 · Page not found' : 'Unable to open this page' }}</p>
      <h1>{{ missing ? 'This page is no longer here.' : 'Something went wrong.' }}</h1>
      <p class="muted">{{ missing ? 'The link may be out of date, or this page may have moved. Return to your projects to continue.' : 'We could not finish loading this page. Return to your projects and try again.' }}</p>
      <UiButton variant="primary" :busy="busy" @click="recover">Back to projects</UiButton>
    </div>
  </main>
</template>
