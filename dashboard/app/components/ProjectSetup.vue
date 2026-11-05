<script setup lang="ts">
import type { Project } from "~/utils/types";
const props = defineProps<{ project: Project }>();
const tab = ref("nuxt");
const snippet = computed(() => {
  const dsn = props.project.dsn;
  if (tab.value === "nuxt")
    return `// nuxt.config.ts\nexport default defineNuxtConfig({\n  modules: ['@replayd/nuxt'],\n  appConfig: { app_version: process.env.APP_VERSION },\n  runtimeConfig: { public: {\n    replayd: {\n      dsn: ${JSON.stringify(dsn)},\n      environment: 'production',\n    },\n  } },\n  sourcemap: { client: 'hidden' },\n})`;
  const url = new URL(dsn);
  url.username = "";
  url.password = "";
  url.pathname = "";
  if (tab.value === "script")
    return (
      `<script defer src="${url.origin}/ingest/sdk/latest/replayd.min.js"\n  data-dsn="${dsn}" data-environment="production"><` +
      "/script>"
    );
  return `# Store these as protected CI secrets, not in your repository.\nexport REPLAYD_URL='${url.origin}'\nexport REPLAYD_TOKEN='${props.project.upload_token || "<your stored upload token>"}'\n\n# APP_VERSION must match the release configured in your app.\nnpx @replayd/cli sourcemaps upload --project ${props.project.slug} --release "$APP_VERSION" --dir .output/public/_nuxt --url-prefix '~/_nuxt' --delete-after`;
});
</script>
<template>
  <UiCard class="stack"
    ><div>
      <h2>Connect {{ project.name }}</h2>
      <p class="muted mt-1">
        Install the SDK, then trigger a test error to verify your connection.
      </p>
    </div>
    <div>
      <div class="section-heading">
        <strong>DSN</strong
        ><UiCopyButton :text="project.dsn" label="Copy DSN" />
      </div>
      <pre class="code-block">{{ project.dsn }}</pre>
    </div>
    <div v-if="project.upload_token">
      <div class="section-heading">
        <strong>Source map upload token</strong
        ><UiCopyButton :text="project.upload_token" label="Copy token" />
      </div>
      <p class="mb-2 field-error">
        Shown once. Save this token as a protected CI secret before leaving.
      </p>
      <pre class="code-block">{{ project.upload_token }}</pre>
    </div>
    <UiTabs
      v-model="tab"
      label="Installation method"
      :items="[
        { value: 'nuxt', label: 'Nuxt' },
        { value: 'script', label: 'Script tag' },
        { value: 'ci', label: 'CI source maps' },
      ]" />
    <p class="muted text-sm">
      {{
        tab === "nuxt"
          ? "Install @replayd/nuxt in your app, then add this configuration."
          : tab === "script"
            ? "Add this tag before the application scripts. Configure your allowed origins in Settings."
            : "Upload maps from the same release as your application build."
      }}
    </p>
    <pre class="code-block">{{ snippet }}</pre>
    <div><UiCopyButton :text="snippet" label="Copy snippet" /></div>
    <slot
  /></UiCard>
</template>
