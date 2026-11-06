// Local-only identity search benchmark. Uses API-created project + bounded SQL fixtures, then cleans up.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {login} from './lib.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),{api}=await login();
const project=await api('POST','/projects',{slug:`field-bench-${Date.now().toString(36)}`,name:'Local field search benchmark',allowed_origins:[]});
const pid=Number(project.id);assert.ok(Number.isSafeInteger(pid));
const pg=execFileSync('docker',['compose','-f',`${root}deploy/docker-compose.yml`,'ps','-q','postgres'],{encoding:'utf8'}).trim();
const sql=s=>execFileSync('docker',['exec','-i',pg,'psql','-U','replayd','-d','replayd','-tA','-v','ON_ERROR_STOP=1'],{input:s,encoding:'utf8'});
const result=[];
try {
  sql(`SELECT replayd_ensure_partitions(current_date-14,current_date+1);
    INSERT INTO sessions (id,project_id,started_at,last_at,ended,file_day,user_id,user_email,user_name,client_ip,app_version)
    SELECT gen_random_uuid(),${pid},now()-make_interval(secs=>g*8),now()-make_interval(secs=>g*8),true,(now()-make_interval(secs=>g*8))::date,'customer-'||g,'person-'||g||'@example.test','Person '||g,('192.0.2.'||(g%250+1))::inet,'version-'||(g%20)
    FROM generate_series(1,140000) g;
    INSERT INTO issues (project_id,fingerprint,level,source,title,first_seen,last_seen)
    SELECT ${pid},decode(md5(g::text),'hex'),'error','manual','Benchmark issue '||g,now(),now() FROM generate_series(1,10000) g;
    INSERT INTO events (id,issue_id,project_id,ts,level,payload,user_id,user_email,user_name,client_ip,app_version)
    SELECT gen_random_uuid(),i.id,${pid},now()-make_interval(secs=>g*8),'error','{}','customer-'||g,'person-'||g||'@example.test','Person '||g,('192.0.2.'||(g%250+1))::inet,'version-'||(g%20)
    FROM generate_series(1,140000) g JOIN issues i ON i.project_id=${pid} AND i.fingerprint=decode(md5(((g-1)%10000+1)::text),'hex');
    ANALYZE sessions; ANALYZE events; ANALYZE issues;`);
  for(const kind of ['sessions','issues']) for(const query of ['','customer-65432','person-65432@example.test','Person 65432','192.0.2.43','version-7','missing-value','Person']) {
    const path=`/projects/${pid}/${kind}${query?`?${kind==='sessions'?'user':'q'}=${encodeURIComponent(query)}`:''}`;
    for(let i=0;i<5;i++) await api('GET',path);
    const samples=[];
    for(let i=0;i<40;i++){const start=performance.now();await api('GET',path);samples.push(performance.now()-start)}
    samples.sort((a,b)=>a-b);
    const row={kind,query:query||'(unfiltered)',p50_ms:+samples[20].toFixed(2),p95_ms:+samples[38].toFixed(2),samples:40};
    result.push(row);console.log(JSON.stringify(row));
    if(kind==='issues'&&query){
      const like=`'%${query.replaceAll("'","''")}%'`;
      const predicate=`title ILIKE ${like} OR culprit ILIKE ${like} OR id IN (SELECT e.issue_id FROM events e WHERE e.project_id=${pid} AND e.ts >= current_date-13 AND (coalesce(e.user_id,'') || ' ' || coalesce(e.user_email,'') || ' ' || coalesce(e.user_name,'') || ' ' || coalesce(host(e.client_ip),'') || ' ' || coalesce(e.app_version,'')) ILIKE ${like})`;
      for(const page of [0,1]){
        const expected=sql(`SELECT id FROM issues WHERE project_id=${pid} AND status='unresolved' AND (${predicate}) ORDER BY last_seen DESC,id DESC LIMIT 50 OFFSET ${page*50}`).trim().split('\n').filter(Boolean).map(Number);
        const actual=await api('GET',`${path}&page=${page}`);
        assert.deepEqual(actual.issues.map(i=>i.id),expected,`complete ordered results for ${query}, page ${page}`);
      }
    }
  }
  await writeFile(`${root}docs/fields-search-benchmark.json`,JSON.stringify({sessions:140000,events:140000,issues:10000,days:14,results:result},null,2));
  assert.ok(result.every(r=>r.p95_ms<100),'identity list p95 must remain below 100 ms');
} finally {sql(`DELETE FROM events WHERE project_id=${pid}; DELETE FROM sessions WHERE project_id=${pid};`);await api('DELETE',`/projects/${pid}`)}
