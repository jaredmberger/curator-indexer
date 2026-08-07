import app from './index.js';
import { runIndexerMonitor, readIndexerSnapshot } from './indexer-monitor.js';

const VERSION = '1.1';
const CALLBACK_RE = /^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)*$/;
const BOOTSTRAP_KEY = 'indexer:bootstrap-lock:v1';
const BOOTSTRAP_TTL_SECONDS = 600;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/curator-intelligence') {
      const snapshot = await readIndexerSnapshot(env);
      if (!snapshot) scheduleBaselineBootstrap(env, ctx);
      return intelligenceResponse(buildIntelligencePayload(snapshot), url.searchParams.get('callback'));
    }

    if (url.pathname === '/api/indexer-snapshot' && request.method === 'GET') {
      const snapshot = await readIndexerSnapshot(env);
      if (!snapshot) scheduleBaselineBootstrap(env, ctx);
      return json({ ok: true, snapshot, bootstrapScheduled: !snapshot });
    }

    if (url.pathname === '/api/indexer-monitor') {
      if (request.method === 'GET') {
        const snapshot = await readIndexerSnapshot(env);
        if (!snapshot) scheduleBaselineBootstrap(env, ctx);
        return json({ ok: true, snapshot, bootstrapScheduled: !snapshot });
      }
      if (request.method === 'POST') {
        try {
          const snapshot = await runIndexerMonitor(env, app);
          await clearBootstrapLock(env);
          return json({ ok: true, snapshot });
        } catch (error) {
          await clearBootstrapLock(env);
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
      return json({ ok: false, error: 'Method not allowed.' }, 405);
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runIndexerMonitor(env, app)
        .then(() => clearBootstrapLock(env))
        .catch(async error => {
          await clearBootstrapLock(env);
          console.error('Curator Indexer scheduled monitor failed', error);
        })
    );
  }
};

function scheduleBaselineBootstrap(env, ctx) {
  if (!ctx?.waitUntil || !env?.CURATOR_INDEXER_RECORDS) return;
  ctx.waitUntil(ensureBaseline(env));
}

async function ensureBaseline(env) {
  const existing = await readIndexerSnapshot(env);
  if (existing) return existing;

  const lock = await env.CURATOR_INDEXER_RECORDS.get(BOOTSTRAP_KEY);
  if (lock) return null;

  await env.CURATOR_INDEXER_RECORDS.put(
    BOOTSTRAP_KEY,
    JSON.stringify({ startedAt: new Date().toISOString() }),
    { expirationTtl: BOOTSTRAP_TTL_SECONDS }
  );

  try {
    return await runIndexerMonitor(env, app);
  } catch (error) {
    console.error('Curator Indexer baseline bootstrap failed', error);
    return null;
  } finally {
    await clearBootstrapLock(env);
  }
}

async function clearBootstrapLock(env) {
  if (!env?.CURATOR_INDEXER_RECORDS) return;
  try { await env.CURATOR_INDEXER_RECORDS.delete(BOOTSTRAP_KEY); } catch {}
}

function buildIntelligencePayload(snapshot) {
  const hasSnapshot = Boolean(snapshot?.generatedAt);
  const failed = Number(snapshot?.failedPageCount || 0);
  const indexed = Number(snapshot?.indexedPageCount || 0);
  const total = Number(snapshot?.sitemapPageCount || 0);
  const coverage = Number(snapshot?.coveragePercent || 0);
  const changes = snapshot?.changes || { total: 0, counts: {}, items: [] };
  const regressions = (changes.items || []).filter(x => ['missing','failed'].includes(x.type));
  const discoveries = (changes.items || []).filter(x => ['discovered','indexed'].includes(x.type));
  const recoveries = (changes.items || []).filter(x => x.type === 'recovered');
  const contentChanges = (changes.items || []).filter(x => x.type === 'changed');
  const status = failed || regressions.length ? 'warning' : 'good';
  const statusLabel = hasSnapshot ? (failed || regressions.length ? 'Attention' : 'Connected') : 'Building baseline';
  const value = hasSnapshot ? (regressions.length ? `${regressions.length} missing/failed` : `${indexed}/${total || indexed} indexed`) : 'Baseline starting';
  const summary = hasSnapshot
    ? `${indexed} page${indexed === 1 ? '' : 's'} have retained Indexer records covering ${coverage.toFixed(1)}% of the sitemap; ${failed} currently failed indexing. Latest batch: ${changes.total || 0} meaningful change${Number(changes.total || 0) === 1 ? '' : 's'}.`
    : 'Curator Indexer is connected. Its first bounded baseline batch is being started in the background; dashboard reads do not wait on the crawl.';
  const detail = hasSnapshot
    ? `Persistent inventory · ${Object.keys(snapshot.pageTypes || {}).length} page types · Change Detection v1`
    : 'Persistent snapshot pending · self-bootstrap enabled · 20-page bounded batch';

  const priorities = regressions.slice(0, 6).map((row, index) => ({
    title: row.title,
    summary: `${row.path}: ${row.summary}`,
    entity: row.path,
    severity: row.type === 'failed' ? 'high' : 'medium',
    score: 92 - index * 3,
    sources: ['Curator Indexer'],
    changeDetected: true
  }));

  for (const row of (snapshot?.recentErrors || []).slice(0, 5)) {
    if (priorities.some(item => item.entity === row.path)) continue;
    priorities.push({
      title: 'Indexer could not refresh a sitemap page',
      summary: `${row.path} could not be indexed: ${row.error}`,
      entity: row.path,
      severity: 'medium',
      score: 75,
      sources: ['Curator Indexer']
    });
  }

  const activity = [];
  if (hasSnapshot) {
    activity.push({
      title: changes.total ? 'Indexer change detection completed' : 'Persistent Indexer snapshot updated',
      summary: changes.total
        ? `${changes.total} meaningful change${changes.total === 1 ? '' : 's'} detected: ${regressions.length} missing/failed, ${discoveries.length} discovered/first-indexed, ${recoveries.length} recovered, and ${contentChanges.length} content/inventory change${contentChanges.length === 1 ? '' : 's'}.`
        : `${indexed}/${total || indexed} sitemap pages have retained normalized inventory records; no meaningful changes were detected in the latest batch.`,
      meta: 'Curator Indexer · Change Detection v1'
    });
    activity.push(...recoveries.slice(0, 2).map(item => ({ title: item.title, summary: `${item.path}: ${item.summary}`, meta: 'Curator Indexer · recovered' })));
    activity.push(...discoveries.slice(0, 2).map(item => ({ title: item.title, summary: `${item.path}: ${item.summary}`, meta: 'Curator Indexer · discovered' })));
  } else {
    activity.push({
      title: 'Indexer baseline bootstrap requested',
      summary: 'No retained snapshot exists yet, so Curator Indexer requested its first bounded 20-page baseline batch in the background.',
      meta: 'Curator Indexer · bootstrap'
    });
  }

  return {
    ok: true,
    schemaVersion: VERSION,
    generatedAt: new Date().toISOString(),
    system: { id: 'indexer', name: 'Curator Indexer', status, statusLabel, value, summary, detail, url: 'https://curator-indexer.oceanliners.net/' },
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
      pageTypes: snapshot?.pageTypes || {},
      changeCount: Number(changes.total || 0),
      regressionCount: regressions.length,
      discoveryCount: discoveries.length,
      recoveryCount: recoveries.length,
      contentChangeCount: contentChanges.length,
      baselineBootstrap: !hasSnapshot
    },
    priorities: priorities.slice(0, 8),
    opportunities: [],
    activity,
    snapshot: snapshot || null,
    capabilities: {
      archiveParsing: true,
      pageAnalysis: true,
      fullSiteScanOnRead: false,
      persistentSnapshot: true,
      boundedScheduledIndexing: true,
      changeDetection: true,
      baselineSelfBootstrap: true,
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
