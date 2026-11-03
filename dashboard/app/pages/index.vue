<script setup lang="ts">
import type { Project } from '~/utils/types'

const api = useApi()
const session = useSessionStore()
const projects = ref<Project[]>([])
const loading = ref(true)
const error = ref('')

const showCreate = ref(false)
const form = reactive({ slug: '', name: '', origins: '' })
const created = ref<Project | null>(null)

async function load() {
  loading.value = true
  try {
    projects.value = (await api.get<{ projects: Project[] }>('/projects')).projects
  }
  catch (e) {
    error.value = errorMessage(e)
  }
  finally {
    loading.value = false
  }
}

async function create() {
  error.value = ''
  try {
    const allowed_origins = form.origins.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
    created.value = await api.post<Project>('/projects', { slug: form.slug, name: form.name, allowed_origins })
    showCreate.value = false
    Object.assign(form, { slug: '', name: '', origins: '' })
    await Promise.all([load(), session.fetchMe()])
  }
  catch (e) {
    error.value = errorMessage(e)
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="mb-4 flex items-center">
      <h1 class="text-xl font-semibold">
        Projects
      </h1>
      <button
        v-if="session.isSuperadmin"
        class="ml-auto rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
        @click="showCreate = !showCreate"
      >
        New project
      </button>
    </div>

    <form
      v-if="showCreate"
      class="mb-6 grid gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-4"
      @submit.prevent="create"
    >
      <input
        v-model="form.name"
        placeholder="Name (FXGlory terminal)"
        required
        class="rounded border border-gray-300 px-2 py-1.5 text-sm"
      >
      <input
        v-model="form.slug"
        placeholder="slug (fxglory-terminal)"
        required
        pattern="[a-z0-9-]{2,64}"
        class="rounded border border-gray-300 px-2 py-1.5 text-sm"
      >
      <input
        v-model="form.origins"
        placeholder="Allowed origins (comma separated)"
        class="rounded border border-gray-300 px-2 py-1.5 text-sm"
      >
      <button class="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
        Create
      </button>
    </form>

    <div
      v-if="created"
      class="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm"
    >
      <p class="mb-2 font-medium">
        Project “{{ created.name }}” created.
      </p>
      <p>DSN: <code class="select-all">{{ created.dsn }}</code></p>
      <p class="mt-1">
        Source map upload token (shown once, store it as a CI secret):
        <code class="select-all">{{ created.upload_token }}</code>
      </p>
      <button
        class="mt-2 text-gray-600 underline"
        @click="created = null"
      >
        Done
      </button>
    </div>

    <p
      v-if="error"
      class="mb-4 text-sm text-red-600"
    >
      {{ error }}
    </p>
    <p
      v-if="loading"
      class="text-sm text-gray-500"
    >
      Loading…
    </p>
    <table
      v-else-if="projects.length"
      class="w-full overflow-hidden rounded-lg border border-gray-200 bg-white text-sm"
    >
      <thead class="bg-gray-50 text-left text-gray-500">
        <tr>
          <th class="px-4 py-2 font-medium">
            Name
          </th>
          <th class="px-4 py-2 font-medium">
            Slug
          </th>
          <th class="px-4 py-2 font-medium">
            Your role
          </th>
          <th class="px-4 py-2 font-medium">
            DSN
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in projects"
          :key="p.id"
          class="border-t border-gray-100 hover:bg-gray-50"
        >
          <td class="px-4 py-2">
            <NuxtLink
              :to="`/projects/${p.slug}/issues`"
              class="font-medium hover:underline"
            >
              {{ p.name }}
            </NuxtLink>
          </td>
          <td class="px-4 py-2 text-gray-600">
            {{ p.slug }}
          </td>
          <td class="px-4 py-2 text-gray-600">
            {{ p.role }}
          </td>
          <td class="px-4 py-2">
            <code class="select-all text-xs text-gray-600">{{ p.dsn }}</code>
          </td>
        </tr>
      </tbody>
    </table>
    <p
      v-else
      class="text-sm text-gray-500"
    >
      No projects yet.
    </p>
  </div>
</template>
