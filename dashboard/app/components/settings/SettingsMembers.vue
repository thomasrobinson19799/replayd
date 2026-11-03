<script setup lang="ts">
import type { Project } from '~/utils/types'

interface Member { id: number, email: string, name: string | null, role: string }
interface User { id: number, email: string }
const props = defineProps<{ project: Project }>()
const api = useApi()
const session = useSessionStore()
const members = ref<Member[]>([])
const users = ref<User[]>([])
const add = reactive({ user: 0, role: 'member' })
const error = ref('')
async function load() {
  try {
    members.value = (await api.get<{ members: Member[] }>(`/projects/${props.project.id}/members`)).members
    if (session.isSuperadmin) users.value = (await api.get<{ users: User[] }>('/users')).users
  }
  catch (e) {
    error.value = errorMessage(e)
  }
}
async function setRole(uid: number, role: string) {
  try {
    await api.request(`/projects/${props.project.id}/members/${uid}`, { method: 'PUT', body: { role } })
    await load()
  }
  catch (e) {
    error.value = errorMessage(e)
  }
}
async function remove(uid: number) {
  try {
    await api.del(`/projects/${props.project.id}/members/${uid}`)
    await load()
  }
  catch (e) {
    error.value = errorMessage(e)
  }
}
onMounted(load)
</script>

<template>
  <div class="text-sm">
    <table class="w-full">
      <tbody>
        <tr
          v-for="m in members"
          :key="m.id"
          class="border-b border-gray-100"
        >
          <td class="py-1">
            {{ m.email }}
          </td>
          <td>
            <select
              :value="m.role"
              class="rounded border border-gray-300 px-1"
              @change="setRole(m.id, ($event.target as HTMLSelectElement).value)"
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
          <td class="text-right">
            <button
              class="text-red-600 hover:underline"
              @click="remove(m.id)"
            >
              Remove
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <form
      v-if="users.length"
      class="mt-3 flex gap-2"
      @submit.prevent="setRole(add.user, add.role)"
    >
      <select
        v-model.number="add.user"
        class="rounded border border-gray-300 px-1"
      >
        <option
          :value="0"
          disabled
        >
          Add user…
        </option>
        <option
          v-for="u in users.filter((u) => !members.some((m) => m.id === u.id))"
          :key="u.id"
          :value="u.id"
        >
          {{ u.email }}
        </option>
      </select>
      <select
        v-model="add.role"
        class="rounded border border-gray-300 px-1"
      >
        <option
          v-for="r in ['admin', 'member', 'viewer']"
          :key="r"
          :value="r"
        >
          {{ r }}
        </option>
      </select>
      <button
        class="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50"
        :disabled="!add.user"
      >
        Add
      </button>
    </form>
    <p
      v-if="error"
      class="mt-2 text-red-600"
    >
      {{ error }}
    </p>
  </div>
</template>
