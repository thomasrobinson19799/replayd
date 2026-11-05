<script setup lang="ts">
defineProps<{ title: string }>();
const open = defineModel<boolean>({ default: false });
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = useId();
let previous: HTMLElement | null = null;
watch(
  open,
  async (v) => {
    await nextTick();
    if (v) {
      previous = document.activeElement as HTMLElement;
      dialog.value?.showModal();
    } else {
      dialog.value?.close();
      previous?.focus();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  dialog.value?.close();
  previous?.focus();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="modal"
    :aria-labelledby="titleId"
    @cancel.prevent="open = false"
    @close="open = false"
    @click="$event.target === dialog && (open = false)"
  >
    <div class="modal-content">
      <header class="section-heading">
        <h2 :id="titleId">{{ title }}</h2>
        <UiButton
          variant="ghost"
          aria-label="Close dialog"
          @click="open = false"
          >✕</UiButton
        >
      </header>
      <slot />
    </div>
  </dialog>
</template>
