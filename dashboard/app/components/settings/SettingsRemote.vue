<script setup lang="ts">
import type { Project } from '~/utils/types'

defineProps<{ project: Project }>()
defineEmits<{ saved: [Project] }>()
</script>

<template>
  <p class="text-sm text-gray-500">
    Remote config editor: T-34.
  </p>
</template>
