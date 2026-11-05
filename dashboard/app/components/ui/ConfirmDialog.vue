<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    description: string;
    action?: string;
    busy?: boolean;
  }>(),
  { action: "Confirm" },
);
const open = defineModel<boolean>({ default: false });
defineEmits<{ confirm: [] }>();
</script>
<template>
  <UiModal v-model="open" :title="title"
    ><p class="muted">{{ description }}</p>
    <div class="dialog-actions">
      <UiButton :disabled="busy" @click="open = false">Cancel</UiButton
      ><UiButton variant="danger" :busy="busy" @click="$emit('confirm')">{{
        action
      }}</UiButton>
    </div></UiModal
  >
</template>
