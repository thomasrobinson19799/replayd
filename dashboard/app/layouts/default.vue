<script setup lang="ts">
const session = useSessionStore()
const route = useRoute()

const projectSlug = computed(() => (route.params.pid as string | undefined) ?? null)
const project = computed(() =>
  session.me?.projects.find(p => p.slug === projectSlug.value || String(p.id) === projectSlug.value) ?? null,
)

async function signOut() {
  await session.logout()
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 text-gray-900">
    <header
      v-if="session.isAuthenticated"
      class="border-b border-gray-200 bg-white"
    >
      <nav class="mx-auto flex max-w-7xl items-center gap-5 px-4 py-3 text-sm">
        <NuxtLink
          to="/"
          class="text-base font-semibold tracking-tight"
        >
          replayd
        </NuxtLink>
        <NuxtLink
          to="/"
          class="text-gray-600 hover:text-gray-900"
        >
          Projects
        </NuxtLink>
        <template v-if="project">
          <span class="text-gray-300">/</span>
          <span class="font-medium">{{ project.name }}</span>
          <NuxtLink
            :to="`/projects/${project.slug}/issues`"
            class="text-gray-600 hover:text-gray-900"
            active-class="!text-gray-900 font-medium"
          >
            Issues
          </NuxtLink>
          <NuxtLink
            :to="`/projects/${project.slug}/sessions`"
            class="text-gray-600 hover:text-gray-900"
            active-class="!text-gray-900 font-medium"
          >
            Sessions
          </NuxtLink>
          <NuxtLink
            v-if="project.role === 'admin' || session.isSuperadmin"
            :to="`/projects/${project.slug}/settings`"
            class="text-gray-600 hover:text-gray-900"
            active-class="!text-gray-900 font-medium"
          >
            Settings
          </NuxtLink>
        </template>
        <NuxtLink
          v-if="session.isSuperadmin"
          to="/users"
          class="text-gray-600 hover:text-gray-900"
          active-class="!text-gray-900 font-medium"
        >
          Users
        </NuxtLink>
        <span class="ml-auto text-gray-500">{{ session.me?.email }}</span>
        <button
          class="text-gray-600 hover:text-gray-900"
          @click="signOut"
        >
          Sign out
        </button>
      </nav>
    </header>
    <main class="mx-auto max-w-7xl px-4 py-6">
      <slot />
    </main>
  </div>
</template>
