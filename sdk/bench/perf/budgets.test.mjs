import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayFailures } from './budgets.mjs';
const good = () => ({ scenario:'terminal-1000',rate:4,snapshot_ms:120,batch_p95_ms:4,uplink_kb_s:2,long_tasks_after_snapshot:0,checks:[{segments:2,fullSnapshots:1,bad:[]}] });
test('the existing terminal exception does not waive snapshot or non-terminal batch limits',()=>{
  assert.deepEqual(replayFailures(good()),[]);
  assert(replayFailures({...good(),snapshot_ms:150}).length);
  assert(replayFailures({...good(),scenario:'form'}).length);
  assert(replayFailures({...good(),rate:1}).length);
});
test('missing/nonfinite timing and capture evidence fail closed',()=>{
  for(const value of [null,undefined,NaN,Infinity]) assert(replayFailures({...good(),snapshot_ms:value}).length);
  assert(replayFailures({...good(),checks:[]}).length);
});
test('privacy failures in later repetitions cannot be hidden by the first run',()=>{
  const result=good(); result.checks.push({segments:2,fullSnapshots:1,bad:['masking failed']});
  assert(replayFailures(result).some(s=>s.includes('run 2: masking failed')));
});
test('post-snapshot long tasks and excessive uplink fail',()=>{
  assert(replayFailures({...good(),long_tasks_after_snapshot:1}).length);
  assert(replayFailures({...good(),uplink_kb_s:5.01}).length);
});
