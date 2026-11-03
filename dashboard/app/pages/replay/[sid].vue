<script setup lang="ts">
const route = useRoute()
const sid = computed(() => String(route.params.sid))
</script>

<template>
  <section>
    <h1 class="text-2xl font-semibold">
      Replay {{ sid }}
    </h1>
    <p class="mt-2 text-sm text-gray-500">
      Replay player — coming in T-23.
    </p>
  </section>
</template>
