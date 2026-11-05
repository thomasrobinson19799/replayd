<script setup lang="ts">
defineProps<{ value: number }>();
const now = useState("relative-now", () => Date.now());
</script>
<template>
  <time :datetime="new Date(value).toISOString()" :title="dateTime(value)">{{
    timeAgo(value, now)
  }}</time>
</template>
