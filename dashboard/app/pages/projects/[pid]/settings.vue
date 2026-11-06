<script setup lang="ts">
// Project settings (PRD §6): General, Keys & DSN, Members, Telegram, Remote config (T-34), Fingerprint rules.
import type { Project } from "~/utils/types";

const route = useRoute();
const router = useRouter();
const api = useApi();
const pid = computed(() => String(route.params.pid));
const project = ref<Project | null>(null);
const error = ref("");
const dirty = ref(false);
provide("settings-dirty", dirty);
const leaveOpen = ref(false);
let settle: ((v: boolean) => void) | null = null;
async function canLeave() {
  if (!dirty.value) return true;
  leaveOpen.value = true;
  return await new Promise<boolean>((resolve) => {
    settle = resolve;
  });
}
function discard() {
  dirty.value = false;
  settle?.(true);
  settle = null;
  leaveOpen.value = false;
}
watch(leaveOpen, (value) => {
  if (!value && settle) {
    settle(false);
    settle = null;
  }
});
onBeforeRouteLeave(canLeave);
onBeforeRouteUpdate(canLeave);
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  settle?.(false);
});
const tabs = [
  "general",
  "keys",
  "members",
  "telegram",
  "remote",
  "rules",
] as const;
type Tab = (typeof tabs)[number];
const labels: Record<Tab, string> = {
  general: "General",
  keys: "Keys & DSN",
  members: "Members",
  telegram: "Telegram",
  remote: "Remote config",
  rules: "Fingerprint rules",
};
const tab = computed<Tab>(() =>
  (tabs as readonly string[]).includes(String(route.query.tab))
    ? (route.query.tab as Tab)
    : "general",
);

async function load() {
  try {
    project.value = await api.get<Project>(`/projects/${pid.value}`);
  } catch (e) {
    error.value = errorMessage(e);
  }
}
onMounted(load);
watch(pid, load);
</script>

<template>
  <section>
    <h1 class="text-2xl font-semibold">
      Settings — {{ project?.name ?? pid }}
    </h1>
    <p class="muted mt-2 mb-2">
      Manage capture, access, and alerts for this project.
    </p>
    <UiTabs
      class="settings-tabs"
      :model-value="tab"
      :items="tabs.map((t) => ({ value: t, label: labels[t] }))"
      label="Project settings"
      @update:model-value="router.push({ query: { tab: $event } })"
    />
    <p v-if="dirty" class="muted mt-3" role="status">Unsaved changes</p>
    <p v-if="error" class="mt-4 text-sm text-red-600">
      {{ error }}
    </p>
    <div
      v-if="project"
      :key="`${pid}-${tab}`"
      class="settings-panel mt-2 max-w-3xl"
      role="tabpanel"
      :aria-label="labels[tab]"
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
      <SettingsMembers v-else-if="tab === 'members'" :project="project" />
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
    <UiSkeleton v-else-if="!error" :rows="4" />
    <UiConfirmDialog
      v-model="leaveOpen"
      title="Discard unsaved changes?"
      description="Your changes have not been saved. Stay here to save them, or discard them to continue."
      action="Discard changes"
      @confirm="discard"
    />
  </section>
</template>
