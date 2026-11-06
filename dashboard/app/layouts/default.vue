<script setup lang="ts">
const session = useSessionStore();
const route = useRoute();
const menu = ref(false);
const help = ref(false);
const toast = useToast();
const projectSlug = computed(() =>
  String(route.params.pid ?? route.query.project ?? ""),
);
const project = computed(() =>
  session.me?.projects.find(
    (p) => p.slug === projectSlug.value || String(p.id) === projectSlug.value,
  ),
);
const pageName = computed(() =>
  route.path.includes("/replay/")
    ? "Replay"
    : route.path.includes("/issues/")
      ? "Issue detail"
      : route.path.endsWith("/issues")
        ? "Issues"
        : route.path.endsWith("/sessions")
          ? "Sessions"
          : route.path.endsWith("/settings")
            ? "Settings"
            : route.path === "/users"
              ? "Users"
              : route.path === "/account"
                ? "My account"
                : "Projects",
);
useHead({ title: computed(() => `${pageName.value} · replayd`) });
const { theme, cycleTheme } = useColorTheme();
let timer: ReturnType<typeof setInterval> | undefined;
const now = useState("relative-now", () => Date.now());
async function signOut() {
  try {
    await session.logout();
    await navigateTo("/login");
  } catch {
    toast.show("Sign out failed. Please try again.", "error");
  }
}
function shortcuts(e: KeyboardEvent) {
  if (
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    (e.target as HTMLElement).closest(
      "input,textarea,select,[contenteditable=true],dialog[open]",
    )
  )
    return;
  if (e.key === "?") {
    e.preventDefault();
    help.value = true;
  }
  if (e.key === "/") {
    const input = document.querySelector<HTMLInputElement>(
      "main input[type=search],main input[data-search]",
    );
    if (input) {
      e.preventDefault();
      input.focus();
    }
  }
}
onMounted(() => {
  window.addEventListener("keydown", shortcuts);
  timer = setInterval(() => {
    now.value = Date.now();
  }, 30000);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", shortcuts);
  clearInterval(timer);
});
watch(
  () => route.fullPath,
  () => {
    menu.value = false;
  },
);
</script>
<template>
  <div>
    <div v-if="session.isAuthenticated" class="app-shell">
      <a href="#main-content" class="skip-link">Skip to content</a>
      <aside
        class="sidebar"
        :class="{ open: menu }"
        aria-label="Workspace navigation"
      >
        <NuxtLink to="/" class="brand"
          ><span class="brand-mark" aria-hidden="true">▸▸</span
          >replayd</NuxtLink
        >
        <label for="project-switch" class="muted text-xs"
          >Workspace / Project</label
        >
        <select
          id="project-switch"
          :value="project?.slug || ''"
          @change="
            navigateTo(
              ($event.target as HTMLSelectElement).value
                ? `/projects/${($event.target as HTMLSelectElement).value}/issues`
                : '/',
            )
          "
        >
          <option value="">All projects</option>
          <option v-for="p in session.me?.projects" :key="p.id" :value="p.slug">
            {{ p.name }}
          </option>
        </select>
        <nav aria-label="Main">
          <NuxtLink to="/"><UiIcon name="projects" />Projects</NuxtLink
          ><template v-if="project"
            ><NuxtLink :to="`/projects/${project.slug}/issues`" :class="{ current: route.path.includes('/issues') }"
              ><UiIcon name="issues" />Issues</NuxtLink
            ><NuxtLink :to="`/projects/${project.slug}/sessions`" :class="{ current: route.path.includes('/sessions') || route.path.startsWith('/replay/') }"
              ><UiIcon name="sessions" />Sessions</NuxtLink
            ><NuxtLink
              v-if="project.role === 'admin'"
              :to="`/projects/${project.slug}/settings`"
              ><UiIcon name="settings" />Settings</NuxtLink
            ></template
          ><template v-if="session.isSuperadmin"
            ><p class="nav-label">Administration</p>
            <NuxtLink to="/users"
              ><UiIcon name="users" />Users</NuxtLink
            ></template
          >
        </nav>
        <div class="sidebar-footer">
          <UiButton
            variant="ghost"
            aria-label="Keyboard shortcuts"
            @click="help = true"
            >?</UiButton
          ><span>Keyboard shortcuts</span>
        </div>
      </aside>
      <header class="topbar">
        <div class="flex items-center gap-3">
          <UiButton
            class="mobile-menu"
            :aria-expanded="menu"
            aria-label="Toggle navigation"
            @click="menu = !menu"
            >☰</UiButton
          >
          <nav class="breadcrumbs" aria-label="Breadcrumb">
            <NuxtLink to="/">Workspace</NuxtLink
            ><template v-if="project"
              ><span aria-hidden="true">/</span
              ><NuxtLink :to="`/projects/${project.slug}/issues`">{{
                project.name
              }}</NuxtLink></template
            ><span aria-hidden="true">/</span
            ><strong aria-current="page">{{ pageName }}</strong>
          </nav>
        </div>
        <div class="topbar-actions">
          <UiTooltip :text="`Theme: ${theme}`"
            ><UiButton
              variant="ghost"
              :aria-label="`Theme: ${theme}. Change theme`"
              @click="cycleTheme"
              ><UiIcon name="theme" /></UiButton></UiTooltip
          ><UiDropdown :label="session.me?.name || 'Account'"
            ><p class="px-3 py-2 muted break-all">{{ session.me?.email }}</p>
            <NuxtLink to="/account">My account</NuxtLink
            ><button @click="signOut">Sign out</button></UiDropdown
          >
        </div>
      </header>
      <main id="main-content" class="workspace" tabindex="-1"><slot /></main>
    </div>
    <div v-else class="login-shell">
      <slot /><UiButton
        class="fixed right-4 top-4"
        :aria-label="`Theme: ${theme}`"
        @click="cycleTheme"
        >Theme: {{ theme }}</UiButton
      >
    </div>
    <UiToast />
    <UiModal v-model="help" title="Keyboard shortcuts"
      ><dl>
        <div class="section-heading">
          <dt>Focus page search</dt>
          <dd><kbd>/</kbd></dd>
        </div>
        <div class="section-heading">
          <dt>Next / previous table row</dt>
          <dd><kbd>j</kbd> / <kbd>k</kbd> or ↑ / ↓</dd>
        </div>
        <div class="section-heading">
          <dt>Show this help</dt>
          <dd><kbd>?</kbd></dd>
        </div>
        <div class="section-heading">
          <dt>Close dialog or account menu</dt>
          <dd><kbd>Esc</kbd></dd>
        </div>
      </dl></UiModal
    >
  </div>
</template>
