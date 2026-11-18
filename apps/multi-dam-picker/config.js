/**
 * Worker origin for this page (no side effects at import time).
 *
 * The page sends the author's IMS token to the worker, so the worker is a constant keyed by the page's own hostname and
 * never taken from the URL: a crafted `?worker=` link must not be able to redirect the token.
 */

export const WORKERS = {
  stage: 'https://281295-ewextensions-stage.adobeioruntime.net/api/v1/web/multi-dam-picker/api',
  production: 'https://281295-ewextensions.adobeioruntime.net/api/v1/web/multi-dam-picker/api',
};

const CODE_SITE = /^([a-z0-9][a-z0-9-]*)--ew-extensions--jazhou-adobe\.(aem\.live|aem\.page|preview\.da\.live)$/;
// DA test site that vendors this page (`npm run package:extension`); it is a test site, so every ref uses Stage.
const TEST_SITE = /^[a-z0-9][a-z0-9-]*--ew-extensions-demo--jazhou-adobe\.(aem\.live|aem\.page|preview\.da\.live)$/;

/**
 * Which worker serves this page: `main` code-site pages use Production; other refs, the DA test site and `localhost`
 * use Stage; anything else none.
 */
export function workerFor(hostname) {
  if (hostname === 'localhost' || TEST_SITE.test(hostname)) return { env: 'stage', base: WORKERS.stage };
  const m = CODE_SITE.exec(hostname);
  if (!m) return null;
  return m[1] === 'main' ? { env: 'production', base: WORKERS.production } : { env: 'stage', base: WORKERS.stage };
}
