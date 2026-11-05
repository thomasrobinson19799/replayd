<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  projects: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  issues: "M12 8v5m0 3v.1 M10 3h4l8 16-2 2H4l-2-2z",
  sessions: "M4 4h16v16H4z M10 8l6 4-6 4z",
  settings: "M4 7h16M4 17h16M9 4v6M15 14v6",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M18 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-4",
  theme: "M12 3a9 9 0 1 0 9 9A9 9 0 0 1 12 3z",
};
</script>
<template>
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.projects" />
  </svg>
</template>
