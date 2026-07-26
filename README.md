# CuratorOS Core Indexer

Private Cloudflare Worker for crawling `oceanliners.net` and producing `site-index.json` for CuratorOS.

## CuratorOS suite

- **CuratorOS:** `https://curator.oceanliners.net/`
- **Site Health:** `https://site-health.oceanliners.net/`
- **Curator Indexer:** `https://curator-indexer.oceanliners.net/`

The Indexer builds the canonical site intelligence layer: pages, metadata, headings, internal links, source links, ship entities, mentions, builders, shipping lines, images, and structured-data summaries.

Run the Indexer, download `site-index.json`, then import it into CuratorOS as intelligence data.

## Exchange format

The stable index contract is documented in [`docs/site-index.schema.json`](docs/site-index.schema.json).

- File: `site-index.json`
- Schema: `https://oceanliners.net/curatoros/site-index.schema.json`
- Schema version: `1.0`

## Cloudflare deployment

1. Create or connect a Worker to this GitHub repository.
2. Use the repository root as the project root.
3. Build command: `npm install`
4. Deploy command: `npx wrangler deploy`
5. Add the encrypted Worker secret `AUDIT_TOKEN`.
6. Attach the custom domain `curator-indexer.oceanliners.net`.

The dashboard is served at `/`; a lightweight status endpoint is available at `/api/status`.
