<script setup lang="ts">
import type { Project } from "~/utils/types";
interface Stats {
  issues: number;
  buckets: { ts: number; events: number; sessions: number; platform: string }[];
}
const api = useApi();
const session = useSessionStore();
const projects = ref<Project[]>([]);
const stats = ref<Record<number, Stats>>({});
const statsErrors = ref(new Set<number>());
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const search = ref("");
const showCreate = ref(false);
const projectForm = ref({ slug: "", name: "", origins: "" });
const created = ref<Project | null>(null);
const visible = computed(() =>
  projects.value.filter((p) =>
    `${p.name} ${p.slug}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
async function load() {
  loading.value = true;
  error.value = "";
  try {
    projects.value = (
      await api.get<{ projects: Project[] }>("/projects")
    ).projects;
    loading.value = false;
    // Bound requests: no burst proportional to the project count.
    for (let i = 0; i < projects.value.length; i += 4)
      await Promise.all(
        projects.value.slice(i, i + 4).map(async (p) => {
          try {
            stats.value[p.id] = await api.get<Stats>(
              `/projects/${p.id}/stats`,
              { query: { range: "24h" } },
            );
          } catch {
            statsErrors.value.add(p.id);
          }
        }),
      );
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function create() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    created.value = await api.post<Project>("/projects", {
      slug: projectForm.value.slug,
      name: projectForm.value.name,
      allowed_origins: projectForm.value.origins
        .split(/[\s,]+/)
        .filter(Boolean),
    });
    showCreate.value = false;
    Object.assign(projectForm.value, { slug: "", name: "", origins: "" });
    await Promise.all([load(), session.fetchMe()]);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>Projects</h1>
        <p>
          A clear view of your applications. Activity from the last 24 hours.
        </p>
      </div>
      <UiButton
        v-if="session.isSuperadmin"
        variant="primary"
        @click="showCreate = true"
        >New project</UiButton
      >
    </header>
    <ProjectSetup v-if="created" :project="created" class="mb-2"
      ><div class="flex gap-3">
        <UiButton @click="created = null">I've saved the token</UiButton
        ><NuxtLink
          class="ui-button ui-button--primary"
          :to="`/projects/${created.slug}/issues`"
          >Open issues</NuxtLink
        >
      </div></ProjectSetup
    >
    <p v-if="error" role="alert" class="field-error mb-4">{{ error }}</p>
    <div class="mb-2 max-w-sm">
      <UiInput
        v-model="search"
        label="Find a project"
        type="search"
        placeholder="Search projects…"
      />
    </div>
    <UiSkeleton v-if="loading" :rows="4" />
    <div v-else-if="visible.length" class="project-grid">
      <UiCard v-for="p in visible" :key="p.id" class="project-card"
        ><div class="section-heading">
          <div>
            <h2>
              <NuxtLink :to="`/projects/${p.slug}/issues`">{{
                p.name
              }}</NuxtLink>
            </h2>
            <p class="muted text-xs mt-1 font-mono tabular-nums">{{ p.slug }}</p>
          </div>
          <UiBadge>{{ p.role }}</UiBadge>
        </div>
        <template v-if="stats[p.id]"
          ><div class="project-stats">
            <div>
              <strong>{{
                compact(stats[p.id]!.buckets.reduce((n, b) => n + b.events, 0))
              }}</strong
              ><span>Events · 24h</span>
            </div>
            <div>
              <strong>{{ compact(stats[p.id]!.issues) }}</strong
              ><span>Active issues · 24h</span>
            </div>
            <div>
              <strong>{{
                compact(
                  stats[p.id]!.buckets.reduce((n, b) => n + b.sessions, 0),
                )
              }}</strong
              ><span>Sessions · 24h</span>
            </div>
          </div>
          <ActivitySparkline :buckets="stats[p.id]!.buckets"
        /></template>
        <p v-else-if="statsErrors.has(p.id)" class="muted py-10">
          Activity unavailable. Refresh to retry.
        </p>
        <UiSkeleton v-else :rows="2" />
        <footer>
          <NuxtLink :to="`/projects/${p.slug}/issues`">View issues →</NuxtLink
          ><NuxtLink :to="`/projects/${p.slug}/sessions`">Sessions</NuxtLink>
        </footer></UiCard
      >
    </div>
    <UiEmptyState
      v-else
      :title="projects.length ? 'No projects match.' : 'No projects yet.'"
      :description="
        projects.length
          ? 'Try a different name or clear your search.'
          : 'Create a project to start collecting errors and replays.'
      "
    /><UiModal v-model="showCreate" title="Create project"
      ><form class="stack" @submit.prevent="create">
        <UiInput
          v-model="projectForm.name"
          label="Project name"
          placeholder="FXGlory terminal"
          required
        /><UiInput
          v-model="projectForm.slug"
          label="Project slug"
          placeholder="fxglory-terminal"
          required
          pattern="[a-z0-9-]{2,64}"
          hint="2–64 lowercase letters, numbers or hyphens."
        /><UiTextarea
          :model-value="projectForm.origins"
          label="Allowed origins"
          rows="3"
          placeholder="https://app.example.com"
          @update:model-value="projectForm.origins = $event"
        />
        <p class="muted text-sm">
          Separate origins with commas or new lines. Include https://localhost
          for Android builds.
        </p>
        <p v-if="error" role="alert" class="field-error">{{ error }}</p>
        <div class="dialog-actions">
          <UiButton @click="showCreate = false">Cancel</UiButton
          ><UiButton type="submit" variant="primary" :busy="busy"
            >Create</UiButton
          >
        </div>
      </form></UiModal
    >
  </div>
</template>
