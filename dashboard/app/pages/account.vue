<script setup lang="ts">
import { passwordError } from "~/utils/account";
const session = useSessionStore();
const api = useApi();
const toast = useToast();
const form = reactive({ current_password: "", new_password: "", confirm: "" });
const busy = ref(false);
const error = ref("");
const submitted = ref(false);
const validation = computed(() => passwordError(form.new_password));
async function save() {
  submitted.value = true;
  if (validation.value || form.new_password !== form.confirm || busy.value)
    return;
  busy.value = true;
  error.value = "";
  try {
    await api.post("/me/password", {
      current_password: form.current_password,
      new_password: form.new_password,
    });
    Object.assign(form, {
      current_password: "",
      new_password: "",
      confirm: "",
    });
    submitted.value = false;
    toast.show("Password changed. Your other sessions have been signed out.");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="max-w-2xl">
    <header class="page-heading">
      <div>
        <h1>My account</h1>
        <p>Your identity and sign-in security.</p>
      </div>
    </header>
    <UiCard class="mb-6"
      ><div class="section-heading">
        <h2>{{ session.me?.name || "Your account" }}</h2>
        <UiBadge>{{
          session.isSuperadmin ? "Superadmin" : "Project access"
        }}</UiBadge>
      </div>
      <p>{{ session.me?.email }}</p></UiCard
    ><UiCard
      ><h2>Change password</h2>
      <p class="muted mt-2 mb-6">
        Your current session stays signed in. All other sessions will be signed
        out.
      </p>
      <form class="stack" @submit.prevent="save">
        <UiInput
          v-model="form.current_password"
          label="Current password"
          type="password"
          autocomplete="current-password"
          required
        /><UiInput
          v-model="form.new_password"
          label="New password"
          type="password"
          autocomplete="new-password"
          required
          hint="At least 10 characters."
          :error="submitted ? validation : ''"
        /><UiInput
          v-model="form.confirm"
          label="Confirm new password"
          type="password"
          autocomplete="new-password"
          required
          :error="
            submitted && form.new_password !== form.confirm
              ? 'Passwords do not match.'
              : ''
          "
        />
        <p v-if="error" role="alert" class="field-error">{{ error }}</p>
        <div>
          <UiButton type="submit" variant="primary" :busy="busy"
            >Change password</UiButton
          >
        </div>
      </form></UiCard
    >
  </div>
</template>
