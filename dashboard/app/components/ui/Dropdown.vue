<script setup lang="ts">
defineProps<{ label: string }>();
const root = ref<HTMLDetailsElement | null>(null);
function close(e: Event) {
  if (root.value && !root.value.contains(e.target as Node))
    root.value.open = false;
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape" && root.value) {
    root.value.open = false;
    root.value.querySelector("summary")?.focus();
  }
}
onMounted(() => document.addEventListener("pointerdown", close));
onBeforeUnmount(() => document.removeEventListener("pointerdown", close));
</script>
<template>
  <details ref="root" class="dropdown" @keydown="key">
    <summary>{{ label }} <span aria-hidden="true">⌄</span></summary>
    <div
      class="dropdown-panel"
      @click="
        (e) => {
          if ((e.target as HTMLElement).closest('a,button') && root)
            root.open = false;
        }
      "
    >
      <slot />
    </div>
  </details>
</template>
