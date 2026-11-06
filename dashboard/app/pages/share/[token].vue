<script setup lang="ts">
definePageMeta({ layout: false })
const route = useRoute()
useColorTheme()
useHead({ title: 'Shared replay', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }, { name: 'referrer', content: 'no-referrer' }] })
</script>
<template>
  <main class="p-3">
    <ReplayPlayer :key="String(route.params.token)" :share-token="String(route.params.token)" />
  </main>
</template>
