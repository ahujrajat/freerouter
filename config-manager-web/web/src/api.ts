export class ApiError extends Error {
  constructor(public status: number, message: string, public messages?: string[]) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  if (res.status === 401) throw new ApiError(401, 'unauthenticated')
  if (!res.ok) {
    let payload: { error?: string; messages?: string[] } = {}
    try { payload = await res.json() } catch { /* ignore */ }
    throw new ApiError(res.status, payload.error ?? `HTTP ${res.status}`, payload.messages)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T = unknown>(url: string) => request<T>('GET', url),
  put: <T = unknown>(url: string, body: unknown) => request<T>('PUT', url, body),
  post: <T = unknown>(url: string, body: unknown) => request<T>('POST', url, body),
  del: <T = unknown>(url: string) => request<T>('DELETE', url),
}
