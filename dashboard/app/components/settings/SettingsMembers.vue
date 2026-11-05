<script setup lang="ts">
import type { Project } from "~/utils/types";
interface Member {
  id: number;
  email: string;
  name: string | null;
  role: string;
}
const props = defineProps<{ project: Project }>();
const api = useApi();
const toast = useToast();
const session = useSessionStore();
const members = ref<Member[]>([]);
const loading = ref(true);
const busy = ref(false);
const form = reactive({ email: "", role: "member" });
const error = ref("");
const pending = ref<Member | null>(null);
const confirm = ref(false);
async function load() {
  try {
    members.value = (
      await api.get<{ members: Member[] }>(
        `/projects/${props.project.id}/members`,
      )
    ).members;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function mutate(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
    await load();
    await session.fetchMe();
    toast.show("Project access updated.");
    confirm.value = false;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function add() {
  await mutate(() =>
    api.post(`/projects/${props.project.id}/members`, { ...form }),
  );
  if (!error.value) form.email = "";
}
onMounted(load);
</script>
<template>
  <div class="stack">
    <div>
      <h2>Project members</h2>
      <p class="muted mt-1">
        Admins manage settings. Members triage issues. Viewers cannot see
        network bodies or WebSocket frame contents.
      </p>
    </div>
    <p v-if="error" role="alert" class="field-error">{{ error }}</p>
    <UiSkeleton v-if="loading" /><UiDataTable
      v-else
      label="Project members"
      :columns="[
        { key: 'user', label: 'User' },
        { key: 'role', label: 'Project role' },
        { key: 'actions', label: 'Actions' },
      ]"
      ><tbody>
        <tr v-for="m in members" :key="m.id" data-row>
          <td>{{ m.email }}</td>
          <td>
            <select
              :value="m.role"
              :aria-label="`Role for ${m.email}`"
              :disabled="busy"
              @change="
                mutate(() =>
                  api.request(`/projects/${project.id}/members/${m.id}`, {
                    method: 'PUT',
                    body: { role: ($event.target as HTMLSelectElement).value },
                  }),
                )
              "
            >
              <option
                v-for="r in ['admin', 'member', 'viewer']"
                :key="r"
                :value="r"
              >
                {{ r }}
              </option>
            </select>
          </td>
          <td>
            <UiButton
              variant="danger"
              :disabled="busy"
              @click="
                pending = m;
                confirm = true;
              "
              >Remove</UiButton
            >
          </td>
        </tr>
        <tr v-if="!members.length">
          <td colspan="3">No project members. Superadmins retain access.</td>
        </tr>
      </tbody></UiDataTable
    >
    <form class="form-grid" @submit.prevent="add">
      <UiInput
        v-model="form.email"
        type="email"
        label="Existing user's email"
        required
      /><UiSelect v-model="form.role" label="Project role"
        ><option v-for="r in ['admin', 'member', 'viewer']" :key="r" :value="r">
          {{ r }}
        </option></UiSelect
      >
      <div>
        <UiButton type="submit" variant="primary" :busy="busy"
          >Add member</UiButton
        >
      </div>
    </form>
    <p class="muted text-sm">
      A superadmin can create new accounts from Users.
    </p>
    <UiConfirmDialog
      v-model="confirm"
      title="Remove project access?"
      :description="`${pending?.email} will lose this project's membership. Superadmins retain workspace access.`"
      action="Remove member"
      :busy="busy"
      @confirm="
        mutate(() => api.del(`/projects/${project.id}/members/${pending?.id}`))
      "
    />
  </div>
</template>
