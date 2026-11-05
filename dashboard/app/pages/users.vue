<script setup lang="ts">
import { passwordError } from "~/utils/account";
interface User {
  id: number;
  email: string;
  name: string | null;
  is_superadmin: boolean;
  disabled: boolean;
  created_at: number;
}
const session = useSessionStore();
const api = useApi();
const toast = useToast();
const users = ref<User[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const search = ref("");
const sort = ref("name");
const visible = computed(() =>
  users.value
    .filter((u) =>
      `${u.name} ${u.email}`.toLowerCase().includes(search.value.toLowerCase()),
    )
    .sort((a, b) =>
      sort.value === "created"
        ? b.created_at - a.created_at
        : (a.name || a.email).localeCompare(b.name || b.email),
    ),
);
const page = ref(0);
const pageUsers = computed(() => visible.value.slice(page.value * 50, (page.value + 1) * 50));
watch([search, sort], () => { page.value = 0 });
const open = ref(false);
const editing = ref<User | null>(null);
const form = reactive({
  email: "",
  name: "",
  password: "",
  is_superadmin: false,
});
const submitted = ref(false);
const formError = ref("");
const confirm = ref(false);
const pending = ref<{ user: User; kind: "delete" | "disable" } | null>(null);
const pwError = computed(() =>
  !editing.value || form.password ? passwordError(form.password) : "",
);
async function load() {
  loading.value = true;
  error.value = "";
  try {
    users.value = (await api.get<{ users: User[] }>("/users")).users;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
function edit(u: User | null) {
  editing.value = u;
  Object.assign(form, {
    email: u?.email || "",
    name: u?.name || "",
    password: "",
    is_superadmin: u?.is_superadmin || false,
  });
  submitted.value = false;
  formError.value = "";
  open.value = true;
}
async function save() {
  submitted.value = true;
  if (pwError.value || busy.value) return;
  busy.value = true;
  formError.value = "";
  try {
    if (editing.value)
      await api.patch(`/users/${editing.value.id}`, {
        name: form.name,
        is_superadmin: form.is_superadmin,
        ...(form.password ? { password: form.password } : {}),
      });
    else await api.post("/users", { ...form });
    const selfReset = editing.value?.id === session.me?.id && !!form.password;
    open.value = false;
    form.password = "";
    toast.show(
      editing.value
        ? "User updated."
        : "User created. Share their initial password securely.",
    );
    if (selfReset) {
      await session.fetchMe();
      await navigateTo("/login");
    } else await load();
  } catch (e) {
    formError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function ask(u: User, kind: "delete" | "disable") {
  pending.value = { user: u, kind };
  confirm.value = true;
}
async function perform() {
  if (!pending.value || busy.value) return;
  busy.value = true;
  try {
    const { user, kind } = pending.value;
    if (kind === "delete") await api.del(`/users/${user.id}`);
    else await api.patch(`/users/${user.id}`, { disabled: !user.disabled });
    confirm.value = false;
    toast.show(
      kind === "delete"
        ? "User deleted."
        : user.disabled
          ? "User enabled."
          : "User disabled and signed out.",
    );
    await load();
  } catch (e) {
    error.value = errorMessage(e);
    confirm.value = false;
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  if (session.isSuperadmin) load();
  else loading.value = false;
});
watch(open, (v) => {
  if (!v) form.password = "";
});
</script>
<template>
  <section>
    <header class="page-heading">
      <div>
        <h1>Users</h1>
        <p>
          Manage workspace access. Project roles are assigned in project
          settings.
        </p>
      </div>
      <UiButton
        v-if="session.isSuperadmin"
        variant="primary"
        @click="edit(null)"
        >Create user</UiButton
      >
    </header>
    <UiEmptyState
      v-if="!session.isSuperadmin"
      title="Superadmin access required"
      description="Contact your workspace administrator to manage users."
    /><template v-else
      ><div class="mb-5 max-w-sm">
        <UiInput
          v-model="search"
          label="Search users"
          type="search"
          placeholder="Name or email"
        />
      </div>
      <p v-if="error" class="field-error mb-4" role="alert">
        {{ error }} <UiButton @click="load">Try again</UiButton>
      </p>
      <UiSkeleton v-if="loading" /><UiDataTable
        v-else
        label="Workspace users"
        :columns="[
          { key: 'name', label: 'User', sortable: true },
          { key: 'role', label: 'Workspace role' },
          { key: 'state', label: 'Status' },
          { key: 'created', label: 'Created', sortable: true },
          { key: 'actions', label: 'Actions' },
        ]"
        :sort="sort"
        :direction="sort === 'name' ? 'ascending' : 'descending'"
        @sort="sort = $event"
        ><tbody>
          <tr v-for="u in pageUsers" :key="u.id" data-row>
            <td>
              <strong>{{ u.name || u.email }}</strong>
              <p class="muted text-xs">{{ u.email }}</p>
            </td>
            <td>
              <UiBadge>{{
                u.is_superadmin ? "Superadmin" : "Project access"
              }}</UiBadge>
            </td>
            <td>
              <UiBadge :tone="u.disabled ? 'disabled' : 'success'">{{
                u.disabled ? "Disabled" : "Active"
              }}</UiBadge>
            </td>
            <td><UiRelativeTime :value="u.created_at" /></td>
            <td>
              <div class="flex gap-2">
                <UiButton @click="edit(u)">Edit / reset password</UiButton
                ><template v-if="u.id !== session.me?.id"
                  ><UiButton @click="ask(u, 'disable')">{{
                    u.disabled ? "Enable" : "Disable"
                  }}</UiButton
                  ><UiButton variant="danger" @click="ask(u, 'delete')"
                    >Delete</UiButton
                  ></template
                ><span v-else class="badge">You</span>
              </div>
            </td>
          </tr>
          <tr v-if="!visible.length">
            <td colspan="5">
              <UiEmptyState
                title="No users match."
                description="Try another name or email."
              />
            </td>
          </tr></tbody></UiDataTable></template
    ><UiModal v-model="open" :title="editing ? 'Edit user' : 'Create user'"
      ><form class="stack" @submit.prevent="save">
        <UiInput v-model="form.name" label="Name" autocomplete="name" /><UiInput
          v-model="form.email"
          label="Email"
          type="email"
          required
          :disabled="!!editing"
          autocomplete="off"
        /><UiInput
          v-model="form.password"
          :label="editing ? 'Reset password (optional)' : 'Initial password'"
          type="password"
          autocomplete="new-password"
          :required="!editing"
          :error="submitted ? pwError : ''"
          hint="At least 10 characters. Share securely; no invitation email is sent."
        /><label class="flex items-center gap-2"
          ><input
            v-model="form.is_superadmin"
            type="checkbox"
            :disabled="editing?.id === session.me?.id"
          >Superadmin — full access to every project</label
        >
        <p v-if="editing" class="muted text-sm">
          Resetting a password signs out all of this user's sessions.
        </p>
        <p v-if="formError" role="alert" class="field-error">{{ formError }}</p>
        <div class="dialog-actions">
          <UiButton @click="open = false">Cancel</UiButton
          ><UiButton type="submit" variant="primary" :busy="busy">{{
            editing ? "Save user" : "Create user"
          }}</UiButton>
        </div>
      </form></UiModal
    ><UiConfirmDialog
      v-model="confirm"
      :title="
        pending?.kind === 'delete'
          ? 'Delete user?'
          : pending?.user.disabled
            ? 'Enable user?'
            : 'Disable user?'
      "
      :description="
        pending?.kind === 'delete'
          ? `Permanently remove ${pending?.user.email} and their project memberships. This cannot be undone.`
          : `Change access for ${pending?.user.email}. Disabling also signs out all sessions.`
      "
      :busy="busy"
      :action="pending?.kind === 'delete' ? 'Delete user' : 'Confirm change'"
      @confirm="perform"
    />
  </section>
</template>
