<script setup lang="ts">
const route = useRoute()
</script>
<template>
  <ReplayPlayer :key="String(route.params.sid)" :sid="String(route.params.sid)" />
</template>
