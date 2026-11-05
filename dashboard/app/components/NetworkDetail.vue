<script setup lang="ts">
import type { NetworkItem } from '~/utils/replay'

const props = defineProps<{ item: NetworkItem }>()
const labels: Record<string, string> = {
  reqHeaders: 'Request headers', resHeaders: 'Response headers',
  reqBody: 'Request body', resBody: 'Response body',
  reqSize: 'Request size (bytes)', resSize: 'Response size (bytes)', start: 'Start offset (ms)',
}
const sections = computed(() => Object.entries(props.item.detail).map(([key, value]) => {
  let decoded = value
  if (typeof value === 'string' && /body$/i.test(key)) {
    try { decoded = JSON.parse(value) } catch { /* Preserve non-JSON and truncated bodies as captured. */ }
  }
  return { key, text: typeof decoded === 'string' ? decoded : JSON.stringify(decoded, null, 2) }
}))
</script>

<template>
  <div class="stack">
    <p class="font-mono break-all">{{ item.method }} {{ item.url }}</p>
    <div>
      <UiBadge :tone="item.status >= 400 ? 'error' : 'success'">
        {{ item.status || 'Failed' }} · {{ item.duration }} ms
      </UiBadge>
    </div>
    <dl class="stack">
      <div v-for="section in sections" :key="section.key">
        <dt class="font-semibold mb-2">{{ labels[section.key] || section.key }}</dt>
        <dd><pre class="code-block">{{ section.text }}</pre></dd>
      </div>
    </dl>
  </div>
</template>
