<script setup lang="ts">
defineProps<{ items: { value: string; label: string }[]; label: string }>();
const model = defineModel<string>({ required: true });
const emit = defineEmits<{ select: [string] }>();
function key(e: KeyboardEvent) {
  const buttons = [
    ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(
      "button",
    ),
  ];
  const i = buttons.indexOf(e.target as HTMLButtonElement);
  const next =
    e.key === "ArrowRight"
      ? (i + 1) % buttons.length
      : e.key === "ArrowLeft"
        ? (i - 1 + buttons.length) % buttons.length
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : -1;
  if (next >= 0) {
    e.preventDefault();
    buttons[next]?.focus();
    buttons[next]?.click();
  }
}
</script>
<template>
  <div class="tabs" role="tablist" :aria-label="label" @keydown="key">
    <button
      v-for="t in items"
      :key="t.value"
      role="tab"
      :aria-selected="model === t.value"
      :tabindex="model === t.value ? 0 : -1"
      :data-testid="`settings-tab-${t.value}`"
      @click="
        emit('select', t.value);
        model = t.value;
      "
    >
      {{ t.label }}
    </button>
  </div>
</template>
