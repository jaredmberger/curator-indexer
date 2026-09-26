# Curator Indexer Recovery Export

Curator Indexer provides a complete, read-only backup of the `CURATOR_INDEXER_RECORDS` Cloudflare KV namespace at:

`GET /api/recovery-export`

The shared `CURATOR_ERROR_RECORDS` binding is intentionally excluded because Error Bus owns its authoritative recovery path.

## Security

Configure the Worker secret `RECOVERY_EXPORT_TOKEN` and send it as:

`X-Curator-Recovery-Key: <RECOVERY_EXPORT_TOKEN>`

If the secret is absent, the endpoint remains disabled.

## Scope

The exporter paginates every key in `CURATOR_INDEXER_RECORDS` and preserves exact key/value pairs, including retained index snapshots and future state keys.

Each backup includes the export timestamp, namespace identity, total key count, SHA-256 integrity metadata, and complete key/value payload.

## iPad / iPhone backup

Use Shortcuts with:

- URL: `https://curator-indexer.oceanliners.net/api/recovery-export`
- Method: GET
- Header: `X-Curator-Recovery-Key` = the configured recovery token
- Save File

## Validation

```bash
node scripts/validate-recovery-backup.mjs /path/to/curator-indexer-recovery-....json
```

## Restore policy

There is intentionally no production restore endpoint. Restore testing should first target a disposable KV namespace.
