/**
 * Worker API client. Every call carries `Authorization: Bearer <token>`; nothing here logs or returns the token.
 * Resolves to one of:
 *   { kind: 'ok', data }
 *   { kind: 'error', status, code, retryAfter? }   the worker answered with an error
 *   { kind: 'unavailable' }                          rejected fetch (no CORS headers on platform errors), 5xx, timeout
 *   { kind: 'aborted' }                              the caller cancelled (a newer request superseded this one)
 */
export function createClient({
  fetchImpl, base, token, timers, timeoutMs = 20000,
}) {
  async function get(path, { signal } = {}) {
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
  return { get };
}
