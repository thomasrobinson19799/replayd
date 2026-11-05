<script setup lang="ts">
const { messages } = useToast();
</script>
<template>
  <div class="toasts" aria-live="polite" aria-atomic="false">
    <div
      v-for="m in messages"
      :key="m.id"
      class="toast"
      :class="`toast--${m.tone}`"
    >
      <span>{{ m.text }}</span
      ><button
        aria-label="Dismiss notification"
        @click="messages = messages.filter((x) => x.id !== m.id)"
      >
        ✕
      </button>
    </div>
  </div>
</template>
