/**
 * auth.ts — global auth-token transport for the OpenLog client.
 *
 * Token contract (agreed with the server):
 *  - HTTP:      `Authorization: Bearer <token>`
 *  - WebSocket: token appended to the URL as `?token=<token>`
 *  - `GET /api/auth/token` -> `{ token }`, reachable only from localhost
 *    (403 elsewhere, which is a normal "no token available" outcome).
 *
 * What this module does
 *  1. Installs ONE idempotent `window.fetch` interceptor, so none of the ~86
 *     raw `fetch()` call sites had to be rewritten. It only touches same-origin
 *     `/api/` requests and only when the caller did not already send an
 *     `Authorization` header.
 *  2. Resolves the token exactly once, in order:
 *     localStorage('openlog_token') -> import.meta.env.VITE_OPENLOG_TOKEN ->
 *     GET /api/auth/token. The promise is cached, so a 403 (not on localhost)
 *     is never retried in a loop.
 *  3. Exposes `withWsToken()` for every `new WebSocket(...)` call site.
 *  4. Surfaces the FIRST 401/403 from an `/api/` request (callback + a
 *     `openlog:auth-error` window event). It never retries and never loops.
 *
 * State is kept on `window`, not in module scope, so React StrictMode double
 * invocation and Vite HMR module re-evaluation cannot produce two independent
 * token states or a second wrapper.
 */

const TOKEN_STORAGE_KEY = 'openlog_token';
const TOKEN_ENDPOINT_PATH = '/api/auth/token';

// Upper bound on the token request. Only reached when the endpoint is genuinely
// unavailable; on loopback it answers in ~2ms. Keeping the request bounded is
// what lets callers await `whenTokenReady()` unconditionally instead of racing
// it against an arbitrary budget (which used to let a slow-but-successful
// response render the app token-less, leaving some sockets permanently 401).
const TOKEN_FETCH_TIMEOUT_MS = 8000;
const INTERCEPTOR_FLAG = '__openlogFetchInterceptorInstalled';
const ORIGINAL_FETCH_KEY = '__openlogOriginalFetch';
const STATE_KEY = '__openlogAuthState';

/** Window event dispatched once when an `/api/` request comes back 401/403. */
export const AUTH_ERROR_EVENT = 'openlog:auth-error';

export interface AuthErrorDetail {
  status: number;
  url: string;
}

type AuthErrorListener = (detail: AuthErrorDetail) => void;

interface AuthState {
  token: string | null;
  /** Cached one-shot resolution; guarantees "never retry in a loop". */
  tokenPromise: Promise<string | null> | null;
  /** Latch: a 401/403 is surfaced once per auth episode, not per request. */
  errorNotified: boolean;
  listeners: Set<AuthErrorListener>;
}

function scope(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

/** Reads (and lazily creates) the window-scoped auth state — HMR safe. */
function authState(): AuthState {
  const global = scope();
  let state = global[STATE_KEY] as AuthState | undefined;
  if (state === undefined) {
    state = {
      token: null,
      tokenPromise: null,
      errorNotified: false,
      listeners: new Set<AuthErrorListener>(),
    };
    global[STATE_KEY] = state;
  }
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public token API
// ─────────────────────────────────────────────────────────────────────────────

export function getToken(): string | null {
  return authState().token;
}

/** Sets the token in memory and persists it to localStorage. */
export function setToken(t: string): void {
  const state = authState();
  state.token = typeof t === 'string' && t.length > 0 ? t : null;
  state.errorNotified = false;
  try {
    if (state.token === null) window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    else window.localStorage.setItem(TOKEN_STORAGE_KEY, state.token);
  } catch {
    // localStorage can be unavailable (private mode / disabled cookies).
    // The in-memory token still works for this session.
  }
}

/** Subscribes to the "auth failed" signal. Returns an unsubscribe function. */
export function onAuthError(listener: AuthErrorListener): () => void {
  const state = authState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * Appends the resolved token to a WebSocket URL:
 *   wss://host/ws            -> wss://host/ws?token=...
 *   wss://host/ws/a?x=1      -> wss://host/ws/a?x=1&token=...
 * Returns the URL unchanged when no token is known.
 */
export function withWsToken(url: string): string {
  const current = getToken();
  if (current === null) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(current)}`;
}

/**
 * Resolves the token once (idempotent). Useful for callers that want to wait
 * for the startup resolution instead of racing it.
 */
export function whenTokenReady(): Promise<string | null> {
  return ensureTokenResolved();
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Installs the interceptor and resolves the token. Called exactly once from
 * `main.tsx`. The cheap synchronous sources are read immediately (so the first
 * render already has a token); the network fallback is fire-and-forget.
 */
export function bootstrapAuth(): void {
  installFetchInterceptor();

  const state = authState();
  if (state.token !== null) return;

  const stored = readStoredToken();
  if (stored !== null) {
    state.token = stored;
    state.errorNotified = false;
    return;
  }

  const fromEnv = readEnvToken();
  if (fromEnv !== null) {
    state.token = fromEnv;
    state.errorNotified = false;
    return;
  }

  void ensureTokenResolved();
}

function readStoredToken(): string | null {
  try {
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

function readEnvToken(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    const value = env?.VITE_OPENLOG_TOKEN;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function ensureTokenResolved(): Promise<string | null> {
  const state = authState();
  if (state.token !== null) return Promise.resolve(state.token);
  if (state.tokenPromise === null) {
    state.tokenPromise = fetchTokenFromServer();
  }
  return state.tokenPromise;
}

/**
 * Single `GET /api/auth/token` attempt. Uses the ORIGINAL fetch (never the
 * patched one) so it cannot recurse into the interceptor. 403 means "not on
 * localhost, no token available" and is a normal outcome.
 */
async function fetchTokenFromServer(): Promise<string | null> {
  const state = authState();
  // Bound the request so `whenTokenReady()` ALWAYS settles. The promise is cached
  // and awaited before the first render and before opening sockets, so a hung
  // request would otherwise block or silently degrade them.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer: ReturnType<typeof setTimeout> | null = controller
    ? setTimeout(() => controller.abort(), TOKEN_FETCH_TIMEOUT_MS)
    : null;
  try {
    const original =
      (scope()[ORIGINAL_FETCH_KEY] as typeof window.fetch | undefined) ?? window.fetch;

    const response = await original.call(window, TOKEN_ENDPOINT_PATH, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (response.status === 403) return null; // not localhost — normal outcome
    if (!response.ok) return null;

    const payload = (await response.json()) as { token?: unknown };
    const resolved =
      typeof payload?.token === 'string' && payload.token.length > 0 ? payload.token : null;

    if (resolved !== null) {
      // Persist via setToken so later cold loads resolve the token synchronously
      // (localStorage is read before render), instead of racing the WS open again.
      setToken(resolved);
    }
    return resolved;
  } catch {
    // Network error / timeout / non-JSON body. The promise is cached, so this is
    // attempted exactly once — no retry loop.
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch interceptor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps `window.fetch` exactly once. The guard is a boolean flag stored on
 * `window` (`__openlogFetchInterceptorInstalled`), so a second call — StrictMode
 * double-invocation, a re-import, or HMR — returns immediately instead of
 * wrapping the already-wrapped function.
 */
export function installFetchInterceptor(): void {
  const global = scope();
  if (global[INTERCEPTOR_FLAG] === true) return;

  const original = window.fetch;
  if (typeof original !== 'function') return; // nothing to wrap
  const originalFetch = original.bind(window);
  global[ORIGINAL_FETCH_KEY] = originalFetch;

  const patchedFetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const rawUrl = inputUrl(input);
    if (rawUrl === null || !isSameOriginApiUrl(rawUrl)) {
      // Not an /api/ request on this origin: leave it completely untouched.
      return originalFetch(input, init);
    }

    const isTokenRequest = isTokenEndpointUrl(rawUrl);
    const state = authState();

    // Wait for the one-shot startup resolution so the first /api/ calls are not
    // sent unauthenticated. The token endpoint itself must never wait (it is
    // what performs the resolution) — that would deadlock.
    if (!isTokenRequest && state.token === null && state.tokenPromise !== null) {
      try {
        await state.tokenPromise;
      } catch {
        // fetchTokenFromServer never rejects, but never let this break fetch.
      }
    }

    let targetInput: RequestInfo | URL = input;
    let targetInit: RequestInit | undefined = init;

    if (state.token !== null) {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        // `fetch(request, init)` semantics: init.headers, when present, fully
        // REPLACES request.headers; method/body/signal/... come from init when
        // present and from the Request otherwise. Rebuilding the Request with
        // the same init spread therefore preserves all of them, and only the
        // Authorization header is added.
        const sourceHeaders =
          init !== undefined && init.headers !== undefined ? init.headers : input.headers;
        const headers = new Headers(sourceHeaders);
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${state.token}`);
          targetInput = new Request(input, { ...(init ?? {}), headers });
          targetInit = undefined;
        }
      } else {
        // string / URL shape: keep the caller's init intact (method, body,
        // signal, credentials, ...) and only replace the headers entry.
        const headers = new Headers(init?.headers ?? undefined);
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${state.token}`);
          targetInit = { ...(init ?? {}), headers };
        }
      }
    }

    const response = await originalFetch(targetInput, targetInit);

    if (!isTokenRequest && (response.status === 401 || response.status === 403)) {
      notifyAuthError({ status: response.status, url: rawUrl });
    }

    return response;
  };

  window.fetch = patchedFetch;
  global[INTERCEPTOR_FLAG] = true;
}

function inputUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return null;
}

function isSameOriginApiUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl, window.location.href);
    if (parsed.origin !== window.location.origin) return false;
    return parsed.pathname === '/api' || parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function isTokenEndpointUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname === TOKEN_ENDPOINT_PATH;
  } catch {
    return false;
  }
}

/** Surfaces an auth failure exactly once per auth episode. Never retries. */
function notifyAuthError(detail: AuthErrorDetail): void {
  const state = authState();
  if (state.errorNotified) return;
  state.errorNotified = true;

  console.warn(
    `[openlog auth] ${detail.status} from ${detail.url} — the client token is missing or rejected.`,
  );

  for (const listener of Array.from(state.listeners)) {
    try {
      listener(detail);
    } catch {
      // A broken listener must not break fetch.
    }
  }

  try {
    window.dispatchEvent(new CustomEvent<AuthErrorDetail>(AUTH_ERROR_EVENT, { detail }));
  } catch {
    // CustomEvent unavailable: listeners already received the callback.
  }
}
