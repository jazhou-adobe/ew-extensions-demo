import { el } from './dom.js';
import { describeFailure, MESSAGES } from './browse.js';

const POLL_START_MS = 1500;
const POLL_MAX_MS = 3000;
const POLL_STEP_MS = 250;
const DEADLINE_MS = 5 * 60 * 1000;
const POPUP_FEATURES = 'popup,width=520,height=720';

/**
 * The connect panel of a provider that signs each author in (credential kind `user-oauth`). It knows the provider's
 * label and connection state only: the sign-in itself happens in a pop-up on the worker's own origin, the page never
 * calls the provider. States: not connected (Connect), connected (account and Disconnect), reconnect (Reconnect).
 *
 * `onChange(state, account)` is told about every state change; the caller shows or hides the provider's browser
 * accordingly and remembers the state for when the author switches back to this provider.
 */
export function createConnectPanel({
  provider, connection: initial, client, timers, workerOrigin, openWindow, onChange, deadlineMs = DEADLINE_MS,
}) {
  const root = el('section', undefined, { class: 'connect', 'aria-label': `${provider.label} connection` });
  const status = el('p', undefined, {
    role: 'status', 'aria-live': 'polite', class: 'status connect-status', tabindex: '-1',
  });
  const actions = el('div', undefined, { class: 'connect-actions' });
  root.append(status, actions);

  const connection = { state: initial?.state || 'not_connected', account: initial?.account };
  // `connect` and `disconnect` are used by the buttons rendered before they are defined.
  const act = {};
  let popup;
  let attempt = 0;
  let destroyed = false;

  const button = (text, handler, cls = '') => {
    const b = el('button', text, { type: 'button', class: cls });
    b.addEventListener('click', handler);
    return b;
  };
  const say = (text, ...controls) => {
    status.textContent = text;
    actions.replaceChildren(...controls);
  };
  const closePopup = () => {
    try {
      if (popup && !popup.closed) popup.close();
    } catch {
      // best effort: a window we no longer control
    }
    popup = undefined;
  };

  function render(message) {
    if (connection.state === 'connected') {
      say(
        `Connected as ${connection.account || provider.label}`,
        button('Disconnect', () => act.disconnect(), 'disconnect'),
      );
    } else if (connection.state === 'reauth_required') {
      say(
        message || `Your ${provider.label} connection has expired or was revoked. Connect again to keep browsing.`,
        button('Reconnect', () => act.connect(), 'connect'),
      );
    } else {
      say(
        message || `Connect to ${provider.label} to browse your files.`,
        button(`Connect to ${provider.label}`, () => act.connect(), 'connect'),
      );
    }
  }

  function setState(state, account, { announce = true, message } = {}) {
    connection.state = state;
    connection.account = account ?? connection.account;
    if (state === 'not_connected') connection.account = undefined;
    render(message);
    if (announce) status.focus();
    if (onChange) onChange(state, connection.account);
  }

  /** Failure text for a worker answer; `misconfigured` is an administrator task and never offers Connect. */
  function fail(result, retry) {
    attempt += 1;
    closePopup();
    if (result.code === 'misconfigured') {
      say(describeFailure(result, provider.label));
    } else {
      say(describeFailure(result, provider.label), button('Try again', retry, 'retry'));
    }
    status.focus();
  }

  const wait = (ms) => new Promise((resolve) => {
    timers.setTimeout(resolve, ms);
  });

  async function poll(mine) {
    let elapsed = 0;
    for (let n = 0; ; n += 1) {
      const delay = Math.min(POLL_MAX_MS, POLL_START_MS + n * POLL_STEP_MS);
      // eslint-disable-next-line no-await-in-loop
      await wait(delay);
      elapsed += delay;
      if (destroyed || mine !== attempt) return;
      const closed = !popup || popup.closed;
      // eslint-disable-next-line no-await-in-loop
      const result = await client.get(`/dam/${provider.id}/session`);
      if (destroyed || mine !== attempt) return;
      if (result.kind !== 'ok') {
        fail(result, () => act.connect());
        return;
      }
      const next = result.data?.connection;
      if (next?.state === 'connected') {
        closePopup();
        attempt += 1;
        setState('connected', next.account);
        return;
      }
      if (closed) {
        attempt += 1;
        render(`The ${provider.label} sign-in window was closed before you were connected. Try again.`);
        status.focus();
        return;
      }
      if (elapsed >= deadlineMs) {
        closePopup();
        attempt += 1;
        render(`Connecting to ${provider.label} took too long. Try again.`);
        status.focus();
        return;
      }
    }
  }

  /** A begin URL is only followed when it is `https:` on the worker's own origin. */
  function beginTarget(value) {
    try {
      const url = new URL(value);
      const ok = url.protocol === 'https:' && url.origin === workerOrigin && !url.username && !url.password;
      return ok ? url : undefined;
    } catch {
      return undefined;
    }
  }

  act.connect = async () => {
    // The pop-up opens synchronously in the click handler (before any await) so that browsers allow it.
    closePopup();
    popup = openWindow('about:blank', 'dam-connect', POPUP_FEATURES) || undefined;
    attempt += 1;
    const mine = attempt;
    say(MESSAGES.loading);
    const result = await client.post(`/dam/${provider.id}/connect`);
    if (destroyed || mine !== attempt) return;
    const url = result.kind === 'ok' ? beginTarget(result.data?.beginUrl) : undefined;
    if (result.kind !== 'ok' || !url) {
      fail(result.kind === 'ok' ? { kind: 'error', code: 'unknown' } : result, () => act.connect());
      return;
    }
    if (popup) {
      popup.location.href = url.href;
      say(`Sign in to ${provider.label} in the window that opened. This page updates when you are done.`);
    } else {
      const link = el('a', `Open the ${provider.label} sign-in`, {
        href: url.href, target: '_blank', rel: 'noopener', class: 'connect-link',
      });
      say('Your browser blocked the sign-in window. Open it here, then come back to this page.', link);
    }
    status.focus();
    poll(mine);
  };

  act.disconnect = async () => {
    attempt += 1;
    const mine = attempt;
    say(MESSAGES.loading);
    const result = await client.post(`/dam/${provider.id}/disconnect`);
    if (destroyed || mine !== attempt) return;
    if (result.kind !== 'ok') {
      render();
      say(describeFailure(result, provider.label), button('Disconnect', () => act.disconnect(), 'disconnect'));
      status.focus();
      return;
    }
    setState('not_connected');
  };

  render();
  return {
    element: root,
    state: () => connection.state,
    /** Sets the state from outside (an in-band 409 from the browse area) without announcing a connect result. */
    setState,
    destroy() {
      destroyed = true;
      closePopup();
    },
  };
}
