<script setup lang="ts">
defineOptions({ inheritAttrs: false });
defineProps<{ label: string; error?: string }>();
const model = defineModel<string>({ default: "" });
const id = useId();
</script>
<template>
  <div class="field">
    <label :for="id">{{ label }}</label
    ><textarea
      :id="id"
      v-model="model"
      v-bind="$attrs"
      :aria-invalid="!!error"
      :aria-describedby="error ? `${id}-error` : undefined"
    /><small v-if="error" :id="`${id}-error`" class="field-error">{{
      error
    }}</small>
  </div>
</template>
