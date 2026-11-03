<script setup lang="ts">
const links = [
  { to: '/', label: 'Projects' },
  { to: '/users', label: 'Users' },
] as const
</script>

<template>
  <div class="min-h-screen bg-gray-50 text-gray-900">
    <header class="border-b border-gray-200 bg-white">
      <nav class="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
        <NuxtLink
          to="/"
          class="font-semibold tracking-tight"
        >
          replayd
        </NuxtLink>
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="text-sm text-gray-600 hover:text-gray-900"
          active-class="text-gray-900 font-medium"
        >
          {{ link.label }}
        </NuxtLink>
        <NuxtLink
          to="/login"
          class="ml-auto text-sm text-gray-600 hover:text-gray-900"
        >
          Sign in
        </NuxtLink>
      </nav>
    </header>
    <main class="mx-auto max-w-6xl px-4 py-8">
      <slot />
    </main>
  </div>
</template>
