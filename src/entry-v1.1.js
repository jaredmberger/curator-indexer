import app from './index.js';
import { runIndexerMonitor, readIndexerSnapshot } from './indexer-monitor.js';

const VERSION = '1.1';
const CALLBACK_RE = /^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)*$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/curator-intelligence') {
      const snapshot = await readIndexerSnapshot(env);
      return intelligenceResponse(buildIntelligencePayload(snapshot), url.searchParams.get('callback'));
    }

    if (url.pathname === '/api/indexer-snapshot' && request.method === 'GET') {
      const snapshot = await readIndexerSnapshot(env);
      return json({ ok: true, snapshot });
    }

    if (url.pathname === '/api/indexer-monitor') {
      if (request.method === 'GET') {
        const snapshot = await readIndexerSnapshot(env);
        return json({ ok: true, snapshot });
      }
      if (request.method === 'POST') {
        try {
          const snapshot = await runIndexerMonitor(env, app);
          return json({ ok: true, snapshot });
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
      return json({ ok: false, error: 'Method not allowed.' }, 405);
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runIndexerMonitor(env, app).catch(error => console.error('Curator Indexer scheduled monitor failed', error)));
  }
};

function buildIntelligencePayload(snapshot) {
  const hasSnapshot = Boolean(snapshot?.generatedAt);
  const failed = Number(snapshot?.failedPageCount || 0);
  const indexed = Number(snapshot?.indexedPageCount || 0);
  const total = Number(snapshot?.sitemapPageCount || 0);
  const coverage = Number(snapshot?.coveragePercent || 0);
  const status = failed ? 'warning' : 'good';
  const statusLabel = hasSnapshot ? (failed ? 'Attention' : 'Connected') : 'Connected';
  const value = hasSnapshot ? `${indexed}/${total || indexed} indexed` : 'Building baseline';
  const summary = hasSnapshot
    ? `${indexed} page${indexed === 1 ? '' : 's'} have retained Indexer records covering ${coverage.toFixed(1)}% of the sitemap; ${failed} currently failed indexing.`
    : 'Curator Indexer is connected and waiting for its first persistent indexing batch.';
  const detail = hasSnapshot
    ? `Persistent inventory · latest ${new Date(snapshot.generatedAt).toLocaleString('en-US')} · ${Object.keys(snapshot.pageTypes || {}).length} page types observed`
    : 'Persistent snapshot pending · no crawl runs on dashboard load';

  return {
    ok: true,
    schemaVersion: VERSION,
    generatedAt: new Date().toISOString(),
    system: {
      id: 'indexer',
      name: 'Curator Indexer',
      status,
      statusLabel,
      value,
      summary,
      detail,
      url: 'https://curator-indexer.oceanliners.net/'
    },
    metrics: {
      mode: 'persistent-bounded-monitor',
      persistentSnapshot: true,
      sitemapPageCount: total,
      indexedPageCount: indexed,
      successfulPageCount: Number(snapshot?.successfulPageCount || 0),
      failedPageCount: failed,
      coveragePercent: coverage,
      totalWords: Number(snapshot?.totals?.words || 0),
      internalLinksObserved: Number(snapshot?.totals?.internalLinks || 0),
      externalLinksObserved: Number(snapshot?.totals?.externalLinks || 0),
      imagesObserved: Number(snapshot?.totals?.images || 0),
      pageTypes: snapshot?.pageTypes || {}
    },
    priorities: (snapshot?.recentErrors || []).slice(0, 5).map((row, index) => ({
      title: 'Indexer could not refresh a sitemap page',
      summary: `${row.path} could not be indexed: ${row.error}`,
      entity: row.path,
      severity: 'medium',
      score: 78 - index,
      sources: ['Curator Indexer']
    })),
    opportunities: [],
    activity: hasSnapshot ? [{
      title: 'Persistent Indexer snapshot updated',
      summary: `${indexed}/${total || indexed} sitemap pages now have retained normalized inventory records.`,
      meta: 'Curator Indexer · persistent monitor'
    }] : [],
    snapshot: snapshot || null,
    capabilities: {
      archiveParsing: true,
      pageAnalysis: true,
      fullSiteScanOnRead: false,
      persistentSnapshot: true,
      boundedScheduledIndexing: true,
      batchSize: 20
    }
  };
}

function intelligenceResponse(payload, callback) {
  const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (callback && CALLBACK_RE.test(callback)) {
    return new Response(`${callback}(${JSON.stringify(payload)});`, {
      status: 200,
      headers: { ...headers, 'content-type': 'application/javascript; charset=utf-8' }
    });
  }
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }
  });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}
