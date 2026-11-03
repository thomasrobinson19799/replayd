<script setup lang="ts">
const route = useRoute()
const id = computed(() => String(route.params.id))
</script>

<template>
  <section>
    <h1 class="text-2xl font-semibold">
      Issue {{ id }}
    </h1>
    <p class="mt-2 text-sm text-gray-500">
      Issue detail — coming in T-18.
    </p>
  </section>
</template>
