import type { NitroFetchOptions, NitroFetchRequest } from 'nitropack'

export const CSRF_COOKIE = 'rp_csrf'
export const CSRF_HEADER = 'X-CSRF-Token'

type ApiOptions = NitroFetchOptions<NitroFetchRequest>

/**
 * Typed fetch wrapper for the replayd dashboard API.
 * Sends the session cookie (credentials: 'include') and echoes the
 * double-submit CSRF token from the `rp_csrf` cookie as `X-CSRF-Token`.
 */
export function useApi() {
  const config = useRuntimeConfig()
  const csrf = useCookie<string | null>(CSRF_COOKIE, { readonly: true })

  function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const headers = new Headers(options.headers as HeadersInit | undefined)
    if (csrf.value) headers.set(CSRF_HEADER, csrf.value)
    return $fetch<T>(path, {
      ...options,
      baseURL: config.public.apiBase,
      credentials: 'include',
      headers,
    }) as Promise<T>
  }

  return {
    request,
    get: <T>(path: string, options: ApiOptions = {}) =>
      request<T>(path, { ...options, method: 'GET' }),
    post: <T>(path: string, body?: ApiOptions['body'], options: ApiOptions = {}) =>
      request<T>(path, { ...options, method: 'POST', body }),
    patch: <T>(path: string, body?: ApiOptions['body'], options: ApiOptions = {}) =>
      request<T>(path, { ...options, method: 'PATCH', body }),
    del: <T>(path: string, options: ApiOptions = {}) =>
      request<T>(path, { ...options, method: 'DELETE' }),
  }
}
