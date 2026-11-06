// Destructive operations are confined to a newly created disposable container, with no host ports/DB volumes.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const name=`replayd-backup-check-${Date.now()}`;
const scripts=fileURLToPath(new URL('../deploy/backup/',import.meta.url));
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const inside=(...args)=>docker(['exec',name,...args]);
const sql=(db,statement)=>inside('psql','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-Atc',statement);
const dumps=()=>inside('find','/tmp/backup-check','-maxdepth','1','-name','*.dump').split('\n').filter(Boolean);
const backup=(db='backup_check')=>['exec','-e',`PGDATABASE=${db}`,'-e','PGUSER=postgres','-e','BACKUP_DIR=/tmp/backup-check','-e','BACKUP_RETENTION_DAYS=1',name,'sh','/tools/once.sh'];
let created=false;
try {
  docker(['run','-d','--name',name,'--network','none','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=backup_check','postgres:17']);
  created=true;
  docker(['cp',scripts,name+':/tools']);
  for(let i=0;i<60;i++) {
    if(spawnSync('docker',['exec',name,'pg_isready','-U','postgres'],{stdio:'ignore'}).status===0) break;
    if(i===59) throw new Error('Disposable database did not start');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  inside('sh','-n','/tools/once.sh'); inside('sh','-n','/tools/loop.sh');
  sql('backup_check','CREATE TABLE backup_proof (id integer PRIMARY KEY); INSERT INTO backup_proof VALUES (1),(2);');
  docker(backup());
  const [archive]=dumps(); assert(archive); assert.equal(dumps().length,1);
  sql('postgres','CREATE DATABASE restored_backup');
  inside('pg_restore','-U','postgres','--exit-on-error','--dbname=restored_backup',archive);
  assert.equal(sql('restored_backup','SELECT COUNT(*) FROM backup_proof'),'2');
  const failed=spawnSync('docker',backup('missing_database'),{stdio:'pipe'});
  assert.notEqual(failed.status,0); assert.equal(dumps().length,1);
  assert.equal(inside('find','/tmp/backup-check','-name','*.partial'),'');
  inside('touch','-d','30 days ago','/tmp/backup-check/replayd-old.dump','/tmp/backup-check/keep.txt');
  docker(backup());
  assert(!dumps().some(p=>p.endsWith('replayd-old.dump')));
  inside('test','-f','/tmp/backup-check/keep.txt');
  const count=dumps().length;
  inside('sh','-c','BACKUP_DIR=/tmp/backup-check PGUSER=postgres PGDATABASE=backup_check flock /tmp/backup-check/.lock sh /tools/once.sh');
  assert.equal(dumps().length,count);
  assert.equal(inside('stat','-c','%a',archive),'600');
  console.log('PASS backup archive, restore, permissions, failed-dump cleanup, retention and overlapping-job lock.');
} finally {
  if(created) docker(['rm','-f','-v',name]);
}
