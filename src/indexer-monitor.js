const SITE_ORIGIN = 'https://oceanliners.net';
const SITEMAP_URL = `${SITE_ORIGIN}/sitemap.xml`;
const BATCH_SIZE = 20;
const STATE_KEY = 'indexer:state';
const SNAPSHOT_KEY = 'indexer:snapshot';
const PAGE_PREFIX = 'indexer:page:';

export async function runIndexerMonitor(env, app) {
  if (!env.CURATOR_INDEXER_RECORDS) throw new Error('CURATOR_INDEXER_RECORDS is not configured.');
  if (!env.AUDIT_TOKEN) throw new Error('AUDIT_TOKEN is not configured.');

  const urls = await discoverPages();
  const state = await env.CURATOR_INDEXER_RECORDS.get(STATE_KEY, 'json') || { cursor: 0 };
  const total = urls.length;
  if (!total) throw new Error('No sitemap pages discovered.');

  const start = Number(state.cursor || 0) % total;
  const batch = [];
  for (let i = 0; i < Math.min(BATCH_SIZE, total); i++) batch.push(urls[(start + i) % total]);

  const results = [];
  for (const url of batch) {
    try {
      const fetched = await internalPost(app, env, '/api/fetch', { url });
      if (!fetched?.ok || !fetched.html) throw new Error(fetched?.error || 'Fetch returned no HTML.');
      const analyzed = await internalPost(app, env, '/api/analyze', { url: fetched.finalUrl || url, html: fetched.html, ships: [] });
      if (!analyzed?.ok || !analyzed.page) throw new Error(analyzed?.error || 'Analyze returned no page data.');
      const page = normalizePageRecord(analyzed.page, fetched);
      await env.CURATOR_INDEXER_RECORDS.put(PAGE_PREFIX + encodeURIComponent(page.path), JSON.stringify(page));
      results.push({ path: page.path, ok: true, pageType: page.pageType });
    } catch (error) {
      const path = toPath(url);
      const failed = { path, url, indexedAt: new Date().toISOString(), ok: false, error: error instanceof Error ? error.message : String(error) };
      await env.CURATOR_INDEXER_RECORDS.put(PAGE_PREFIX + encodeURIComponent(path), JSON.stringify(failed));
      results.push({ path, ok: false, error: failed.error });
    }
  }

  const nextCursor = (start + batch.length) % total;
  await env.CURATOR_INDEXER_RECORDS.put(STATE_KEY, JSON.stringify({ cursor: nextCursor, total, lastRunAt: new Date().toISOString() }));
  const snapshot = await buildSnapshot(env, total, results);
  await env.CURATOR_INDEXER_RECORDS.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function readIndexerSnapshot(env) {
  if (!env.CURATOR_INDEXER_RECORDS) return null;
  return env.CURATOR_INDEXER_RECORDS.get(SNAPSHOT_KEY, 'json');
}

async function discoverPages() {
  const response = await fetch(SITEMAP_URL, { headers: { accept: 'application/xml,text/xml', 'user-agent': 'CuratorOS-Indexer-Monitor/1.0' } });
  if (!response.ok) throw new Error(`Sitemap returned HTTP ${response.status}`);
  const xml = await response.text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => decodeXml(m[1].trim())).filter(isSiteHtmlPage);
  return [...new Set(urls)].sort();
}

async function internalPost(app, env, path, body) {
  const request = new Request(`https://curator-indexer.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-audit-token': env.AUDIT_TOKEN },
    body: JSON.stringify(body)
  });
  const response = await app.fetch(request, env);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `${path} returned HTTP ${response.status}`);
  return data;
}

function normalizePageRecord(page, fetched) {
  const path = toPath(page.url || fetched.finalUrl || fetched.url);
  return {
    ok: true,
    url: page.url || fetched.finalUrl || fetched.url,
    path,
    title: page.title || '',
    description: page.description || '',
    canonical: page.canonical || '',
    pageType: page.pageType || 'page',
    wordCount: Number(page.wordCount || 0),
    textLength: Number(page.textLength || 0),
    internalLinkCount: Array.isArray(page.internalLinks) ? page.internalLinks.length : 0,
    externalLinkCount: Array.isArray(page.externalLinks) ? page.externalLinks.length : 0,
    sourceLinkCount: Array.isArray(page.sourceLinks) ? page.sourceLinks.length : 0,
    imageCount: Array.isArray(page.images) ? page.images.length : 0,
    builderCount: Array.isArray(page.builders) ? page.builders.length : 0,
    shippingLineCount: Array.isArray(page.shippingLines) ? page.shippingLines.length : 0,
    indexedAt: page.indexedAt || new Date().toISOString()
  };
}

async function buildSnapshot(env, sitemapCount, latestBatch) {
  const list = await env.CURATOR_INDEXER_RECORDS.list({ prefix: PAGE_PREFIX, limit: 1000 });
  const pages = [];
  for (const key of list.keys) {
    const record = await env.CURATOR_INDEXER_RECORDS.get(key.name, 'json');
    if (record) pages.push(record);
  }
  const successful = pages.filter(p => p.ok !== false);
  const failed = pages.filter(p => p.ok === false);
  const pageTypes = {};
  let words = 0, internalLinks = 0, externalLinks = 0, images = 0;
  for (const page of successful) {
    const type = page.pageType || 'page';
    pageTypes[type] = (pageTypes[type] || 0) + 1;
    words += Number(page.wordCount || 0);
    internalLinks += Number(page.internalLinkCount || 0);
    externalLinks += Number(page.externalLinkCount || 0);
    images += Number(page.imageCount || 0);
  }
  const coverage = sitemapCount ? (pages.length / sitemapCount) * 100 : 0;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    sitemapPageCount: sitemapCount,
    indexedPageCount: pages.length,
    successfulPageCount: successful.length,
    failedPageCount: failed.length,
    coveragePercent: Math.min(100, coverage),
    pageTypes,
    totals: { words, internalLinks, externalLinks, images },
    latestBatch: { checked: latestBatch.length, failed: latestBatch.filter(x => !x.ok).length, pages: latestBatch },
    recentErrors: failed.sort((a,b)=>String(b.indexedAt||'').localeCompare(String(a.indexedAt||''))).slice(0, 10).map(x => ({ path: x.path, error: x.error || 'Unknown indexing error', indexedAt: x.indexedAt || null }))
  };
}

function isSiteHtmlPage(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== 'oceanliners.net') return false;
    return !/\.(?:jpg|jpeg|png|gif|webp|svg|pdf|xml|json|js|css|zip)$/i.test(url.pathname);
  } catch { return false; }
}
function toPath(value) { try { return new URL(value, SITE_ORIGIN).pathname || '/'; } catch { return String(value || ''); } }
function decodeXml(value) { return String(value).replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'); }
