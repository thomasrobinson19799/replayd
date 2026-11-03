<script setup lang="ts">
const route = useRoute()
const pid = computed(() => String(route.params.pid))
</script>

<template>
  <section>
    <h1 class="text-2xl font-semibold">
      Settings — {{ pid }}
    </h1>
    <p class="mt-2 text-sm text-gray-500">
      Project settings and remote config — coming in T-34.
    </p>
  </section>
</template>
