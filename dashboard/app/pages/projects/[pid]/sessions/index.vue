<script setup lang="ts">
const route = useRoute()
const pid = computed(() => String(route.params.pid))
</script>

<template>
  <section>
    <h1 class="text-2xl font-semibold">
      Sessions — {{ pid }}
    </h1>
    <p class="mt-2 text-sm text-gray-500">
      Coming in T-22.
    </p>
  </section>
</template>
