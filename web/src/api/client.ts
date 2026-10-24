/** Thin fetch wrapper for the Mercantile API (proxied to the server at /api by Vite). */

const TOKEN_KEY = 'mercantile.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private mode); the session then lasts until reload.
  }
  memoryToken = token;
}

let memoryToken: string | null = getToken();

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const token = memoryToken ?? getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'offline', 'Can’t reach the game server.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // Vite's proxy answers 502/504 when the API process is not running.
    if (res.status >= 502 && !data?.error) throw new ApiError(0, 'offline', 'Can’t reach the game server.');
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const toCr = (cents: number) => cents / 100;
export const toCents = (cr: number) => Math.round(cr * 100);
