import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Indexer recovery export is protected and scoped to its own KV',async()=>{
  const source=await readFile(new URL('../src/entry-v1.3.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/recovery-export/);
  assert.match(source,/RECOVERY_EXPORT_TOKEN/);
  assert.match(source,/x-curator-recovery-key/);
  assert.match(source,/CURATOR_INDEXER_RECORDS/);
  assert.match(source,/cdc9a84c8b364dcd9361d670c8db26b5/);
  assert.doesNotMatch(source,/binding:'CURATOR_ERROR_RECORDS'/);
  assert.match(source,/list_complete/);
  assert.match(source,/dataSha256/);
});
