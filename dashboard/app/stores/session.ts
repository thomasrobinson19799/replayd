import { defineStore } from 'pinia'

export interface CurrentUser {
  id: string
  email: string
  superadmin: boolean
}

/** Auth state placeholder; populated by the login flow in T-18. */
export const useSessionStore = defineStore('session', {
  state: () => ({
    user: null as CurrentUser | null,
  }),
  getters: {
    isAuthenticated: (state): boolean => state.user !== null,
  },
})
