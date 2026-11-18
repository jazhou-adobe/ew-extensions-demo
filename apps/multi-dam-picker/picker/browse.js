import { el, placeholderLabel, safeImageUrl } from './dom.js';
import { authLostState } from './api.js';

const PAGE_SIZE = 24;
const TYPE_LABELS = {
  image: 'Images', video: 'Videos', document: 'Documents', audio: 'Audio',
};

export const MESSAGES = {
  loading: 'Loading…',
  working: 'Still working… the service may be starting up.',
  empty: 'No assets found.',
  unavailable: 'The service is unavailable. Try again in a moment.',
  generic: 'Something went wrong. Try again.',
  unauthorized: 'Your Experience Workspace session could not be verified. Reload the library and try again.',
  forbidden: 'This page is not allowed to use the picker.',
  notFound: 'That item could not be found.',
};

/** Plain-language text for a failed call (never a stack trace, never upstream text). */
export function describeFailure(result, label) {
  if (result.kind === 'unavailable') return MESSAGES.unavailable;
  if (result.code === 'rate_limited') {
    return result.retryAfter
      ? `${label} is limiting requests. Try again in ${result.retryAfter} seconds.`
      : `${label} is limiting requests. Try again in a minute.`;
  }
  if (result.code === 'misconfigured') return `${label} is not set up correctly. Ask your administrator.`;
  if (result.status === 401 || result.code === 'unauthorized') return MESSAGES.unauthorized;
  if (result.status === 403) return MESSAGES.forbidden;
  if (result.code === 'not_found') return MESSAGES.notFound;
  return MESSAGES.generic;
}

function labelled(text, control) {
  const wrap = el('label', undefined, { class: 'field' });
  wrap.append(el('span', text), control);
  return wrap;
}

function thumbnail(item) {
  const box = el('span', undefined, { class: 'thumb' });
  const src = safeImageUrl(item.thumbnailUrl, { allowInline: true });
  if (src) box.append(el('img', undefined, { src, alt: '', loading: 'lazy' }));
  else box.append(el('span', placeholderLabel(item), { class: 'placeholder', 'aria-hidden': 'true' }));
  return box;
}

/**
 * One provider's browse view: toolbar (search, type, sort), grid, "Load more". The capabilities of the provider
 * drive the filter and sort options. Searching is debounced; a newer search always wins over an older one.
 */
export function createBrowser({
  provider, client, timers, debounceMs, workingMs, onSelect, onAuthLost,
}) {
  const caps = provider.capabilities;
  const root = el('section', undefined, { class: 'browser', 'aria-label': `${provider.label} assets` });
  const state = {
    q: '',
    type: 'all',
    sort: caps.defaultSort,
    items: [],
    page: 0,
    total: undefined,
    hasMore: false,
    seq: 0,
    controller: undefined,
  };
  let debounce;
  let working;
  let blockTimer;

  const search = el('input', undefined, { type: 'search', autocomplete: 'off', placeholder: 'Search assets' });
  const type = el('select');
  type.append(el('option', 'All types', { value: 'all' }));
  caps.assetTypes.forEach((t) => type.append(el('option', TYPE_LABELS[t] || t, { value: t })));
  const sort = el('select');
  caps.sorts.forEach((s) => sort.append(el('option', s.label, { value: s.id })));
  sort.value = state.sort;
  const form = el('form', undefined, { role: 'search', class: 'toolbar' });
  form.append(labelled('Search', search), labelled('Type', type), labelled('Sort', sort));

  const status = el('p', undefined, { role: 'status', 'aria-live': 'polite', class: 'status' });
  const retry = el('button', 'Try again', { type: 'button', hidden: true, class: 'retry' });
  const grid = el('ul', undefined, { class: 'grid', 'aria-label': 'Assets' });
  const more = el('button', 'Load more', { type: 'button', hidden: true, class: 'more' });
  const hint = el('p', undefined, { class: 'hint', hidden: true });
  root.append(form, status, retry, grid, hint, more);

  const setStatus = (text, { canRetry = false } = {}) => {
    status.textContent = text;
    retry.hidden = !canRetry;
  };
  const controls = [search, type, sort, more];
  const setBlocked = (blocked) => {
    controls.forEach((c) => c.toggleAttribute('disabled', blocked));
  };

  function syncSortOptions() {
    const hasQuery = Boolean(search.value.trim());
    caps.sorts.forEach((s, i) => {
      sort.options[i].disabled = Boolean(s.requiresQuery) && !hasQuery;
    });
    if (sort.options[sort.selectedIndex]?.disabled) {
      sort.value = caps.defaultSort;
      state.sort = caps.defaultSort;
    }
  }

  function renderItems(from) {
    state.items.slice(from).forEach((item) => {
      const li = el('li');
      const button = el('button', undefined, {
        type: 'button', class: 'item', 'data-id': item.id, 'aria-label': `${item.name} (${item.type})`,
      });
      button.append(thumbnail(item), el('span', item.name, { class: 'name', 'aria-hidden': 'true' }));
      if (item.warnings?.length) button.append(el('span', item.warnings[0], { class: 'badge' }));
      button.addEventListener('click', () => onSelect(item, button));
      li.append(button);
      grid.append(li);
    });
  }

  async function run({ append = false } = {}) {
    timers.clearTimeout(debounce);
    state.controller?.abort();
    state.seq += 1;
    const { seq } = state;
    const controller = new AbortController();
    state.controller = controller;
    const page = append ? state.page + 1 : 1;
    const params = new URLSearchParams({
      type: state.type, sort: state.sort, page: String(page), pageSize: String(PAGE_SIZE),
    });
    if (state.q.trim()) params.set('q', state.q.trim());
    setStatus(MESSAGES.loading);
    root.setAttribute('aria-busy', 'true');
    more.disabled = true;
    timers.clearTimeout(working);
    working = timers.setTimeout(() => {
      if (seq === state.seq) setStatus(MESSAGES.working);
    }, workingMs);
    const result = await client.get(`/dam/${provider.id}/assets?${params}`, { signal: controller.signal });
    timers.clearTimeout(working);
    if (seq !== state.seq || result.kind === 'aborted') return;
    root.removeAttribute('aria-busy');
    more.disabled = false;
    // The connection ended in between (revoked, disconnected elsewhere): the owner of this view shows Connect again.
    if (onAuthLost && authLostState(result)) {
      onAuthLost(authLostState(result));
      return;
    }
    if (result.kind !== 'ok') {
      setStatus(describeFailure(result, provider.label), { canRetry: result.code !== 'rate_limited' });
      if (!append) {
        grid.replaceChildren();
        state.items = [];
        state.page = 0;
      }
      more.hidden = true;
      if (result.code === 'rate_limited') {
        setBlocked(true);
        const wait = Math.max(1, result.retryAfter || 60);
        blockTimer = timers.setTimeout(() => {
          setBlocked(false);
          setStatus('You can search again.', { canRetry: false });
        }, wait * 1000);
      }
      return;
    }
    const { data } = result;
    const known = new Set(append ? state.items.map((i) => i.id) : []);
    const fresh = (Array.isArray(data.items) ? data.items : []).filter((i) => i && !known.has(i.id));
    const from = append ? state.items.length : 0;
    if (!append) {
      grid.replaceChildren();
      state.items = [];
    }
    state.items.push(...fresh);
    state.page = page;
    state.total = Number.isInteger(data.total) ? data.total : undefined;
    state.hasMore = data.hasMore === true;
    renderItems(from);
    more.hidden = !state.hasMore;
    const narrow = !state.hasMore && state.total !== undefined && state.total > state.items.length;
    hint.hidden = !narrow;
    hint.textContent = narrow
      ? `Showing the first ${state.items.length} of ${state.total} matches. Narrow your search to see more.` : '';
    setStatus(state.items.length ? `${state.items.length} assets` : MESSAGES.empty);
  }

  search.addEventListener('input', () => {
    state.q = search.value;
    syncSortOptions();
    timers.clearTimeout(debounce);
    debounce = timers.setTimeout(() => run(), debounceMs);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    state.q = search.value;
    syncSortOptions();
    run();
  });
  type.addEventListener('change', () => {
    state.type = type.value;
    run();
  });
  sort.addEventListener('change', () => {
    state.sort = sort.value;
    run();
  });
  more.addEventListener('click', () => run({ append: true }));
  retry.addEventListener('click', () => run({ append: state.page > 0 }));

  syncSortOptions();
  run();

  return {
    element: root,
    focusItem(id) {
      grid.querySelector(`button[data-id="${CSS.escape(id)}"]`)?.focus();
    },
    destroy() {
      state.seq += 1;
      state.controller?.abort();
      [debounce, working, blockTimer].forEach((t) => timers.clearTimeout(t));
    },
  };
}
