export default defineNuxtRouteMiddleware(async (to) => {
  const session = useSessionStore()
  if (!session.loaded) await session.fetchMe()
  if (to.path === '/login') {
    if (session.isAuthenticated) return navigateTo('/')
    return
  }
  if (!session.isAuthenticated) {
    return navigateTo({ path: '/login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} })
  }
})
