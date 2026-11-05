<script setup lang="ts">
withDefaults(defineProps<{ tone?: string }>(), { tone: "neutral" });
</script>
<template>
  <span class="badge" :class="`badge--${tone}`"><slot /></span>
</template>
