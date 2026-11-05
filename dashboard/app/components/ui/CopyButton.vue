<script setup lang="ts">
const props = withDefaults(defineProps<{ text: string; label?: string }>(), {
  label: "Copy",
});
const copied = ref(false);
const error = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    error.value = "";
    clearTimeout(timer);
    timer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    error.value = "Copy unavailable. Select and copy the text.";
  }
}
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <span class="copy-control"
    ><UiButton :aria-label="label" @click="copy">{{
      copied ? "Copied" : label
    }}</UiButton
    ><small v-if="error" role="alert">{{ error }}</small
    ><span class="sr-only" role="status">{{
      copied ? "Copied to clipboard" : ""
    }}</span></span
  >
</template>
