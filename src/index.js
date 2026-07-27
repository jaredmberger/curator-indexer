/**
 * CuratorOS Core Indexer v1.0
 * Cloudflare Worker for OceanLiners.net
 *
 * Required secret:
 *   AUDIT_TOKEN
 *
 * Routes:
 *   GET  /                  Dashboard
 *   POST /api/fetch         Authenticated same-site HTML fetch proxy
 *   POST /api/archive       Parse authoritative ship manifest from /ships/ships
 *   POST /api/analyze       Analyze one HTML page into normalized page data
 */

const SITE_ORIGIN = "https://oceanliners.net";
const DEFAULT_START = `${SITE_ORIGIN}/`;
const ARCHIVE_URL = `${SITE_ORIGIN}/ships/ships`;
const VERSION = "1.0.0";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(DASHBOARD_HTML);
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      return jsonResponse({ ok: true, version: VERSION, site: SITE_ORIGIN });
    }

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    const authError = await authenticate(request, env);
    if (authError) return authError;

    try {
      if (url.pathname === "/api/fetch") return handleFetch(request);
      if (url.pathname === "/api/archive") return handleArchive(request);
      if (url.pathname === "/api/analyze") return handleAnalyze(request);
      return jsonResponse({ ok: false, error: "Route not found" }, 404);
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error?.message || error) }, 500);
    }
  }
};

async function authenticate(request, env) {
  if (!env.AUDIT_TOKEN) {
    return jsonResponse({ ok: false, error: "AUDIT_TOKEN is not configured." }, 500);
  }
  const token = request.headers.get("x-audit-token") || "";
  if (!timingSafeEqual(token, env.AUDIT_TOKEN)) {
    return jsonResponse({ ok: false, error: "Invalid audit token." }, 401);
  }
  return null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function handleFetch(request) {
  const body = await request.json();
  const target = normalizeInternalUrl(body.url);
  const response = await fetchHtml(target);
  const html = await response.text();
  return jsonResponse({
    ok: true,
    url: target,
    finalUrl: response.url || target,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    html
  });
}

async function handleArchive(request) {
  const body = await request.json().catch(() => ({}));
  const target = normalizeInternalUrl(body.url || ARCHIVE_URL);
  const response = await fetchHtml(target);
  if (!response.ok) throw new Error(`Archive returned HTTP ${response.status}`);
  const html = await response.text();
  const ships = parseShipArchive(html, target);
  return jsonResponse({ ok: true, url: target, count: ships.length, ships });
}

async function handleAnalyze(request) {
  const body = await request.json();
  const pageUrl = normalizeInternalUrl(body.url);
  const html = typeof body.html === "string" ? body.html : "";
  if (!html) throw new Error("Missing HTML.");
  const shipDictionary = Array.isArray(body.ships) ? body.ships.slice(0, 1000) : [];
  const page = analyzePage(html, pageUrl, shipDictionary);
  return jsonResponse({ ok: true, page });
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "OceanLiners-CuratorOS-Indexer/1.0 (+https://oceanliners.net/)",
        "Accept": "text/html,application/xhtml+xml"
      },
      cf: { cacheTtl: 0, cacheEverything: false }
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeInternalUrl(value) {
  const url = new URL(value || DEFAULT_START, SITE_ORIGIN);
  if (url.protocol !== "https:" || url.hostname !== "oceanliners.net") {
    throw new Error("Only https://oceanliners.net URLs are allowed.");
  }
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}

function parseShipArchive(html, baseUrl) {
  const cards = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(html))) {
    let url;
    try { url = new URL(decodeHtml(match[1]), baseUrl); } catch { continue; }
    if (url.hostname !== "oceanliners.net") continue;
    if (!/^\/ships\/[a-z0-9][a-z0-9-]*(?:\.html)?\/?$/i.test(url.pathname)) continue;
    if (/\/ships\/ships(?:\.html)?\/?$/i.test(url.pathname)) continue;

    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\.html\/?$/i, "").replace(/\/$/, "");
    const canonical = url.href;
    if (seen.has(canonical)) continue;

    const name = cleanText(match[2]);
    if (!name || name.length > 120) continue;

    const after = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 1400);
    const textAfter = cleanText(after);
    const metaMatch = textAfter.match(/^\s*([^·|]{2,100}?)\s*·\s*(1[78]\d{2}|19\d{2}|20\d{2})\b/);
    const line = metaMatch ? cleanText(metaMatch[1]) : null;
    const year = metaMatch ? Number(metaMatch[2]) : null;
    let description = null;
    if (metaMatch) {
      const rest = textAfter.slice(metaMatch[0].length).replace(/^\s+/, "");
      description = rest.split(/✓\s*Reviewed|\bReviewed using curatorial standards\b/i)[0].trim().slice(0, 500) || null;
    }

    cards.push({
      id: slugFromUrl(canonical),
      name,
      normalizedName: normalizeName(name),
      url: canonical,
      path: new URL(canonical).pathname,
      shippingLine: line,
      year,
      description,
      aliases: buildShipAliases(name)
    });
    seen.add(canonical);
  }
  return cards;
}

function analyzePage(html, pageUrl, ships) {
  const title = cleanText(firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)) || null;
  const description = getMetaContent(html, "description");
  const canonicalRaw = firstMatch(html, /<link\b[^>]*rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i)
    || firstMatch(html, /<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*>/i);
  let canonical = null;
  try { if (canonicalRaw) canonical = new URL(decodeHtml(canonicalRaw), pageUrl).href; } catch {}

  const headings = [];
  const headingRe = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let hm;
  while ((hm = headingRe.exec(html))) {
    const text = cleanText(hm[2]);
    if (text) headings.push({ level: Number(hm[1].slice(1)), text });
  }

  const links = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = anchorRe.exec(html))) {
    const attrs = am[1];
    const href = attrValue(attrs, "href");
    if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let target;
    try { target = new URL(decodeHtml(href), pageUrl); } catch { continue; }
    target.hash = "";
    const text = cleanText(am[2]);
    const rel = attrValue(attrs, "rel") || "";
    const isInternal = target.hostname === "oceanliners.net";
    const normalized = isInternal ? normalizeCrawlUrl(target) : target.href;
    links.push({
      url: normalized,
      path: isInternal ? new URL(normalized).pathname : null,
      text: text || null,
      title: attrValue(attrs, "title") || null,
      rel: rel || null,
      internal: isInternal,
      sourceSection: isWithinSourceSection(html, am.index)
    });
  }

  const visibleText = extractVisibleText(html);
  const lowerText = ` ${visibleText.toLowerCase()} `;
  const internalTargets = new Set(links.filter(l => l.internal).map(l => stripHtmlExtension(new URL(l.url).pathname)));
  const mentions = [];

  for (const ship of ships) {
    const aliases = Array.isArray(ship.aliases) && ship.aliases.length ? ship.aliases : buildShipAliases(ship.name || "");
    let matchedAlias = null;
    let count = 0;
    for (const alias of aliases) {
      if (!alias || alias.length < 4) continue;
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(alias.toLowerCase())}([^a-z0-9]|$)`, "g");
      const matches = lowerText.match(re);
      if (matches?.length) {
        count += matches.length;
        if (!matchedAlias) matchedAlias = alias;
      }
    }
    if (!count) continue;
    const shipPath = stripHtmlExtension(ship.path || new URL(ship.url).pathname);
    mentions.push({
      shipId: ship.id,
      shipName: ship.name,
      shipUrl: ship.url,
      matchedAlias,
      count,
      linked: internalTargets.has(shipPath),
      selfMention: stripHtmlExtension(new URL(pageUrl).pathname) === shipPath
    });
  }

  const structuredData = parseJsonLd(html);
  const builders = extractLabelValues(visibleText, ["Builder", "Built by", "Shipbuilder"]);
  const shippingLines = unique([
    ...extractLabelValues(visibleText, ["Shipping line", "Operator", "Line"]),
    ...ships.filter(s => s.shippingLine && lowerText.includes(` ${String(s.shippingLine).toLowerCase()} `)).map(s => s.shippingLine)
  ]).slice(0, 30);

  const images = [];
  const imageRe = /<img\b([^>]*)>/gi;
  let im;
  while ((im = imageRe.exec(html))) {
    const src = attrValue(im[1], "src");
    if (!src) continue;
    let absolute;
    try { absolute = new URL(decodeHtml(src), pageUrl).href; } catch { continue; }
    images.push({ src: absolute, alt: attrValue(im[1], "alt") || null });
  }

  return {
    url: normalizeCrawlUrl(new URL(pageUrl)),
    path: new URL(pageUrl).pathname,
    title,
    description,
    canonical,
    pageType: classifyPage(pageUrl, title, headings),
    headings,
    textLength: visibleText.length,
    wordCount: visibleText ? visibleText.split(/\s+/).length : 0,
    internalLinks: dedupeLinks(links.filter(l => l.internal)),
    externalLinks: dedupeLinks(links.filter(l => !l.internal)),
    sourceLinks: dedupeLinks(links.filter(l => !l.internal && l.sourceSection)),
    mentions,
    builders,
    shippingLines,
    images,
    structuredData,
    indexedAt: new Date().toISOString()
  };
}

function classifyPage(urlValue, title, headings) {
  const path = new URL(urlValue).pathname.toLowerCase();
  if (/^\/ships\/[a-z0-9-]+(?:\.html)?\/?$/.test(path) && !/\/ships\/ships/.test(path)) return "ship-guide";
  if (path.includes("hub")) return "hub";
  if (path.includes("reference-object") || /\/ro-\d+/i.test(path)) return "reference-object";
  if (path.includes("collection")) return "collection";
  if (path.includes("timeline") || path.includes("history")) return "history";
  if (path.includes("quick") || /^(what|why|how|did|could|is)-/.test(path.split("/").pop() || "")) return "quick-answer";
  if (path === "/") return "homepage";
  if (title?.toLowerCase().includes("ship archive") || headings.some(h => /ship archive/i.test(h.text))) return "archive";
  return "page";
}

function isWithinSourceSection(html, index) {
  const before = html.slice(Math.max(0, index - 20000), index);
  const headings = [...before.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  if (!headings.length) return false;
  const last = headings[headings.length - 1];
  return /\b(sources?|references?|bibliography|further reading|works cited)\b/i.test(cleanText(last[2]));
}

function parseJsonLd(html) {
  const output = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(decodeHtml(m[1]).trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        output.push({ type: item?.["@type"] || null, id: item?.["@id"] || null, name: item?.name || item?.headline || null });
      }
    } catch {}
  }
  return output;
}

function extractLabelValues(text, labels) {
  const results = [];
  for (const label of labels) {
    const re = new RegExp(`${escapeRegex(label)}\\s*[:—-]\\s*([^\\n|•]{2,100})`, "ig");
    let m;
    while ((m = re.exec(text))) {
      const value = cleanText(m[1]).replace(/\s{2,}.*/, "").trim();
      if (value && !/^unknown$/i.test(value)) results.push(value);
    }
  }
  return unique(results).slice(0, 20);
}

function extractVisibleText(html) {
  return cleanText(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " "));
}

function normalizeCrawlUrl(url) {
  const copy = new URL(url.href);
  copy.hash = "";
  copy.search = "";
  copy.pathname = copy.pathname.replace(/\.html\/?$/i, "").replace(/\/$/, "") || "/";
  return copy.href;
}

function stripHtmlExtension(path) {
  return path.replace(/\.html\/?$/i, "").replace(/\/$/, "") || "/";
}

function shouldCrawl(urlValue) {
  let url;
  try { url = new URL(urlValue); } catch { return false; }
  if (url.protocol !== "https:" || url.hostname !== "oceanliners.net") return false;
  if (/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|json|xml|pdf|zip|docx?|xlsx?|pptx?|mp3|mp4|mov|webm|woff2?|ttf|eot)$/i.test(url.pathname)) return false;
  if (/^\/(?:cdn-cgi|api)\//i.test(url.pathname)) return false;
  return true;
}

function buildShipAliases(name) {
  const aliases = new Set();
  const clean = cleanText(name);
  if (!clean) return [];
  aliases.add(clean);
  const noYear = clean.replace(/\s*\((?:18|19|20)\d{2}\)\s*$/, "").trim();
  aliases.add(noYear);
  const noPrefix = noYear.replace(/^(RMS|SS|MV|MS|HMHS|HMT|USS|TS|TSS)\s+/i, "").trim();
  if (noPrefix.length >= 5) aliases.add(noPrefix);
  return [...aliases].sort((a, b) => b.length - a.length);
}

function normalizeName(name) {
  return cleanText(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slugFromUrl(url) {
  return new URL(url).pathname.split("/").filter(Boolean).pop().replace(/\.html$/i, "");
}

function getMetaContent(html, name) {
  const escaped = escapeRegex(name);
  return decodeHtml(firstMatch(html, new RegExp(`<meta\\b[^>]*name\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`, "i"))
    || firstMatch(html, new RegExp(`<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*name\\s*=\\s*["']${escaped}["'][^>]*>`, "i")) || "") || null;
}

function attrValue(attrs, name) {
  const escaped = escapeRegex(name);
  const m = attrs.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, "i"));
  return m ? decodeHtml(m[1] ?? m[2] ?? "") : null;
}

function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1] : "";
}

function cleanText(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function dedupeLinks(links) {
  const seen = new Set();
  return links.filter(link => {
    const key = `${link.url}|${link.text || ""}|${link.sourceSection ? 1 : 0}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }});
}
function htmlResponse(html) {
  return new Response(html, { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  }});
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CuratorOS Core Indexer</title>
<style>
:root{color-scheme:dark;--bg:#07100e;--panel:#0d1916;--panel2:#12221e;--brass:#bfa46a;--text:#f1eee6;--muted:#aaa89f;--line:rgba(191,164,106,.28);--good:#72c89a;--bad:#e17f7f}
*{box-sizing:border-box}body{margin:0;font-family:Georgia,"Times New Roman",serif;background:radial-gradient(circle at top,#17231f 0,#07100e 52%);color:var(--text);min-height:100vh}.wrap{width:min(1180px,calc(100% - 28px));margin:28px auto 60px}.suitebar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px;padding:11px 14px;border:1px solid var(--line);border-radius:14px;background:rgba(7,16,14,.88);font:700 12px/1.4 system-ui;letter-spacing:.04em}.suitebrand{color:var(--brass);text-transform:uppercase;letter-spacing:.14em}.suitenav{display:flex;flex-wrap:wrap;gap:8px}.suitenav a{color:var(--text);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:7px 11px}.suitenav a[aria-current="page"]{background:var(--brass);color:#111;border-color:var(--brass)}.mast{border:1px solid var(--line);background:rgba(13,25,22,.92);padding:28px;border-radius:18px;box-shadow:0 20px 50px rgba(0,0,0,.35)}.eyebrow{font:700 12px/1.3 system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(30px,5vw,54px);margin:.25rem 0 .55rem}.lead{color:var(--muted);max-width:800px;line-height:1.65}.workflow{margin-top:14px;padding:12px 14px;border-left:3px solid var(--brass);background:rgba(191,164,106,.08);font:13px/1.55 system-ui;color:var(--muted)}.workflow strong{color:var(--text)}.grid{display:grid;grid-template-columns:1.25fr .75fr;gap:18px;margin-top:18px}.panel{background:rgba(13,25,22,.94);border:1px solid var(--line);border-radius:16px;padding:20px}.fields{display:grid;grid-template-columns:1fr 160px;gap:12px}label{display:block;font:700 12px system-ui;letter-spacing:.05em;color:var(--muted);margin-bottom:7px}input,select{width:100%;background:#07110e;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:12px;font:14px system-ui}button{appearance:none;border:1px solid var(--brass);background:var(--brass);color:#111;padding:12px 17px;border-radius:10px;font:800 13px system-ui;cursor:pointer}button.secondary{background:transparent;color:var(--brass)}button:disabled{opacity:.45;cursor:not-allowed}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}.progress{height:12px;border-radius:999px;background:#06100d;border:1px solid var(--line);overflow:hidden;margin:18px 0 8px}.bar{height:100%;width:0;background:linear-gradient(90deg,#8f7846,#d1ba7c);transition:width .2s}.status{font:13px/1.5 system-ui;color:var(--muted);min-height:22px}.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.stat{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px}.num{font:700 28px Georgia;color:var(--brass)}.lab{font:11px system-ui;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.log{margin-top:14px;height:240px;overflow:auto;background:#050b09;border:1px solid var(--line);border-radius:12px;padding:12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9c7bf}.preview{margin-top:18px}.preview table{width:100%;border-collapse:collapse;font:13px system-ui}.preview th,.preview td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px;vertical-align:top}.preview th{color:var(--brass)}.ok{color:var(--good)}.error{color:var(--bad)}.suitefooter{margin-top:18px;padding:14px;text-align:center;color:var(--muted);font:12px/1.5 system-ui}.suitefooter a{color:var(--brass)}@media(max-width:800px){.suitebar{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.fields{grid-template-columns:1fr}.wrap{width:min(100% - 18px,1180px);margin-top:10px}.mast{padding:20px}}
</style>
</head>
<body><main class="wrap">
<nav class="suitebar" aria-label="CuratorOS Suite"><div class="suitebrand">CuratorOS Suite</div><div class="suitenav"><a href="https://curator.oceanliners.net/">CuratorOS</a><a href="https://site-health.oceanliners.net/">Site Health</a><a href="https://curator-indexer.oceanliners.net/" aria-current="page">Curator Indexer</a></div></nav>
<section class="mast"><div class="eyebrow">OceanLiners.net · Private Curatorial Tool · v${VERSION}</div><h1>CuratorOS Core Indexer</h1><p class="lead">Crawl the live site and generate a canonical JSON index containing pages, metadata, headings, links, citations, ship entities, mentions, builders, shipping lines, images, and structured-data summaries.</p><div class="workflow"><strong>Workflow:</strong> Build the index here, download <code>site-index.json</code>, then return to CuratorOS and choose <strong>Import Scan Results</strong>. Use <strong>Load Catalog</strong> only for the CuratorOS database itself.</div></section>
<div class="grid">
<section class="panel"><h2>Build Index</h2><div class="fields"><div><label for="token">AUDIT_TOKEN</label><input id="token" type="password" autocomplete="current-password" placeholder="Private Worker token"></div><div><label for="limit">Maximum pages</label><input id="limit" type="number" min="1" max="3000" value="1500"></div></div><div class="fields" style="margin-top:12px"><div><label for="start">Starting URL</label><input id="start" value="https://oceanliners.net/"></div><div><label for="concurrency">Concurrency</label><select id="concurrency"><option>2</option><option selected>4</option><option>6</option><option>8</option></select></div></div><div class="actions"><button id="run">Build site-index.json</button><button id="stop" class="secondary" disabled>Stop</button><button id="download" class="secondary" disabled>Download for CuratorOS</button><button id="csv" class="secondary" disabled>Download Page CSV</button></div><div class="progress"><div id="bar" class="bar"></div></div><div id="status" class="status">Ready.</div><div id="log" class="log"></div></section>
<aside class="panel"><h2>Index Summary</h2><div class="stats"><div class="stat"><div id="pages" class="num">0</div><div class="lab">Pages indexed</div></div><div class="stat"><div id="ships" class="num">0</div><div class="lab">Ship entities</div></div><div class="stat"><div id="mentions" class="num">0</div><div class="lab">Ship mentions</div></div><div class="stat"><div id="opps" class="num">0</div><div class="lab">Unlinked mentions</div></div><div class="stat"><div id="internal" class="num">0</div><div class="lab">Internal links</div></div><div class="stat"><div id="sources" class="num">0</div><div class="lab">Source links</div></div></div></aside>
</div>
<section class="panel preview"><h2>Recent Pages</h2><table><thead><tr><th>Page</th><th>Type</th><th>Words</th><th>Mentions</th><th>Unlinked</th></tr></thead><tbody id="rows"><tr><td colspan="5">No index generated yet.</td></tr></tbody></table></section>
<footer class="suitefooter">CuratorOS Suite · <a href="https://curator.oceanliners.net/">Return to CuratorOS</a> · <a href="https://site-health.oceanliners.net/">Open Site Health</a></footer>
</main>
<script>
(() => {
  const $=id=>document.getElementById(id); let stopped=false, result=null;
  const state={queue:[],queued:new Set(),visited:new Set(),pages:[],errors:[],ships:[]};
  function log(msg,cls=''){const line=document.createElement('div');line.textContent='['+new Date().toLocaleTimeString()+'] '+msg;if(cls)line.className=cls;$('log').append(line);$('log').scrollTop=$('log').scrollHeight}
  function setStatus(msg){$('status').textContent=msg}
  function api(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json','x-audit-token':$('token').value},body:JSON.stringify(body)}).then(async r=>{const d=await r.json().catch(()=>({error:'Invalid server response'}));if(!r.ok||!d.ok)throw new Error(d.error||'Request failed');return d})}
  function normalize(raw){const u=new URL(raw,'https://oceanliners.net/');u.hash='';u.search='';u.pathname=u.pathname.replace(/\\.html\\/?$/i,'').replace(/\\/$/,'')||'/';return u.href}
  function crawlable(raw){try{const u=new URL(raw);return u.protocol==='https:'&&u.hostname==='oceanliners.net'&&!/\\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|json|xml|pdf|zip|docx?|xlsx?|pptx?|mp3|mp4|mov|webm|woff2?|ttf|eot)$/i.test(u.pathname)&&!/^\\/(cdn-cgi|api)\\//i.test(u.pathname)}catch{return false}}
  function enqueue(url){const n=normalize(url);if(crawlable(n)&&!state.queued.has(n)&&!state.visited.has(n)){state.queue.push(n);state.queued.add(n)}}
  function update(){const m=state.pages.reduce((a,p)=>a+p.mentions.length,0),o=state.pages.reduce((a,p)=>a+p.mentions.filter(x=>!x.linked&&!x.selfMention).length,0),i=state.pages.reduce((a,p)=>a+p.internalLinks.length,0),s=state.pages.reduce((a,p)=>a+p.sourceLinks.length,0);$('pages').textContent=state.pages.length;$('ships').textContent=state.ships.length;$('mentions').textContent=m;$('opps').textContent=o;$('internal').textContent=i;$('sources').textContent=s;const max=Number($('limit').value)||1500;$('bar').style.width=Math.min(100,(state.visited.size/max)*100)+'%';const rows=state.pages.slice(-12).reverse().map(p=>'<tr><td><a style="color:#d1ba7c" target="_blank" rel="noopener" href="'+esc(p.url)+'">'+esc(p.title||p.path)+'</a></td><td>'+esc(p.pageType)+'</td><td>'+p.wordCount+'</td><td>'+p.mentions.length+'</td><td>'+p.mentions.filter(x=>!x.linked&&!x.selfMention).length+'</td></tr>').join('');$('rows').innerHTML=rows||'<tr><td colspan="5">No pages yet.</td></tr>'}
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  async function processOne(url){state.visited.add(url);state.queued.delete(url);try{const fetched=await api('/api/fetch',{url});if(!/text\\/html|application\\/xhtml/i.test(fetched.contentType)&&fetched.contentType)throw new Error('Not HTML: '+fetched.contentType);const analyzed=await api('/api/analyze',{url:fetched.finalUrl||url,html:fetched.html,ships:state.ships});state.pages.push(analyzed.page);for(const link of analyzed.page.internalLinks)enqueue(link.url);log('Indexed '+analyzed.page.path+' · '+analyzed.page.wordCount+' words','ok')}catch(e){state.errors.push({url,error:e.message});log('Failed '+url+' · '+e.message,'error')}update()}
  async function worker(limit){while(!stopped&&state.queue.length&&state.visited.size<limit){const url=state.queue.shift();await processOne(url)}}
  async function run(){if(!$('token').value){setStatus('Enter your AUDIT_TOKEN first.');return}stopped=false;result=null;Object.assign(state,{queue:[],queued:new Set(),visited:new Set(),pages:[],errors:[],ships:[]});$('run').disabled=true;$('stop').disabled=false;$('download').disabled=true;$('csv').disabled=true;$('log').innerHTML='';update();try{setStatus('Loading authoritative ship archive…');log('Reading /ships/ships for ship entities.');const archive=await api('/api/archive',{url:'https://oceanliners.net/ships/ships'});state.ships=archive.ships;log('Loaded '+archive.count+' ship entities.','ok');enqueue($('start').value);enqueue('https://oceanliners.net/ships/ships');const limit=Math.min(3000,Math.max(1,Number($('limit').value)||1500));const n=Math.min(8,Math.max(1,Number($('concurrency').value)||4));setStatus('Crawling and analyzing pages…');await Promise.all(Array.from({length:n},()=>worker(limit)));result=buildResult();setStatus(stopped?'Stopped. Partial index is ready.':'Complete. site-index.json is ready for CuratorOS.');log('Index complete: '+result.summary.pagesIndexed+' pages, '+result.summary.unlinkedShipMentions+' unlinked ship mentions.','ok');$('download').disabled=false;$('csv').disabled=false}catch(e){setStatus('Error: '+e.message);log(e.message,'error')}finally{$('run').disabled=false;$('stop').disabled=true;update()}}
  function buildResult(){const pages=[...state.pages].sort((a,b)=>a.url.localeCompare(b.url));const mentions=[];for(const p of pages)for(const m of p.mentions)mentions.push({...m,pageUrl:p.url,pageTitle:p.title,pageType:p.pageType});const opportunities=mentions.filter(m=>!m.linked&&!m.selfMention);const internalEdges=[];for(const p of pages)for(const l of p.internalLinks)internalEdges.push({from:p.url,to:l.url,anchor:l.text});const sourceEdges=[];for(const p of pages)for(const l of p.sourceLinks)sourceEdges.push({page:p.url,url:l.url,anchor:l.text});return{schema:'https://oceanliners.net/curatoros/site-index.schema.json',schemaVersion:'1.0',generator:{name:'CuratorOS Core Indexer',version:'${VERSION}'},site:{origin:'https://oceanliners.net',startUrl:normalize($('start').value)},generatedAt:new Date().toISOString(),summary:{pagesIndexed:pages.length,shipEntities:state.ships.length,shipMentions:mentions.length,unlinkedShipMentions:opportunities.length,internalLinks:internalEdges.length,sourceLinks:sourceEdges.length,errors:state.errors.length},entities:{ships:state.ships},pages,graphs:{internalLinks:internalEdges,sourceLinks:sourceEdges,shipMentions:mentions,unlinkedShipMentions:opportunities},errors:state.errors}}
  function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
  function csv(){const cols=['url','title','pageType','wordCount','internalLinks','externalLinks','sourceLinks','shipMentions','unlinkedShipMentions','builders','shippingLines'];const lines=[cols.join(',')];for(const p of result.pages){const row=[p.url,p.title,p.pageType,p.wordCount,p.internalLinks.length,p.externalLinks.length,p.sourceLinks.length,p.mentions.length,p.mentions.filter(m=>!m.linked&&!m.selfMention).length,p.builders.join(' | '),p.shippingLines.join(' | ')];lines.push(row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(','))}return lines.join('\\n')}
  $('run').addEventListener('click',run);$('stop').addEventListener('click',()=>{stopped=true;$('stop').disabled=true;setStatus('Stopping after current requests…')});$('download').addEventListener('click',()=>download('site-index.json',JSON.stringify(result,null,2),'application/json'));$('csv').addEventListener('click',()=>download('site-index-pages.csv',csv(),'text/csv'));
})();
</script></body></html>`;