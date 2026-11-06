<script setup lang="ts">
import type { Frame } from '~/utils/types'
import { visibleFrames } from '~/utils/copy-stack'

const props = defineProps<{ frames: Frame[], raw?: string }>()
const inAppOnly = defineModel<boolean>('inAppOnly', { default: true })
const showRaw = ref(false)

const hasInApp = computed(() => props.frames.some(f => f.in_app))
const shown = computed(() =>
  visibleFrames(props.frames, inAppOnly.value),
)

function location(f: Frame): string {
  if (f.orig) return `${f.orig.file}:${f.orig.line}:${f.orig.col}`
  if (!f.path && !f.url) return '[native code]'
  return `${f.path || f.url}:${f.line}:${f.col}`
}
</script>

<template>
  <div>
    <div class="mb-2 flex items-center gap-4 text-xs text-gray-600">
      <label
        v-if="hasInApp"
        class="flex items-center gap-1"
      >
        <input
          v-model="inAppOnly"
          type="checkbox"
        > In-app frames only
      </label>
      <button
        v-if="raw"
        class="underline"
        @click="showRaw = !showRaw"
      >
        {{ showRaw ? 'Parsed' : 'Raw' }} stack
      </button>
    </div>
    <pre
      v-if="showRaw"
      class="overflow-x-auto rounded bg-gray-900 p-3 text-xs text-gray-100"
    >{{ raw }}</pre>
    <ol
      v-else
      class="divide-y divide-gray-100 rounded border border-gray-200 bg-white font-mono text-xs"
    >
      <li
        v-for="(f, i) in shown"
        :key="i"
        class="px-3 py-2"
        :class="f.in_app ? '' : 'text-gray-400'"
      >
        <div>
          <span class="font-semibold">{{ f.orig?.function || f.function || '<anonymous>' }}</span>
          <span class="ml-2">{{ location(f) }}</span>
          <span
            v-if="!f.orig && f.in_app"
            class="ml-2 rounded bg-gray-100 px-1 text-[10px] text-gray-500"
            title="No source map uploaded for this release"
          >minified</span>
        </div>
        <div
          v-if="f.orig?.context"
          class="mt-1 overflow-x-auto rounded bg-gray-50 py-1"
        >
          <div
            v-for="(l, k) in f.orig.pre ?? []"
            :key="`pre${k}`"
            class="whitespace-pre px-2 text-gray-500"
          >
            {{ f.orig.line - (f.orig.pre?.length ?? 0) + k }}  {{ l }}
          </div>
          <div class="whitespace-pre bg-red-50 px-2 text-gray-900">
            {{ f.orig.line }}  {{ f.orig.context }}
          </div>
          <div
            v-for="(l, k) in f.orig.post ?? []"
            :key="`post${k}`"
            class="whitespace-pre px-2 text-gray-500"
          >
            {{ f.orig.line + 1 + k }}  {{ l }}
          </div>
        </div>
      </li>
      <li
        v-if="!shown.length"
        class="px-3 py-2 text-gray-500"
      >
        No stack trace.
      </li>
    </ol>
  </div>
</template>
