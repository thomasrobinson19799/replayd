<script setup lang="ts">
import type { Project } from "~/utils/types";

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ saved: [Project] }>();
const { busy, error, saved, save } = useSave(
  () => props.project,
  (p) => emit("saved", p),
);
const f = reactive({
  name: props.project.name,
  origins: props.project.allowed_origins.join("\n"),
  asset: props.project.asset_base_url ?? "",
  rewrite: props.project.asset_rewrite_from.join("\n"),
  retention: props.project.retention_days,
});
const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
function submit() {
  void save({
    name: f.name,
    allowed_origins: lines(f.origins),
    asset_base_url: f.asset.trim() || null,
    asset_rewrite_from: lines(f.rewrite),
    retention_days: Number(f.retention),
  });
}
useDirtyForm(f);
</script>

<template>
  <form class="flex flex-col gap-4 text-sm" @submit.prevent="submit">
    <label class="flex flex-col gap-1"
      >Name
      <input
        v-model="f.name"
        aria-label="name"
        class="rounded border border-gray-300 px-2 py-1"
      >
    </label>
    <label class="flex flex-col gap-1"
      >Allowed origins (one per line; APKs: <code>https://localhost</code>)
      <textarea
        v-model="f.origins"
        aria-label="origins"
        rows="4"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
      />
    </label>
    <label class="flex flex-col gap-1"
      >Asset base URL (player rewrites build-time origins to this, e.g. fonts)
      <input
        v-model="f.asset"
        aria-label="Asset base URL"
        placeholder="https://terminal.example.com/"
        class="rounded border border-gray-300 px-2 py-1"
      >
    </label>
    <label class="flex flex-col gap-1"
      >Origins to rewrite (one per line, default
      <code>https://localhost/</code>)
      <textarea
        v-model="f.rewrite"
        aria-label="rewrite"
        rows="2"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
      />
    </label>
    <label class="flex w-40 flex-col gap-1"
      >Retention (days)
      <input
        v-model.number="f.retention"
        aria-label="retention"
        type="number"
        min="1"
        max="14"
        class="rounded border border-gray-300 px-2 py-1"
      >
    </label>
    <div class="flex items-center gap-3">
      <button
        class="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50"
        :disabled="busy"
      >
        Save
      </button>
      <span v-if="saved" class="text-green-700">Saved</span>
      <span v-if="error" class="text-red-600">{{ error }}</span>
    </div>
  </form>
</template>
