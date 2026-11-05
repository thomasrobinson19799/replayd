import type { Ref } from "vue";
export function useDirtyForm(value: unknown) {
  const dirty = inject<Ref<boolean> | null>("settings-dirty", null);
  const stop = watch(
    () => JSON.stringify(unref(value)),
    () => {
      if (dirty) dirty.value = true;
    },
  );
  onBeforeUnmount(stop);
}
