import { el, safeHttpsUrl } from './dom.js';
import { buildInsertHtml } from './insert.js';

const ALT_SOURCE_LABELS = {
  property: 'Prefilled from the alt text in the asset metadata.',
  description: 'Prefilled from the asset caption.',
  name: 'Prefilled from the file name.',
  none: 'No alt text was found in the asset. Describe the image or mark it decorative.',
};

const facts = (asset) => [
  asset.type,
  asset.width && asset.height ? `${asset.width} × ${asset.height}` : undefined,
  asset.extension ? asset.extension.toUpperCase() : undefined,
].filter(Boolean).join(' · ');

/**
 * The detail pane for one asset: preview of the selected rendition, rendition choice, alt text (prefilled, editable,
 * "decorative"), warnings and the Insert action. Inserting sends the markup, then closes the library, once.
 */
export function createDetail({ asset, actions, onClose }) {
  const root = el('section', undefined, { class: 'detail', 'aria-labelledby': 'detail-title' });
  const heading = el('h2', asset.name, { id: 'detail-title', tabindex: '-1' });
  const close = el('button', 'Back to results', { type: 'button', class: 'close' });
  close.addEventListener('click', onClose);
  root.append(close, heading, el('p', facts(asset), { class: 'facts' }));

  const isImage = asset.type === 'image';
  const renditions = Array.isArray(asset.renditions) ? asset.renditions : [];
  const preview = el('div', undefined, { class: 'preview' });
  const choose = el('select');
  const alt = el('input', undefined, { type: 'text', value: asset.alt?.value || '' });
  const decorative = el('input', undefined, { type: 'checkbox' });

  const showPreview = () => {
    const rendition = renditions.find((r) => r.id === choose.value);
    const src = safeHttpsUrl(rendition?.url);
    preview.replaceChildren(src ? el('img', undefined, { src, alt: '' }) : el('p', 'No preview available.'));
  };

  if (isImage && renditions.length) {
    renditions.forEach((r) => {
      const size = r.width && r.height ? ` (${r.width} × ${r.height})` : '';
      choose.append(el('option', `${r.label}${size}`, { value: r.id }));
    });
    const known = renditions.some((r) => r.id === asset.defaultRenditionId);
    choose.value = known ? asset.defaultRenditionId : renditions[0].id;
    choose.addEventListener('change', showPreview);
    const rendition = el('label', undefined, { class: 'field' });
    rendition.append(el('span', 'Rendition'), choose);
    const altLabel = el('label', undefined, { class: 'field' });
    altLabel.append(el('span', 'Alt text'), alt);
    const decorativeLabel = el('label', undefined, { class: 'check' });
    decorativeLabel.append(decorative, el('span', 'Decorative image (no alt text)'));
    decorative.addEventListener('change', () => {
      alt.disabled = decorative.checked;
    });
    showPreview();
    const altNote = el('p', ALT_SOURCE_LABELS[asset.alt?.source] || ALT_SOURCE_LABELS.none, { class: 'hint' });
    root.append(preview, rendition, altLabel, altNote, decorativeLabel);
  } else if (!isImage && safeHttpsUrl(asset.linkUrl)) {
    root.append(el('p', 'This asset will be inserted as a link with its name.', { class: 'hint' }));
  }

  (asset.warnings || []).forEach((w) => root.append(el('p', w, { class: 'warning', role: 'note' })));
  const ok = asset.insertable?.ok === true;
  if (!ok) {
    const reason = asset.insertable?.reason || 'This asset cannot be inserted.';
    root.append(el('p', reason, { class: 'warning', role: 'note' }));
  }

  const insert = el('button', isImage ? 'Insert image' : 'Insert link', {
    type: 'button', class: 'insert', disabled: !ok,
  });
  insert.addEventListener('click', () => {
    const html = buildInsertHtml(asset, {
      renditionId: choose.value,
      alt: decorative.checked ? '' : alt.value,
    });
    if (!html) return;
    insert.disabled = true;
    actions.sendHTML(html);
    actions.closeLibrary();
  });
  root.append(insert);

  return { element: root, focus: () => heading.focus() };
}
