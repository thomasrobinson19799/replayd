<script setup lang="ts">
// Remote config editor (PRD §4.12, T-34). The SDK caches the config for `ttl` seconds (default 600 = 10 min),
// so a change reaches running apps (incl. APKs) within that time without shipping a new build.
// Rates/toggles are the server's; redaction lists can only be extended (the SDK never drops its defaults).
import type { Project } from "~/utils/types";

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ saved: [Project] }>();
const { busy, error, saved, save } = useSave(
  () => props.project,
  (p) => emit("saved", p),
);
type E = {
  v: number;
  disabled: boolean;
  replay: { sampleRate: number };
  errors: { sampleRate: number };
  ws: { enabled: boolean; perChannelPerSec: number; maxFramesPerSec: number };
  redact: { headers: string[]; bodyKeys: string[]; queryParams: string[] };
  ttl: number;
};
const eff = computed(
  () => (props.project.remote_config_effective ?? {}) as unknown as E,
);
const e0 = eff.value;
const f = reactive({
  disabled: !!e0.disabled,
  replayRate: e0.replay?.sampleRate ?? 1,
  errorsRate: e0.errors?.sampleRate ?? 1,
  wsEnabled: e0.ws?.enabled !== false,
  perChannel: e0.ws?.perChannelPerSec ?? 1,
  maxFrames: e0.ws?.maxFramesPerSec ?? 20,
  ttl: e0.ttl ?? 600,
  headers: (e0.redact?.headers ?? []).join("\n"),
  bodyKeys: (e0.redact?.bodyKeys ?? []).join("\n"),
  queryParams: (e0.redact?.queryParams ?? []).join("\n"),
});
const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
const body = computed(() => ({
  disabled: f.disabled,
  replay: { sampleRate: Number(f.replayRate) },
  errors: { sampleRate: Number(f.errorsRate) },
  ws: {
    enabled: f.wsEnabled,
    perChannelPerSec: Number(f.perChannel),
    maxFramesPerSec: Number(f.maxFrames),
  },
  redact: {
    headers: lines(f.headers),
    bodyKeys: lines(f.bodyKeys),
    queryParams: lines(f.queryParams),
  },
  ttl: Number(f.ttl),
}));
function submit() {
  if (
    f.disabled &&
    !eff.value.disabled &&
    !confirm(
      "Kill switch: every SDK of this project stops capturing within the config TTL. Continue?",
    )
  )
    return;
  void save({ remote_config: body.value });
}
useDirtyForm(f);
</script>

<template>
  <form
    class="flex flex-col gap-4 text-sm"
    data-testid="remote-form"
    @submit.prevent="submit"
  >
    <p class="text-gray-500">
      Version {{ eff.v }} · apps pick up changes within
      {{ Math.round(eff.ttl / 60) }} min (config TTL), no new APK needed.
    </p>
    <label class="flex items-center gap-2 font-medium text-red-700"
      ><input
        v-model="f.disabled"
        aria-label="disabled"
        type="checkbox"
        data-testid="rc-disabled"
      >
      Kill switch: stop all capture</label
    >
    <fieldset class="grid grid-cols-2 gap-3">
      <label class="flex flex-col gap-1"
        >Replay sample rate (0–1)
        <input
          v-model.number="f.replayRate"
          aria-label="replayRate"
          type="number"
          step="0.05"
          min="0"
          max="1"
          class="rounded border border-gray-300 px-2 py-1"
          data-testid="rc-replay-rate"
        >
      </label>
      <label class="flex flex-col gap-1"
        >Error sample rate (0–1)
        <input
          v-model.number="f.errorsRate"
          aria-label="errorsRate"
          type="number"
          step="0.05"
          min="0"
          max="1"
          class="rounded border border-gray-300 px-2 py-1"
        >
      </label>
    </fieldset>
    <fieldset class="grid grid-cols-3 gap-3">
      <label class="col-span-3 flex items-center gap-2"
        ><input v-model="f.wsEnabled" aria-label="wsEnabled" type="checkbox" >
        WebSocket capture</label
      >
      <label class="flex flex-col gap-1"
        >Frames / s per socket (gate)
        <input
          v-model.number="f.maxFrames"
          aria-label="maxFrames"
          type="number"
          min="0"
          max="1000"
          class="rounded border border-gray-300 px-2 py-1"
          data-testid="rc-max-frames"
        >
      </label>
      <label class="flex flex-col gap-1"
        >Frames / s per channel
        <input
          v-model.number="f.perChannel"
          aria-label="perChannel"
          type="number"
          min="0"
          max="100"
          class="rounded border border-gray-300 px-2 py-1"
        >
      </label>
      <label class="flex flex-col gap-1"
        >Config TTL (s, 60–86400)
        <input
          v-model.number="f.ttl"
          aria-label="ttl"
          type="number"
          min="60"
          max="86400"
          class="rounded border border-gray-300 px-2 py-1"
        >
      </label>
    </fieldset>
    <fieldset class="grid grid-cols-3 gap-3">
      <legend class="col-span-3 mb-1 text-gray-600">
        Extra redaction (added to the built-in lists; one per line)
      </legend>
      <textarea
        v-model="f.headers"
        aria-label="headers"
        rows="3"
        placeholder="headers"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
      />
      <textarea
        v-model="f.bodyKeys"
        aria-label="JSON keys"
        rows="3"
        placeholder="JSON keys"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
      />
      <textarea
        v-model="f.queryParams"
        aria-label="query params"
        rows="3"
        placeholder="query params"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
      />
    </fieldset>
    <p class="text-gray-400">
      Canvas snapshots are not part of v1 (D-01): <code>canvas.enabled</code> is
      always false.
    </p>
    <div class="flex items-center gap-3">
      <button
        class="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50"
        :disabled="busy"
        data-testid="rc-save"
      >
        Save
      </button>
      <span v-if="saved" class="text-green-700">Saved (v{{ eff.v }})</span>
      <span v-if="error" class="text-red-600">{{ error }}</span>
    </div>
    <details>
      <summary class="cursor-pointer text-gray-500">
        Effective config (what the SDK receives)
      </summary>
      <pre class="mt-2 rounded bg-gray-50 p-2 text-xs">{{
        JSON.stringify(eff, null, 2)
      }}</pre>
    </details>
  </form>
</template>
