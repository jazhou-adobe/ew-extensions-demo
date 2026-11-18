/** Small DOM helpers. Everything is built with DOM APIs and `textContent`; nothing is ever assembled as HTML text. */

export function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  Object.entries(attrs).forEach(([k, v]) => {
    if (v === true) node.setAttribute(k, '');
    else if (v !== false && v !== undefined && v !== null) node.setAttribute(k, String(v));
  });
  return node;
}

const INLINE_IMAGE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** An `https:` URL, or an inline jpeg/png/webp data URI when `allowInline`; anything else is not displayable. */
export function safeImageUrl(value, { allowInline = false } = {}) {
  if (typeof value !== 'string' || !value) return undefined;
  if (allowInline && INLINE_IMAGE.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

export const safeHttpsUrl = (value) => safeImageUrl(value);

/** Short file-type label for the placeholder shown instead of a missing thumbnail. */
export function placeholderLabel(item) {
  const ext = typeof item.extension === 'string' && item.extension ? item.extension : item.type;
  return String(ext || 'file').slice(0, 5).toUpperCase();
}
