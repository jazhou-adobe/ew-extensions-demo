import { el, safeHttpsUrl } from './dom.js';

/**
 * The markup to insert for the author's choice, built with DOM APIs (never string concatenation) so alt text and names
 * stay attribute or text content. Images become one `<img src alt>`; other assets one `<a href>` with the asset name.
 * Returns undefined when the choice has no safe `https:` URL.
 */
export function buildInsertHtml(asset, { renditionId, alt = '' } = {}) {
  const holder = document.createElement('div');
  if (asset.type === 'image') {
    const rendition = asset.renditions?.find((r) => r.id === renditionId);
    const src = safeHttpsUrl(rendition?.url);
    if (!src) return undefined;
    holder.append(el('img', undefined, { src, alt }));
  } else {
    const href = safeHttpsUrl(asset.linkUrl);
    if (!href) return undefined;
    holder.append(el('a', asset.name, { href }));
  }
  return holder.innerHTML;
}
