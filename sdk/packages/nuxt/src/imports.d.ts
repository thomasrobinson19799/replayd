// Nuxt virtual module, resolved by the host app's build (types only, for this package's own type check)
declare module '#imports' {
  export const defineNuxtPlugin: <T>(p: T) => T;
  export const useRuntimeConfig: () => { public: Record<string, unknown> };
  export const useAppConfig: () => Record<string, unknown>;
}
