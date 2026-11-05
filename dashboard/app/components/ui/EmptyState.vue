<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>
<template>
  <div class="empty-state" role="status">
    <span class="empty-symbol" aria-hidden="true">✓</span>
    <h2>{{ title }}</h2>
    <p v-if="description" class="muted">{{ description }}</p>
    <slot />
  </div>
</template>
