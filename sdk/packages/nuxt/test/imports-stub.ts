// test stand-in for Nuxt's #imports virtual module
export const state = { public: {} as Record<string, unknown>, app: {} as Record<string, unknown> };
export const defineNuxtPlugin = <T>(p: T) => p;
export const useRuntimeConfig = () => ({ public: state.public });
export const useAppConfig = () => state.app;
