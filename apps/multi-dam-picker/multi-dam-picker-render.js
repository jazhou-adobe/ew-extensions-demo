/**
 * Asset picker (Multi-DAM Picker extension): render and logic entry (no side effects at import time).
 *
 * Flow: await the SDK -> list providers from the worker -> browse the chosen provider -> open an asset -> insert.
 * The worker is chosen from the page hostname (config.js); every call carries the SDK's IMS token as a bearer token.
 * Everything is rendered with DOM APIs; the token is never rendered or logged.
 */
import { workerFor } from './config.js';
import { createClient } from './picker/api.js';
import { createBrowser, describeFailure, MESSAGES } from './picker/browse.js';
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

/** Heading before a source is known; with a source it reads "<provider label> Asset Picker". */
const GENERIC_TITLE = 'Asset Picker';

/** Everything under the page heading is replaced by `nodes`; the heading itself is kept. */
function show(root, ...nodes) {
  const heading = root.querySelector(':scope > h1.title') || el('h1', GENERIC_TITLE, { class: 'title' });
  root.replaceChildren(heading, ...nodes);
}

/** Names the picker after the selected source, in the heading and the page title. */
function setTitle(root, text) {
  const heading = root.querySelector(':scope > h1.title');
  if (heading) heading.textContent = text;
  const doc = root.ownerDocument;
  if (doc) doc.title = text;
}

function message(text, { role = 'status' } = {}) {
  return el('p', text, { role, class: 'message' });
}

/** Provider area: optional source switcher plus the browser and the detail pane of the selected provider. */
function mountProviders(root, providers, {
  client, actions, timers, debounceMs, workingMs,
}) {
  const body = el('div', undefined, { class: 'body' });
  let browser;
  let current;

  function openDetail(host, item, button) {
    host.replaceChildren(message(MESSAGES.loading));
    client.get(`/dam/${current.id}/assets/${encodeURIComponent(item.id)}`).then((result) => {
      if (result.kind !== 'ok' || !result.data?.asset) {
        const back = el('button', 'Back to results', { type: 'button' });
        back.addEventListener('click', () => {
          host.replaceChildren();
          button.focus();
        });
        host.replaceChildren(message(describeFailure(result, current.label)), back);
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

  function select(provider) {
    browser?.destroy();
    current = provider;
    setTitle(root, `${provider.label} ${GENERIC_TITLE}`);
    body.replaceChildren();
    if (provider.connection?.state !== 'connected') {
      body.append(message(`${provider.label} is not available: it is not connected.`));
      return;
    }
    const detailHost = el('div', undefined, { class: 'detail-host' });
    browser = createBrowser({
      provider, client, timers, debounceMs, workingMs, onSelect: (item, button) => openDetail(detailHost, item, button),
    });
    body.append(browser.element, detailHost);
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
  const { client } = options;
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
  const { providers } = result.data;
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
    client, actions: sdk.actions, timers, debounceMs, workingMs,
  });
}
