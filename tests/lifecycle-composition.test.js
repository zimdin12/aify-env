import { spawnedPipe } from './fixtures/spawned-pipe.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { Runner } from '../lib/runner.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { readAgentStates } from '../lib/agent-state-read.mjs';
function fixture(t, mode = 'managed') {
 const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'd9-composed-'));
 fs.writeFileSync(path.join(home,'agent-lifecycle.json'), JSON.stringify({version:1,records:{},stops:{}}));
 t.after(() => fs.rmSync(home,{recursive:true,force:true}));
 let alive = true; let birth = 1700000000000000; const kills=[];
 const probe = pids => new Map(pids.map(pid=>[pid,{alive,createdAtUs:birth,commandLine:'bash C:/fixture/hermes-aify'}]));
 const host = new AgentStateHost({aifyHome:home,instance:'owner',probe,nowUs:()=>1700000000001000}); host.boot();
 const child = new EventEmitter(); child.pid=424242; child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.stdin={write(){}}; child.kill=()=>kills.push('child');
 const spawned=[]; const runner = new Runner({platform:'win32',openTerminal:null,spawnProcess:(command,args,options)=>{spawned.push(options?.env);return spawnedPipe(child);},managedHost:()=>({host,instance:'owner',url:'http://127.0.0.1:12345'}),isAlive:()=>alive,killTree:async()=>kills.push('tree')});
 const definitions = new DefinitionStore({dir:path.join(home,'definitions')});
 const ports = createAgentLifecyclePorts({aifyHome:home,cwdRoots:[home],currentCwd:()=>home,machineId:'machine',stateHost:host,runner,definitions,probe,isAlive:()=>alive,killTree:async()=>{kills.push('resident');alive=false;},settleMs:0,installed:async()=>new Set(['hermes']),buildSpec:async()=>({service:'fixture',fileText:'#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"',command:'fixture',args:[],env:{}})});
 const agent={id:'a',name:'Fixture',role:'worker',harness:'hermes',mode,workspace:home,model:'',effort:'',instructions:'',env:{},herdrSpace:false};
 return {home,host,runner,definitions,ports,kills,child,agent,probe,spawned,setAlive:v=>{alive=v;},setBirth:v=>{birth=v;}};
}
async function request(f, action, id='request') { const listed=await f.definitions.list(); const row=listed.definitions[0]; return {id,agentId:'a',machineId:'machine',storeId:listed.storeId,expectedIncarnation:row.incarnation,expectedRevision:row.revision,expectedLifetime:f.host.rawIdentity('a').current?.lifetime??null,action,requestedBy:'fixture'}; }
async function seed(f) { await f.definitions.set('a',f.agent,{installed:new Set(['hermes'])}); }
test('composed managed disappearance is not death, reservation and raw handle survive',async t=>{
 const f=fixture(t);await seed(f);
 await f.runner.start({agentId:'a',service:'fixture',fileText:'#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"',command:'fixture',env:{}});
 const r=await request(f,'stop');const before=f.host.rawIdentity('a');
 assert.equal((await f.ports.lifecycle.execute(r)).outcome,'execution-unknown');
 assert.equal(f.runner.list().length,1);assert.equal(f.host.rawIdentity('a').current.handle,before.current.handle);
 assert.equal(f.ports.stopFacts().size,0);assert.equal((await f.ports.lifecycle.execute({...r,id:'second'})).outcome,'agent-reserved');
});
test('positively verified managed death feeds actual state read and blocks locked cold producer',async t=>{
 const f=fixture(t);await seed(f);await f.runner.start({agentId:'a',service:'fixture',fileText:'#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"',command:'fixture',env:{}});
 const r=await request(f,'stop');f.setAlive(false);
 assert.equal((await f.ports.lifecycle.execute(r)).status,'done');
 const read=await readAgentStates({stateHost:f.host,definitions:f.definitions,observedHarnesses:async()=>new Set(['hermes']),lifecycle:f.ports});
 assert.equal(read.body.inputs.operatorStop,'tracked');assert.equal(read.body.agents[0].state,'stopped');
 let produced=0;const launch={agentId:'a',runtime:'hermes',definition:{storeId:r.storeId,incarnation:r.expectedIncarnation,revision:r.expectedRevision}};
 assert.equal((await f.ports.admitColdStart(launch,()=>++produced,async()=>true)).refused,'stopped-by-operator');assert.equal(produced,0);
});
test('raw resident pinned birth revalidation refuses PID reuse before kill',async t=>{
 const f=fixture(t,'resident');await seed(f);fs.mkdirSync(path.join(f.home,'residents'));
 const record={agentId:'a',lifetime:'11111111-1111-4111-8111-111111111111',instance:'owner',harness:'hermes',pid:424242,launcher:'C:/fixture/hermes-aify',writtenAtUs:1700000000001000};
 fs.writeFileSync(path.join(f.home,'residents',`a.${record.lifetime}.json`),JSON.stringify(record));
 const raw=f.host.rawIdentity('a');assert.equal(raw.current.createdAtUs,1700000000000000);
 f.setBirth(1700000000002000);assert.equal(await f.ports.stop(raw.current,'resident'),false);assert.deepEqual(f.kills,[]);
});
test('definition changes after listing refuse before managed destructive effects', async t => {
 for (const action of ['stop', 'kill', 'restart']) await t.test(action, async t => {
  const f = fixture(t); await seed(f);
  await f.runner.start({agentId:'a',service:'fixture',fileText:'#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"',command:'fixture',env:{}});
  const r = await request(f, action), list = f.definitions.list.bind(f.definitions);
  f.definitions.list = async () => {
   const snapshot = await list();
   await f.definitions.set('a', {...f.agent, model:'moved'}, {installed:new Set(['hermes'])});
   return snapshot;
  };
  const answer = await f.ports.lifecycle.execute(r);
  assert.deepEqual({status:answer.status, outcome:answer.outcome, effects:f.kills, tracked:f.runner.list().length},
   {status:'refused', outcome:'revision-moved', effects:[], tracked:1});
  assert.equal(f.ports.stopFacts().size, 0);
 });
});

test('healthy managed stop holds definition authority through the actual fake effect', async t => {
 const f = fixture(t); await seed(f);
 await f.runner.start({agentId:'a',service:'fixture',fileText:'#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"',command:'fixture',env:{}});
 const r = await request(f, 'stop'); let lockHeld = false;
 f.child.kill = () => {
  lockHeld = fs.existsSync(path.join(f.home,'definitions','.lock'));
  f.kills.push('child'); f.setAlive(false);
 };
 const answer = await f.ports.lifecycle.execute(r);
 assert.deepEqual({status:answer.status, lockHeld, effects:f.kills},
  {status:'done', lockHeld:true, effects:['child','tree']});
 assert.equal(fs.existsSync(path.join(f.home,'definitions','.lock')), false);
 assert.equal([...f.ports.stopFacts().values()][0], true);
});

test('foreign resident cannot be interpreted as absence',async t=>{
 const f=fixture(t,'resident');await seed(f);fs.mkdirSync(path.join(f.home,'residents'));
 const r={agentId:'a',lifetime:'11111111-1111-4111-8111-111111111111',instance:'foreign',harness:'hermes',pid:424242,launcher:'C:/fixture/hermes-aify',writtenAtUs:1700000000001000};
 fs.writeFileSync(path.join(f.home,'residents',`a.${r.lifetime}.json`),JSON.stringify(r));assert.equal(f.host.rawIdentity('a').unknown,true);
});

test('a lifecycle start tells the spawned child exactly the revision it was admitted against', async t => {
 // A SECOND REVISION, so the number the child is told can only be the admitted one, not a constant.
 const f = fixture(t); await seed(f); await f.definitions.set('a', {...f.agent, model:'second'}, {installed:new Set(['hermes'])});
 const r = await request(f, 'start');
 assert.equal(r.expectedRevision, 2, 'CONTROL: the request was built against the second revision');
 assert.equal((await f.ports.lifecycle.execute(r)).status, 'done');
 assert.equal(f.spawned.length, 1, 'the start spawned nothing');
 assert.deepEqual([f.spawned[0].AIFY_DEFINITION_INCARNATION, f.spawned[0].AIFY_DEFINITION_REVISION], [String(r.expectedIncarnation), '2']);
});

const automatic = async f => ({ ...await request(f, 'start', 'automatic'), startIntent: 'automatic' });

test('a cold automatic start launches once, writes no stop fact, and replays the same result', async t => {
 const f = fixture(t); await seed(f);
 const row = await automatic(f);
 const answer = await f.ports.lifecycle.execute(row);
 assert.equal(answer.status, 'done'); assert.equal(f.spawned.length, 1);
 assert.deepEqual([...f.ports.stopFacts()], []);
 assert.deepEqual(await f.ports.lifecycle.execute(row), answer);
 const { startIntent, ...explicit } = row;
 assert.equal((await f.ports.lifecycle.execute(explicit)).outcome, 'idempotency-conflict');
 assert.equal(f.spawned.length, 1);
});

test('automatic dispatch refuses a hold applied after enqueue, but explicit Start releases it', async t => {
 const f = fixture(t); await seed(f);
 const queued = await automatic(f);
 const stop = await f.ports.lifecycle.execute(await request(f, 'stop', 'hold'));
 assert.equal(stop.status, 'done', 'control: the hold was applied after enqueue');
 let prepared = 0;
 const refused = await f.ports.lifecycle.execute(queued, { buildSpec() { prepared++; }, start() { assert.fail('no start'); } });
 assert.deepEqual([refused.status, refused.outcome, prepared, f.spawned.length, ...f.ports.stopFacts().values()],
   ['refused', 'stopped-by-operator', 0, 0, true]);
 assert.equal((await f.ports.lifecycle.execute(await request(f, 'start', 'explicit'))).status, 'done');
 assert.equal(f.spawned.length, 1); assert.deepEqual([...f.ports.stopFacts().values()], [false]);
 assert.deepEqual(await f.ports.lifecycle.execute(queued), refused, 'a replay cannot turn the original refusal into success');
});

test('a worker that appears after automatic enqueue is never duplicated', async t => {
 const f = fixture(t); await seed(f);
 const queued = await automatic(f);
 assert.equal((await f.ports.lifecycle.execute(await request(f, 'start', 'other'))).status, 'done');
 const before = f.host.rawIdentity('a').current;
 const answer = await f.ports.lifecycle.execute(queued);
 assert.deepEqual([answer.status, answer.outcome, f.spawned.length], ['refused', 'lifetime-moved', 1]);
 assert.deepEqual(f.host.rawIdentity('a').current, before);
});

test('automatic intent is durable without changing legacy journal tuples', async t => {
 const f = fixture(t); await seed(f);
 const file = path.join(f.home, 'agent-lifecycle.json');
 const legacy = await request(f, 'stop', 'legacy');
 const receipt = { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: '2026-11-01T00:00:00Z' };
 const intent = JSON.stringify([legacy.id, legacy.agentId, legacy.machineId, legacy.storeId, legacy.expectedIncarnation,
   legacy.expectedRevision, null, 'stop', legacy.requestedBy, false]);
 const records = { legacy: { intent, agentId: 'a', phase: 'terminal', result: receipt,
   unknown: { ...receipt, status: 'failed', outcome: 'execution-unknown' } } };
 fs.writeFileSync(file, JSON.stringify({version:1, records, stops:{}}));
 assert.deepEqual(await f.ports.lifecycle.execute(legacy), receipt);
 const row = await automatic(f), first = await f.ports.lifecycle.execute(row);
 assert.equal(first.status, 'done');
 const image = JSON.parse(fs.readFileSync(file, 'utf8'));
 assert.deepEqual(image.records.legacy, records.legacy);
 assert.equal(JSON.parse(image.records[row.id].intent).length, 10);
 assert.equal(image.records[row.id].startIntent, 'automatic');
 const reopened = new LifecycleJournal({file});
 assert.deepEqual(reopened.reserveAutomaticStart(row).result, first);
 assert.throws(() => reopened.finish({...row, startIntent: undefined}, receipt), /receipt-intent-moved/);
 image.records[row.id].startIntent = 'unrecognized';
 fs.writeFileSync(file, JSON.stringify(image));
 assert.throws(() => reopened.stopFacts(), /lifecycle-journal-malformed/);
});
