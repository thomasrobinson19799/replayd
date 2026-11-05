import * as vue from "vue";
import { vi } from "vitest";
for (const name of [
  "ref",
  "reactive",
  "computed",
  "watch",
  "onMounted",
  "onBeforeUnmount",
  "nextTick",
  "inject",
  "provide",
  "useId",
] as const)
  vi.stubGlobal(name, vue[name]);
