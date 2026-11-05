<script setup lang="ts">
const props = defineProps<{
  buckets: { ts: number; events: number }[];
  hours?: number;
}>();
const values = computed(() => {
  const n = props.hours || 24;
  const end = Math.floor(Date.now() / 3600000) * 3600000;
  const data = Array.from({ length: n }, () => 0);
  for (const b of props.buckets) {
    const i = n - 1 - Math.round((end - b.ts) / 3600000);
    if (i >= 0 && i < n) data[i]! += b.events;
  }
  return data;
});
const points = computed(() => {
  const max = Math.max(1, ...values.value);
  return values.value
    .map(
      (v, i) =>
        `${(i * 300) / (values.value.length - 1)},${40 - (v * 36) / max}`,
    )
    .join(" ");
});
</script>
<template>
  <svg
    class="sparkline"
    viewBox="0 0 300 44"
    preserveAspectRatio="none"
    role="img"
    :aria-label="`${values.reduce((a, b) => a + b, 0)} events across the displayed hourly buckets`"
  >
    <polyline
      :points="points"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>
