import { defineStore } from 'pinia'
import type { Me } from '~/utils/types'

/** Logged-in user (from GET /api/me). `loaded` distinguishes "not fetched yet" from "anonymous". */
export const useSessionStore = defineStore('session', {
  state: () => ({
    me: null as Me | null,
    loaded: false,
  }),
  getters: {
    isAuthenticated: (s): boolean => s.me !== null,
    isSuperadmin: (s): boolean => s.me?.is_superadmin === true,
  },
  actions: {
    async fetchMe(): Promise<Me | null> {
      const api = useApi()
      try {
        this.me = await api.get<Me>('/me')
      }
      catch {
        this.me = null
      }
      this.loaded = true
      return this.me
    },
    async login(email: string, password: string): Promise<void> {
      await useApi().post('/auth/login', { email, password })
      await this.fetchMe()
    },
    async logout(): Promise<void> {
      try {
        await useApi().post('/auth/logout')
      }
      finally {
        this.me = null
      }
    },
    roleIn(projectId: number): string | null {
      if (this.me?.is_superadmin) return 'admin'
      return this.me?.projects.find(p => p.id === projectId)?.role ?? null
    },
  },
})
