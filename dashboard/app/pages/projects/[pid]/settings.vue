<script setup lang="ts">
// Project settings (PRD §6): General, Keys & DSN, Members, Telegram, Remote config (T-34), Fingerprint rules.
import type { Project } from '~/utils/types'

const route = useRoute()
const router = useRouter()
const api = useApi()
const pid = computed(() => String(route.params.pid))
const project = ref<Project | null>(null)
const error = ref('')
const tabs = ['general', 'keys', 'members', 'telegram', 'remote', 'rules'] as const
type Tab = typeof tabs[number]
const labels: Record<Tab, string> = { general: 'General', keys: 'Keys & DSN', members: 'Members', telegram: 'Telegram', remote: 'Remote config', rules: 'Fingerprint rules' }
const tab = computed<Tab>(() => (tabs as readonly string[]).includes(String(route.query.tab)) ? route.query.tab as Tab : 'general')

async function load() {
  try {
    project.value = await api.get<Project>(`/projects/${pid.value}`)
  }
  catch (e) {
    error.value = errorMessage(e)
  }
}
onMounted(load)
</script>

<template>
  <section>
    <h1 class="text-2xl font-semibold">
      Settings — {{ project?.name ?? pid }}
    </h1>
    <nav class="mt-4 flex gap-1 border-b border-gray-200 text-sm">
      <button
        v-for="t in tabs"
        :key="t"
        class="px-3 py-2"
        :class="tab === t ? 'border-b-2 border-gray-900 font-semibold' : 'text-gray-500 hover:text-gray-800'"
        :data-testid="`settings-tab-${t}`"
        @click="router.replace({ query: { tab: t } })"
      >
        {{ labels[t] }}
      </button>
    </nav>
    <p
      v-if="error"
      class="mt-4 text-sm text-red-600"
    >
      {{ error }}
    </p>
    <div
      v-if="project"
      class="mt-4 max-w-3xl"
    >
      <SettingsGeneral
        v-if="tab === 'general'"
        :project="project"
        @saved="(p) => (project = p)"
      />
      <SettingsKeys
        v-else-if="tab === 'keys'"
        :project="project"
        @saved="load"
      />
      <SettingsMembers
        v-else-if="tab === 'members'"
        :project="project"
      />
      <SettingsTelegram
        v-else-if="tab === 'telegram'"
        :project="project"
        @saved="(p) => (project = p)"
      />
      <SettingsRemote
        v-else-if="tab === 'remote'"
        :project="project"
        @saved="(p) => (project = p)"
      />
      <SettingsRules
        v-else-if="tab === 'rules'"
        :project="project"
        @saved="(p) => (project = p)"
      />
    </div>
  </section>
</template>
