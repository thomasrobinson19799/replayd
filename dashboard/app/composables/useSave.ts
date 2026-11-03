import type { Project } from '~/utils/types'

/** PATCH /api/projects/:pid with busy/error/saved state, shared by the settings tabs */
export function useSave(project: () => Project, emit: (p: Project) => void) {
  const api = useApi()
  const busy = ref(false)
  const error = ref('')
  const saved = ref(false)
  async function save(body: Record<string, unknown>) {
    busy.value = true
    error.value = ''
    saved.value = false
    try {
      emit(await api.patch<Project>(`/projects/${project().id}`, body))
      saved.value = true
    }
    catch (e) {
      error.value = errorMessage(e)
    }
    finally {
      busy.value = false
    }
  }
  return { busy, error, saved, save }
}
