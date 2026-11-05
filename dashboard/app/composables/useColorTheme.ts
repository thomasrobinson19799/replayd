export function useColorTheme() {
  const theme = ref('system')
  let media: MediaQueryList | undefined
  function apply() {
    document.documentElement.dataset.theme = theme.value === 'system'
      ? media?.matches ? 'dark' : 'light'
      : theme.value
  }
  function cycleTheme() {
    theme.value = theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system'
    try { localStorage.setItem('replayd-theme', theme.value) } catch { /* Storage may be disabled. */ }
    apply()
  }
  onMounted(() => {
    media = matchMedia('(prefers-color-scheme: dark)')
    try {
      const saved = localStorage.getItem('replayd-theme')
      theme.value = saved && ['system', 'light', 'dark'].includes(saved) ? saved : 'system'
    } catch { /* OS default. */ }
    apply()
    media.addEventListener('change', apply)
  })
  onBeforeUnmount(() => media?.removeEventListener('change', apply))
  return { theme, cycleTheme }
}
