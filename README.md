# CuratorOS Core Indexer

Private Cloudflare Worker for crawling `oceanliners.net` and producing `site-index.json` for CuratorOS.

## Cloudflare deployment

1. Create or connect a Worker to this GitHub repository.
2. Use the repository root as the project root.
3. Build command: `npm install`
4. Deploy command: `npx wrangler deploy`
5. Add the encrypted Worker secret `AUDIT_TOKEN`.
6. Attach the custom domain `curator-indexer.oceanliners.net`.

The dashboard is served at `/`; a lightweight status endpoint is available at `/api/status`.
