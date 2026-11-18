/**
 * Worker API client (`get` and `post`; neither sends a body). Every call carries `Authorization: Bearer <token>`;
 * nothing here logs or returns the token.
 * Resolves to one of:
 *   { kind: 'ok', data }
 *   { kind: 'error', status, code, retryAfter? }   the worker answered with an error
 *   { kind: 'unavailable' }                          rejected fetch (no CORS headers on platform errors), 5xx, timeout
 *   { kind: 'aborted' }                              the caller cancelled (a newer request superseded this one)
 */
export function createClient({
  fetchImpl, base, token, timers, timeoutMs = 20000,
}) {
  async function request(method, path, { signal } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return { kind: 'aborted' };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        if (res.ok || res.status >= 500) return { kind: 'unavailable' };
        return { kind: 'error', status: res.status, code: 'unknown' };
      }
      // A server error is "unavailable" for the author, except the worker's own `misconfigured` (admin task).
      if (res.status >= 500 && body?.error?.code !== 'misconfigured') return { kind: 'unavailable' };
      if (res.ok) return { kind: 'ok', data: body };
      const retry = Number(res.headers.get('retry-after'));
      return {
        kind: 'error',
        status: res.status,
        code: typeof body?.error?.code === 'string' ? body.error.code : 'unknown',
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
      };
    } catch {
      return timedOut || !signal?.aborted ? { kind: 'unavailable' } : { kind: 'aborted' };
    } finally {
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return {
    get: (path, options) => request('GET', path, options),
    post: (path, options) => request('POST', path, options),
  };
}

const AUTH_CODES = {
  provider_reauth_required: 'reauth_required',
  provider_not_connected: 'not_connected',
};

/** The connection state an in-band worker error asks for (`provider_reauth_required`, `provider_not_connected`). */
export const authLostState = (result) => (result?.kind === 'error' ? AUTH_CODES[result.code] : undefined);
