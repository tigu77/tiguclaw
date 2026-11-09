import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const source = await readFile(path.join(ROOT, "bin/daemon.mjs"), "utf8");
  const ast = ts.createSourceFile("daemon.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map<string,string>();
  for (const s of ast.statements) if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) declarations.set(d.name.text, `const ${d.getText(ast)};`);
  const fn = (names: string[], deps: Record<string,unknown>) => new Function(...Object.keys(deps), names.map(n => declarations.get(n)).join("\n") + `\nreturn ${names.at(-1)};`)(...Object.values(deps));
  const c = { homeAbs: "/fixture/home", repoRoot: "/fixture/repo", runtime: "built" };
  for (const f of [
    { name: "legacy owned process", health: {ok:false,why:"legacy"}, presence: {state:"running",pids:["7"]}, starts:0, error:false },
    { name: "new verified health", health: {ok:true}, presence: {state:"unknown",pids:[]}, starts:0, error:false },
    ...["legacy","wrong identity","malformed","timeout"].map(why => ({name:`unknown PID + ${why}`,health:{ok:false,why},presence:{state:"unknown",pids:[],why:"query failed"},starts:0,error:true})),
    { name:"empty PID + wrong HTTP",health:{ok:false,why:"wrong identity"},presence:{state:"stopped",pids:[]},starts:0,error:true },
    { name:"confirmed absence",health:{ok:false,absent:true},presence:{state:"stopped",pids:[]},starts:1,error:false },
  ]) {
    const calls = {ensure:0,ps:0,report:0}; const proc = {platform:"win32",exitCode:undefined as number|undefined};
    const deps: Record<string,unknown> = { path, process:proc, console:{log(){},warn(){},error(){}}, healthSaysOurs:()=>f.health, winPresence:()=>f.presence,
      isDaemonRunning:()=>f.health.ok, winPort:()=>4321, winTaskName:()=>"fixture", winEnsureTask:()=>{calls.ensure++;return "task";}, expectFreshLaunch:()=>{},
      winPs:()=>{calls.ps++;return {status:0};}, winEnableStartScript:()=>"synthetic", reportLaunch:()=>{calls.report++;}, waitForListening:()=>({verified:true}),listeningOnBridge:()=>({pids:[]}) };
    if(declarations.has("daemonPresence")) deps.daemonPresence = fn(["daemonPresence"], deps);
    try { fn(["winStart"],deps)({...c}); out.push(assert(`actual winStart ${f.name}`, calls.ensure===f.starts&&calls.ps===f.starts&&calls.report===f.starts&&(proc.exitCode===1)===f.error,{calls,exitCode:proc.exitCode})); }
    catch(e){out.push(assert(`actual winStart ${f.name}`,false,String(e)));}
  }
  for(const [label,status,body,wantAbsent] of [["spoofed HTTP absence",0,{ok:true,absent:true},false],["trusted refused exit",3,{},true],["timeout/query error",1,{},false]] as const) {
    const probe=fn(["healthSaysOurs"],{spawnSync:()=>({status,stdout:JSON.stringify(body)}),winPort:()=>4321,process:{execPath:"fixture-node",env:{}},instanceIdFor:()=>"a".repeat(64)})(c);
    out.push(assert(`actual health transport ${label}`,probe.ok===false&&Boolean(probe.absent)===wantAbsent,probe));
  }
  const index = await readFile(path.join(ROOT,"src/index.ts"),"utf8");
  const block = index.slice(index.indexOf("const updateNotified = await"), index.indexOf("// 매 부팅 재시작 통지"));
  const js = ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const AsyncFunction = Object.getPrototypeOf(async()=>{}).constructor;
  let helper:any;
  try { helper = await import(pathToFileURL(path.join(ROOT,"bin/update-marker.mjs")).href); } catch { /* baseline uses its real consumer, not an import failure proof */ }
  for(const failed of [false,true]) {
    let sent=0;
    const files = new Map([["/fixture/home/.update-complete",JSON.stringify({notify:{channel:"telegram",target:"original"},to:"1234567"})]]);
    const deps = {path,getPaths:()=>({home:c.homeAbs}),UPDATE_COMPLETE_MARKER:".update-complete",UPDATE_PENDING_MARKER:".update-pending",UPDATE_FAILED_MARKER:".update-failed",updateFailedNotified:failed,
      fsp:{readFile:async(p:string)=>{if(!files.has(p))throw Error("ENOENT");return files.get(p);},unlink:async(p:string)=>{files.delete(p);}},
      consumeUpdateMarker:helper?.consumeUpdateMarker, getUpdateBoot:()=>({}), translate:()=>"SUCCESS",deliverOutbound:async()=>{sent++;},bus:{},DEFAULT_SESSION_ID:"default",console:{error(){},warn(){},log(){}}};
    try { const handled=await new AsyncFunction(...Object.keys(deps), js+";return updateNotified;")(...Object.values(deps)); out.push(assert(`actual boot consumer refuses legacy completion (failure=${failed}) and handles context`,handled===true&&sent===0,{handled,sent})); }
    catch(e){out.push(assert("actual boot consumer execution",false,String(e)));}
  }
  if (helper) {
    const boot = {instanceId:"a".repeat(64),bootId:"11111111-1111-4111-8111-111111111111",startedAt:Date.now(),revision:"b".repeat(40)};
    const expected = {instanceId:boot.instanceId,notBefore:boot.startedAt-1,oldBootIds:["22222222-2222-4222-8222-222222222222"],revision:boot.revision};
    const pending = {mode:"cli",state:"pending",expected,notify:{channel:"original-channel",target:"original-target"}};
    const confirmed = {...pending,state:"confirmed",confirmed:boot};
    const consume = async(marker:any, change?:any, failure=false) => {
      const files=new Map<string,string>([[".update-pending",JSON.stringify(marker)]]); let clock=0,polls=0,removed=0;
      if(failure)files.set(".update-failed","{}");
      const result=await helper.consumeUpdateMarker({boot,failed:false,now:()=>clock,read:async(n:string)=>files.get(n)??null,remove:async(n:string,raw:string)=>{if(files.get(n)===raw){removed++;files.delete(n);}},sleep:async(ms:number)=>{clock+=ms;polls++;if(change)files.set(".update-pending",JSON.stringify(change));}});
      return {result,files,polls,removed,clock};
    };
    for(const [label,marker] of Object.entries({
      "wrong revision":{...confirmed,expected:{...expected,revision:"c".repeat(40)}},
      "wrong instance":{...confirmed,expected:{...expected,instanceId:"c".repeat(64)}},
      "old boot":{...confirmed,expected:{...expected,oldBootIds:[boot.bootId]}},
      "intermediate before cutoff":{...confirmed,expected:{...expected,notBefore:boot.startedAt+1}},
      "different final boot":{...confirmed,confirmed:{...boot,bootId:"33333333-3333-4333-8333-333333333333"}},
      "different final revision":{...confirmed,confirmed:{...boot,revision:"c".repeat(40)}},
      "rollback":{...confirmed,state:"failed"},
      "legacy":{notify:pending.notify},
    })) {
      const r=await consume(marker);out.push(assert(`shared consumer refuses ${label}, no deletion/fallback`,r.result.handled&&!r.result.data&&r.removed===0,r));
    }
    const timeout=await consume(pending);out.push(assert("pending never consumed; bounded timeout blocks restart fallback",timeout.result.handled&&!timeout.result.data&&timeout.removed===0&&timeout.clock===helper.UPDATE_CONFIRM_WAIT_MS,timeout));
    const ok=await consume(pending,confirmed);out.push(assert("same CLI confirmed boot only, one delivery claim, original destination",ok.polls===1&&ok.removed===1&&ok.result.data?.notify?.target==="original-target",ok.result));
    const failed=await consume(confirmed,undefined,true);out.push(assert("failure wins simultaneous completion",!failed.result.data&&failed.removed===0,failed.result));
    for (const failure of [false,true]) {
      const files=new Map([["/fixture/home/.update-pending",JSON.stringify(confirmed)]]); const deliveries:any[]=[];
      const deps={path,getPaths:()=>({home:"/fixture/home"}),getUpdateBoot:()=>boot,updateFailedNotified:failure,consumeUpdateMarker:helper.consumeUpdateMarker,
        fsp:{readFile:async(n:string)=>{if(!files.has(n))throw Object.assign(Error("missing"),{code:"ENOENT"});return files.get(n);},unlink:async(n:string)=>{files.delete(n);}},
        deliverOutbound:async(d:any)=>{deliveries.push(d);},translate:()=>"verified-success",bus:{},DEFAULT_SESSION_ID:"fixture",console:{error(){}}};
      const handled=await new AsyncFunction(...Object.keys(deps),js+";return updateNotified;")(...Object.values(deps));
      out.push(assert(`actual index boot consumer verified success/failure arbitration ${failure}`,handled&&deliveries.length===(failure?0:1)&&(failure||deliveries[0].target==="original-target"),deliveries));
    }
    {
      const files=new Map([["/fixture/home/.update-pending",JSON.stringify(confirmed)],["/fixture/home/.update-failed","{broken"]]);let sent=0;
      const failureBlock=index.slice(index.indexOf("const updateFailedNotified ="),index.indexOf("const updateNotified ="));
      const failureJs=ts.transpileModule(failureBlock,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
      const deps={path,getPaths:()=>({home:"/fixture/home"}),getUpdateBoot:()=>boot,consumeUpdateMarker:helper.consumeUpdateMarker,UPDATE_FAILED_MARKER:".update-failed",
        fsp:{readFile:async(n:string)=>{if(!files.has(n))throw Object.assign(Error("missing"),{code:"ENOENT"});return files.get(n);},unlink:async(n:string)=>{files.delete(n);}},
        deliverOutbound:async()=>{sent++;},translate:()=>"success",updateFailedText:()=>"failure",bus:{},DEFAULT_SESSION_ID:"fixture",console:{error(){}}};
      const handled=await new AsyncFunction(...Object.keys(deps),failureJs+js+";return updateNotified;")(...Object.values(deps));
      out.push(assert("actual malformed failure consumed first still blocks completion and general restart",handled&&sent===0,{handled,sent}));
    }
    const self=await readFile(path.join(ROOT,"src/core/self-update.ts"),"utf8");
    const a=self.indexOf("    // ── 단계 7: 완료 마커");const b=self.indexOf("    // ── 단계 9:",a);
    const producer=ts.transpileModule(self.slice(a,b),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    for(const fail of [false,true]) {
      const files=new Map<string,string>();let callback:()=>void=()=>{};
      const oldBoot={...boot,bootId:expected.oldBootIds[0],startedAt:boot.startedAt-1000};
      const deps={path,getPaths:()=>({home:"/fixture/home"}),UPDATE_PENDING_MARKER:".update-pending",getUpdateBoot:()=>oldBoot,
        fs:{mkdir:async()=>{},writeFile:async(n:string,s:string)=>{files.set(n,s);}},readFileSync:(n:string)=>files.get(n),writeFileSync:(n:string,s:string)=>files.set(n,s),
        reportFrom:"old",newSha:boot.revision,changed:["fixture"],notify:pending.notify,deps:{notify:pending.notify},resolveRestart:()=>()=>!fail,restartDelayMs:1,console:{error(){}},setTimeout:(f:()=>void)=>{callback=f;return {unref(){}};}};
      await new AsyncFunction(...Object.keys(deps),"let triggeredRestart=false;"+producer)(...Object.values(deps));callback();
      const marker=JSON.parse(files.get("/fixture/home/.update-pending")??"null");
      const fresh={...boot,startedAt:Date.now()};
      out.push(assert(`actual self-update compiled producer ${fail?"restart refusal":"ready"}`,marker?.mode==="direct"&&marker.state===(fail?"failed":"ready")&&marker.notify.target==="original-target"&&helper.updateMarkerMatches(marker,fresh)===!fail&&!files.has("/fixture/home/.update-complete"),marker));
    }
    const identity=await import(pathToFileURL(path.join(ROOT,"bin/runtime-identity.mjs")).href);
    // Separate module globals already initialized by the runner: check fixed snapshot,
    // not setting a fake revision in the parent regression process.
    const original=identity.getProcessIdentity({home:"/fixture/home",repoRoot:"/fixture/repo",runtime:"built"}).revision;
    identity.setBootRevision("c".repeat(40));
    out.push(assert("boot revision cannot be overwritten by later disk/head observations",identity.getProcessIdentity({home:"/fixture/home",repoRoot:"/fixture/repo",runtime:"built"}).revision===original, original));
    const copied=await readFile(path.join(ROOT,"bin/copy-dist-assets.mjs"),"utf8");
    out.push(assert("built asset layout copies both standalone helpers",copied.includes('copyFile("bin/runtime-identity.mjs")')&&copied.includes('copyFile("bin/update-marker.mjs")'), {identity:copied.includes('copyFile("bin/runtime-identity.mjs")'),marker:copied.includes('copyFile("bin/update-marker.mjs")')}));
  }
  return out;
};
export const check: RegressionCheck = {name:"t1-final-contract",guards:"Legacy duplicate-start and update completion success share verified final boot",run};
