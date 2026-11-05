import type { Project } from "~/utils/types";

/** PATCH /api/projects/:pid with busy/error/saved state, shared by the settings tabs */
export function useSave(project: () => Project, emit: (p: Project) => void) {
  const api = useApi();
  const toast = useToast();
  const dirty = inject<Ref<boolean> | null>("settings-dirty", null);
  const busy = ref(false);
  const error = ref("");
  const saved = ref(false);
  async function save(body: Record<string, unknown>) {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    saved.value = false;
    try {
      emit(await api.patch<Project>(`/projects/${project().id}`, body));
      saved.value = true;
      if (dirty) dirty.value = false;
      toast.show("Settings saved.");
    } catch (e) {
      error.value = errorMessage(e);
      toast.show(error.value, "error");
    } finally {
      busy.value = false;
    }
  }
  return { busy, error, saved, save };
}
