/**
 * Asset picker (Multi-DAM Picker extension): render and logic entry (no side effects at import time).
 *
 * Flow: await the SDK -> list providers from the worker -> browse the chosen provider -> open an asset -> insert.
 * The worker is chosen from the page hostname (config.js); every call carries the SDK's IMS token as a bearer token.
 * Everything is rendered with DOM APIs; the token is never rendered or logged.
 *
 * One page, several library rows: a `?source=<provider id>` parameter on the row's path pins the picker to that one
 * source (no source dropdown). Without it, every configured source is offered. The title authors see is the library
 * row's title (EW shows it on the dialog), so the page renders no heading of its own.
 */
import { workerFor } from './config.js';
import { authLostState, createClient } from './picker/api.js';
import { createBrowser, describeFailure, MESSAGES } from './picker/browse.js';
import { createConnectPanel } from './picker/connect.js';
import { createDetail } from './picker/detail.js';
import { el } from './picker/dom.js';

const NO_PROVIDER = 'No DAM is configured on this site. '
  + 'Ask your administrator to set up a provider in the worker settings (see the README).';
const STANDALONE_TIMEOUT_MS = 5000;
const DEBOUNCE_MS = 350;
const WORKING_MS = 3000;
const WORKER_TIMEOUT_MS = 20000;

function realTimers() {
  return {
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}

/** Everything in the picker is replaced by `nodes`. */
function show(root, ...nodes) {
  root.replaceChildren(...nodes);
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The source pinned by the page URL (`?source=<provider id>`), lower-cased, or `undefined` when none is set.
 * An invalid value is returned as `null` so it reports "not configured" instead of silently showing every source.
 */
export function pinnedSource(search) {
  const raw = new URLSearchParams(search).get('source');
  if (raw === null || raw.trim() === '') return undefined;
  const id = raw.trim().toLowerCase();
  return SOURCE_ID.test(id) ? id : null;
}

function message(text, { role = 'status' } = {}) {
  return el('p', text, { role, class: 'message' });
}

/** Provider area: optional source switcher plus the browser and the detail pane of the selected provider. */
function mountProviders(root, providers, {
  client, actions, timers, debounceMs, workingMs, openWindow, workerOrigin,
}) {
  const body = el('div', undefined, { class: 'body' });
  let browser;
  let panel;
  let current;
  // The latest connection state of each provider (it changes without the provider list being fetched again).
  const connections = new Map(providers.map((p) => [p.id, p.connection]));

  /** The connection ended (revoked, disconnected elsewhere): show Connect or Reconnect and clear the results. */
  function authLost(provider, state) {
    if (current !== provider) {
      // The author switched to another source meanwhile: remember it for when they come back.
      connections.set(provider.id, { state, account: connections.get(provider.id)?.account });
      return;
    }
    panel?.setState(state, connections.get(provider.id)?.account);
  }

  function openDetail(host, item, button) {
    const provider = current;
    host.replaceChildren(message(MESSAGES.loading));
    client.get(`/dam/${provider.id}/assets/${encodeURIComponent(item.id)}`).then((result) => {
      const lost = authLostState(result);
      if (lost) {
        host.replaceChildren();
        authLost(provider, lost);
        return;
      }
      if (result.kind !== 'ok' || !result.data?.asset) {
        const back = el('button', 'Back to results', { type: 'button' });
        back.addEventListener('click', () => {
          host.replaceChildren();
          button.focus();
        });
        host.replaceChildren(message(describeFailure(result, provider.label)), back);
        return;
      }
      const detail = createDetail({
        asset: result.data.asset,
        actions,
        onClose: () => {
          host.replaceChildren();
          browser.focusItem(item.id);
        },
      });
      host.replaceChildren(detail.element);
      detail.focus();
    });
  }

  /** The grid and detail pane of a provider that is connected (or needs no connection), side by side when wide. */
  function mountBrowser(provider, host) {
    const detailHost = el('div', undefined, { class: 'detail-host' });
    browser = createBrowser({
      provider,
      client,
      timers,
      debounceMs,
      workingMs,
      onSelect: (item, button) => openDetail(detailHost, item, button),
      onAuthLost: (state) => authLost(provider, state),
    });
    const results = el('div', undefined, { class: 'results' });
    results.append(browser.element, detailHost);
    host.replaceChildren(results);
  }

  function select(provider) {
    browser?.destroy();
    browser = undefined;
    panel?.destroy();
    panel = undefined;
    current = provider;
    body.replaceChildren();
    if (provider.credentialKind === 'user-oauth') {
      // Each author connects their own account: the panel owns the connection, the browser appears once connected.
      const area = el('div', undefined, { class: 'browse-area' });
      panel = createConnectPanel({
        provider,
        connection: connections.get(provider.id),
        client,
        timers,
        workerOrigin,
        openWindow,
        onChange: (state, account) => {
          connections.set(provider.id, { state, account });
          browser?.destroy();
          browser = undefined;
          if (state === 'connected') mountBrowser(provider, area);
          else area.replaceChildren();
        },
      });
      body.append(panel.element, area);
      if (connections.get(provider.id)?.state === 'connected') mountBrowser(provider, area);
      return;
    }
    if (connections.get(provider.id)?.state !== 'connected') {
      body.append(message(`${provider.label} is not available right now.`));
      return;
    }
    mountBrowser(provider, body);
  }

  const nodes = [];
  if (providers.length > 1) {
    const switcher = el('select');
    providers.forEach((p) => switcher.append(el('option', p.label, { value: p.id })));
    switcher.addEventListener('change', () => select(providers.find((p) => p.id === switcher.value)));
    const wrap = el('label', undefined, { class: 'field source' });
    wrap.append(el('span', 'Source'), switcher);
    nodes.push(wrap);
  }
  select(providers[0]);
  show(root, ...nodes, body);
}

async function loadProviders(root, options) {
  const { client, source } = options;
  show(root, message(MESSAGES.loading));
  const workingTimer = options.timers.setTimeout(() => show(root, message(MESSAGES.working)), options.workingMs);
  const result = await client.get('/dam/providers');
  options.timers.clearTimeout(workingTimer);
  if (result.kind !== 'ok' || !Array.isArray(result.data?.providers)) {
    const retry = el('button', 'Try again', { type: 'button' });
    retry.addEventListener('click', () => loadProviders(root, options));
    show(root, message(describeFailure(result.kind === 'ok' ? { kind: 'unavailable' } : result, 'The picker')), retry);
    return;
  }
  let { providers } = result.data;
  if (source !== undefined) {
    providers = providers.filter((p) => p.id === source);
    if (!providers.length) {
      show(root, message('The source set for this picker is not configured. '
        + 'Check the `source` parameter of the library row path (see the README).'));
      return;
    }
  }
  if (!providers.length) {
    show(root, message(NO_PROVIDER));
    return;
  }
  mountProviders(root, providers, options);
}

/**
 * Renders the picker into `root` from the SDK promise. Resolves once the first state is rendered.
 */
export async function mountPicker(root, sdkPromise, {
  timeoutMs = STANDALONE_TIMEOUT_MS,
  fetchImpl = (...args) => fetch(...args),
  hostname = window.location.hostname,
  timers = realTimers(),
  debounceMs = DEBOUNCE_MS,
  workingMs = WORKING_MS,
  workerTimeoutMs = WORKER_TIMEOUT_MS,
  openWindow = (...args) => window.open(...args),
  search = window.location.search,
} = {}) {
  show(root, message('Waiting for Experience Workspace…'));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = timers.setTimeout(() => resolve(null), timeoutMs);
  });
  const sdk = await Promise.race([sdkPromise, timeout]);
  timers.clearTimeout(timer);
  if (!sdk) {
    show(root, message('Not running inside Experience Workspace. Open this page from the library in da.live.'));
    return;
  }
  const worker = workerFor(hostname);
  if (!worker) {
    show(root, message('The picker is not available here: no worker is configured for this page address.'));
    return;
  }
  if (!sdk.token) {
    show(root, message('No token is available to call the worker. Reload the library.'));
    return;
  }
  const client = createClient({
    fetchImpl, base: worker.base, token: sdk.token, timers, timeoutMs: workerTimeoutMs,
  });
  await loadProviders(root, {
    client,
    actions: sdk.actions,
    timers,
    debounceMs,
    workingMs,
    openWindow,
    workerOrigin: new URL(worker.base).origin,
    source: pinnedSource(search),
  });
}
