<script setup lang="ts">
import { safeReturnPath } from "~/utils/account";
const session = useSessionStore();
const route = useRoute();
const email = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    await session.login(email.value, password.value);
    const next = safeReturnPath(route.query.next);
    await navigateTo(next);
  } catch (e) {
    const status = (e as { status?: number }).status;
    error.value =
      status === 429
        ? "Too many attempts, try again in a minute."
        : "Invalid email or password.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-panel card">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">▸▸</span>replayd
    </div>
    <h1 class="mb-6 text-xl font-semibold">Sign in to replayd</h1>
    <p class="muted">
      Find the error. Replay the moment. Get back to building.
    </p>
    <form class="space-y-4" @submit.prevent="submit">
      <label class="block text-sm">
        <span class="text-gray-600">Email</span>
        <input
          v-model="email"
          name="email"
          type="email"
          autocomplete="username"
          required
          class="mt-1 w-full rounded border border-gray-300 px-3 py-2"
        >
      </label>
      <label class="block text-sm">
        <span class="text-gray-600">Password</span>
        <input
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          class="mt-1 w-full rounded border border-gray-300 px-3 py-2"
        >
      </label>
      <p v-if="error" class="text-sm text-red-600" role="alert">
        {{ error }}
      </p>
      <button
        type="submit"
        :disabled="busy"
        class="w-full rounded bg-gray-900 px-3 py-2 text-white hover:bg-gray-700 disabled:opacity-50"
      >
        {{ busy ? "Signing in…" : "Sign in" }}
      </button>
    </form>
  </div>
</template>
