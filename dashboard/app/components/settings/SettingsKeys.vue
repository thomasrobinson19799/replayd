<script setup lang="ts">
import type { Project } from "~/utils/types";
const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ saved: [] }>();
const api = useApi();
const shown = ref<string | null>(null);
const error = ref("");
const busy = ref(false);
const open = ref(false);
const kind = ref<"public" | "upload">("public");
async function rotate() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const r = await api.post<{ upload_token?: string }>(
      `/projects/${props.project.id}/keys/rotate`,
      { kind: kind.value },
    );
    shown.value = r.upload_token || null;
    open.value = false;
    emit("saved");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="stack">
    <div class="section-heading">
      <h2>Keys &amp; DSN</h2>
      <UiCopyButton :text="project.dsn" label="Copy DSN" />
    </div>
    <code class="code-block" data-testid="dsn">{{ project.dsn }}</code>
    <p class="muted">
      The DSN is used in your application. The upload token belongs only in
      protected CI secrets.
    </p>
    <div class="flex flex-wrap gap-3">
      <UiButton
        @click="
          kind = 'public';
          open = true;
        "
        >Rotate public key</UiButton
      ><UiButton
        @click="
          kind = 'upload';
          open = true;
        "
        >Rotate upload token</UiButton
      >
    </div>
    <div v-if="shown">
      <p class="field-error mb-2">
        New upload token — shown once. Save it before leaving.
      </p>
      <pre class="code-block mb-2">{{ shown }}</pre>
      <UiCopyButton :text="shown" label="Copy token" />
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <UiConfirmDialog
      v-model="open"
      title="Rotate key?"
      :description="
        kind === 'public'
          ? 'Applications using the old DSN will stop sending until you update them.'
          : 'CI uploads using the old token will stop working. Store the replacement securely.'
      "
      action="Rotate key"
      :busy="busy"
      @confirm="rotate"
    />
  </div>
</template>
