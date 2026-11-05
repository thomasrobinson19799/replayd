<script setup lang="ts">
withDefaults(defineProps<{ rows?: number }>(), { rows: 3 });
</script>
<template>
  <div role="status" aria-label="Loading" class="skeleton-group">
    <div v-for="n in rows" :key="n" class="skeleton" />
    <span class="sr-only">Loading…</span>
  </div>
</template>
