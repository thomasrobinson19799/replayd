<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "danger" | "ghost";
    busy?: boolean;
    type?: "button" | "submit" | "reset";
  }>(),
  { variant: "secondary", type: "button" },
);
</script>
<template>
  <button
    :type="type"
    class="ui-button"
    :class="`ui-button--${variant}`"
    :disabled="busy"
    :aria-busy="busy || undefined"
  >
    <span v-if="busy" class="spinner" aria-hidden="true" /><slot />
  </button>
</template>
