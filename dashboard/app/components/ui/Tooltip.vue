<script setup lang="ts">
defineProps<{ text: string }>();
const id = useId();
</script>
<template>
  <span class="tooltip-wrap" tabindex="0" :aria-describedby="id"
    ><slot /><span :id="id" role="tooltip" class="tooltip">{{
      text
    }}</span></span
  >
</template>
