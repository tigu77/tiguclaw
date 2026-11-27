import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { makeBootRunner, type BootDelivery } from "./_update-boot-harness.js";
import { updateOriginSession } from "../../core/self-update.js";
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
  const AsyncFunction = Object.getPrototypeOf(async()=>{}).constructor;
  const helper = await import(pathToFileURL(path.join(ROOT,"bin/update-marker.mjs")).href);
  // ★부팅 소비 영역 전체(실패 선점·성공 대기·일반 재시작 통지)를 실제 코드로 돈다 — 조각별로 돌리면 이음매가 빠진다(공용 실행기).
  const bootRunner = await makeBootRunner(ROOT);
  const runBoot = async (o:{files:Map<string,string>;pathApi?:typeof path.posix;home?:string;boot:any;deliver?:(d:BootDelivery)=>unknown;now?:()=>number;sleep?:(ms:number)=>Promise<void>;renameFail?:string;reboot?:boolean;afterClaim?:(files:Map<string,string>)=>void;beforeClaim?:(files:Map<string,string>)=>void;claimReadFail?:boolean|((claim:string)=>boolean);readdirFail?:boolean;afterRead?:(n:string,files:Map<string,string>)=>void}) => {
    const missing=()=>Object.assign(Error("missing"),{code:"ENOENT"});
    const pa=o.pathApi??path.posix;
    const fsp={readFile:async(n:string)=>{if(n.includes(".claim-")&&(typeof o.claimReadFail==="function"?o.claimReadFail(n):o.claimReadFail))throw Object.assign(Error("EIO"),{code:"EIO"});if(!o.files.has(n))throw missing();const v=o.files.get(n)!;o.afterRead?.(n,o.files);return v;},writeFile:async(n:string,raw:string)=>{o.files.set(n,raw);},unlink:async(n:string)=>{if(!o.files.has(n))throw missing();o.files.delete(n);},
      rename:async(a:string,b:string)=>{if(b.includes(".claim-"))o.beforeClaim?.(o.files);if(o.renameFail)throw Object.assign(Error(o.renameFail),{code:o.renameFail});if(!o.files.has(a))throw missing();o.files.set(b,o.files.get(a)!);o.files.delete(a);o.afterClaim?.(o.files);},
      readdir:async(dir:string)=>{if(o.readdirFail)throw Object.assign(Error("EACCES: readdir (fixture)"),{code:"EACCES"});return [...o.files.keys()].filter(n=>pa.join(dir,pa.basename(n))===n).map(n=>pa.basename(n));}};
    return bootRunner({fsp,updateOriginSession,home:o.home??c.homeAbs,pathApi:pa,boot:o.boot,...(o.deliver?{deliver:o.deliver}:{}),...(o.now?{now:o.now}:{}),...(o.sleep?{sleep:o.sleep}:{}),...(o.reboot?{reboot:true}:{})});
  };
  const fixturePaths = [path.posix, path.win32];
  for(const fixturePath of fixturePaths) for(const failed of [false,true]) {
    const legacyFile = fixturePath.join(c.homeAbs, ".update-complete");
    const files = new Map([[legacyFile,JSON.stringify({notify:{channel:"telegram",target:"original"},to:"1234567"})]]);
    if(failed)files.set(fixturePath.join(c.homeAbs,".update-failed"),JSON.stringify({stage:"build",outcome:"rolled-back",notify:{channel:"telegram",target:"original"}}));
    try { const r=await runBoot({files,pathApi:fixturePath as typeof path.posix,boot:{}}); out.push(assert(`actual boot consumer ${fixturePath.sep} refuses legacy completion (failure=${failed}) without suppressing later restarts`,r.updateNotified===failed&&r.success.length===0&&r.failure.length===(failed?1:0)&&r.restart.length===(failed?0:1)&&files.has(legacyFile),{r})); }
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
      const result=await helper.consumeUpdateMarker({boot,failure:null,now:()=>clock,read:async(n:string)=>files.get(n)??null,write:async(n:string,raw:string)=>{files.set(n,raw);},remove:async(n:string,raw:string)=>{if(files.get(n)===raw){removed++;files.delete(n);}},sleep:async(ms:number)=>{clock+=ms;polls++;if(change)files.set(".update-pending",JSON.stringify(change));}});
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
      const r=await consume(marker);out.push(assert(`shared consumer refuses ${label}, no deletion or success claim`,!r.result.handled&&!r.result.data&&r.removed===0,r));
    }
    const timeout=await consume(pending);out.push(assert("pending never consumed; bounded timeout blocks restart fallback",timeout.result.handled&&!timeout.result.data&&timeout.removed===0&&timeout.clock===helper.UPDATE_CONFIRM_WAIT_MS,timeout));
    // Persistent receipt is separate from the producer-owned CAS raw bytes.
    const lifecycleFiles=new Map<string,string>([[".update-pending",JSON.stringify(pending)]]);
    let lifecycleClock=0, replacementAtRemove=false;
    const lifecycle=(currentBoot=boot, onSleep?:()=>void)=>helper.consumeUpdateMarker({
      boot:currentBoot,failure:null,now:()=>lifecycleClock,
      read:async(n:string)=>lifecycleFiles.get(n)??null,
      write:async(n:string,raw:string)=>{lifecycleFiles.set(n,raw);},
      remove:async(n:string,raw:string)=>{if(replacementAtRemove)lifecycleFiles.set(n,JSON.stringify({...pending,expected:{...expected,notBefore:expected.notBefore+1}}));if(lifecycleFiles.get(n)===raw)lifecycleFiles.delete(n);},
      sleep:async(ms:number)=>{lifecycleClock+=ms;onSleep?.();},
    });
    const first=await lifecycle();
    const firstClock=lifecycleClock;
    const nextBoot={...boot,bootId:"44444444-4444-4444-8444-444444444444"};
    const second=await lifecycle(nextBoot);
    out.push(assert("expired observation never repeats 82500ms wait on next boot; pending CAS bytes preserved",first.handled&&!second.handled&&!second.data&&lifecycleClock===firstClock&&lifecycleFiles.get(".update-pending")===JSON.stringify(pending),{first,second,firstClock,lifecycleClock}));
    // Execute the real CLI producer's confirmation block after the consumer timed out.
    const casStart=source.indexOf("  if (pending) {",source.indexOf("const restartFailed ="));
    const casEnd=source.indexOf("  // ── 단계 8b:",casStart);
    const cas=source.slice(casStart,casEnd);
    const casDeps={pending,pendingPath:".update-pending",restartFailed:false,finalLaunch:{confirmed:boot},updateMarkerMatches:helper.updateMarkerMatches,
      readFileSync:(n:string)=>lifecycleFiles.get(n),writeFileSync:(n:string,raw:string)=>lifecycleFiles.set(n,raw),
      renameSync:(a:string,b:string)=>{lifecycleFiles.set(b,lifecycleFiles.get(a)!);lifecycleFiles.delete(a);},console:{error(){}}};
    new Function(...Object.keys(casDeps),cas)(...Object.values(casDeps));
    out.push(assert("actual CLI raw CAS still confirms after consumer timeout",JSON.parse(lifecycleFiles.get(".update-pending")!).state==="confirmed",lifecycleFiles.get(".update-pending")));
    const late=await lifecycle();
    out.push(assert("late confirmed success takes precedence over timeout receipt",Boolean(late.data)&&!lifecycleFiles.has(".update-pending"),late));
    lifecycleFiles.set(".update-pending",JSON.stringify({...pending,ts:1,expected:{...expected,notBefore:expected.notBefore-1}}));
    const beforeNew=lifecycleClock;
    const newPending=JSON.parse(lifecycleFiles.get(".update-pending")!);
    const newSuccess=await lifecycle(boot,()=>lifecycleFiles.set(".update-pending",JSON.stringify({...newPending,state:"confirmed",confirmed:boot})));
    out.push(assert("new update ignores old receipt and old timestamp; normal confirmation waits",Boolean(newSuccess.data)&&lifecycleClock===beforeNew+250,newSuccess));
    lifecycleFiles.set(".update-pending",JSON.stringify(confirmed));replacementAtRemove=true;
    await lifecycle();
    out.push(assert("replacement at remove survives read-before-unlink CAS",lifecycleFiles.has(".update-pending"),[...lifecycleFiles]));
    replacementAtRemove=false;
    lifecycleFiles.clear();lifecycleFiles.set(".update-pending",JSON.stringify(pending));
    const beforeFailure=lifecycleClock;
    const interrupted=await lifecycle(boot,()=>lifecycleFiles.set(".update-failed","{}"));
    out.push(assert("failure wins while pending confirmation is awaited",interrupted.handled&&!interrupted.data&&lifecycleClock===beforeFailure+250&&lifecycleFiles.has(".update-failed"),interrupted));
    lifecycleFiles.delete(".update-failed");
    const failedNext=await lifecycle(nextBoot);
    out.push(assert("failed observation does not suppress or delay next boot",!failedNext.handled&&!failedNext.data,failedNext));
    lifecycleFiles.clear();lifecycleFiles.set(".update-pending",JSON.stringify(pending));
    const intermediate=await lifecycle({...boot,bootId:expected.oldBootIds[0]});
    out.push(assert("intermediate boot does not retire producer pending",!intermediate.data&&!lifecycleFiles.has(".update-observed")&&lifecycleFiles.get(".update-pending")===JSON.stringify(pending),[...lifecycleFiles]));
    const finalAfterIntermediate=await lifecycle(boot,()=>lifecycleFiles.set(".update-pending",JSON.stringify(confirmed)));
    out.push(assert("final boot still waits and confirms after intermediate boot",Boolean(finalAfterIntermediate.data),finalAfterIntermediate));
    lifecycleFiles.clear();lifecycleFiles.set(".update-pending",JSON.stringify(pending));
    const replacement={...pending,expected:{...expected,notBefore:expected.notBefore-10}};
    const swapped=await lifecycle(boot,()=>lifecycleFiles.set(".update-pending",JSON.stringify(replacement)));
    out.push(assert("replaced expectation while waiting stays untouched and is not retired",!swapped.data&&lifecycleFiles.get(".update-pending")===JSON.stringify(replacement)&&!lifecycleFiles.has(".update-observed"),swapped));
    lifecycleFiles.clear();lifecycleFiles.set(".update-complete",JSON.stringify({to:"legacy"}));
    const legacyFirst=await lifecycle();const legacyNext=await lifecycle(nextBoot);
    out.push(assert("legacy survives both boots as non-success evidence without repeat suppression",!legacyFirst.handled&&!legacyNext.handled&&!legacyFirst.data&&!legacyNext.data&&lifecycleFiles.has(".update-complete"),{legacyFirst,legacyNext}));
    const ordinary=await helper.consumeUpdateMarker({boot,failure:null,read:async()=>null,write:async()=>{},remove:async()=>{}});
    out.push(assert("normal boot keeps general restart notification",ordinary.handled===false,ordinary));
    const ok=await consume(pending,confirmed);out.push(assert("same CLI confirmed boot only, one delivery claim, original destination",ok.polls===1&&ok.removed===1&&ok.result.data?.notify?.target==="original-target",ok.result));
    const failed=await consume(confirmed,undefined,true);out.push(assert("failure wins simultaneous completion",!failed.result.data&&failed.removed===0,failed.result));
    const H=c.homeAbs, PEND=path.posix.join(H,".update-pending"), FAIL=path.posix.join(H,".update-failed");
    const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const origin={channel:"telegram",target:"chat-1",threadKey:"dashboard:side"};
    const fail=(attempt:string|undefined,notify:any=origin,outcome="restart-unconfirmed")=>JSON.stringify({stage:"restart",outcome,...(attempt?{attempt}:{}),notify});
    const clockFor=()=>{const k={t:0};return {now:()=>k.t,sleep:async(ms:number)=>{k.t+=ms;},k};};
    for (const fixturePath of fixturePaths) for (const failure of [false,true]) {
      const pendingFile=fixturePath.join(c.homeAbs,".update-pending");
      const files=new Map([[pendingFile,JSON.stringify(confirmed)]]);
      if(failure)files.set(fixturePath.join(c.homeAbs,".update-failed"),fail(undefined,pending.notify));
      const r=await runBoot({files,pathApi:fixturePath as typeof path.posix,boot});
      out.push(assert(`actual index boot consumer ${fixturePath.sep} verified success/failure arbitration ${failure}`,r.updateNotified===true&&r.success.length===(failure?0:1)&&r.failure.length===(failure?1:0)&&r.restart.length===0&&(failure||r.success[0].target==="original-target")&&files.has(pendingFile)===failure&&!files.has(fixturePath.join(c.homeAbs,".update-failed")),{r,files:[...files.keys()]}));
    }
    // 발원 세션 귀속 — 성공·실패 모두 요청 세션(비기본)으로 · 세션 없는 옛 마커는 기본 세션·origin 미지정(지어내지 않음).
    {
      const ok=await runBoot({files:new Map([[PEND,JSON.stringify({...confirmed,attempt:A,notify:origin})]]),boot});
      const bad=await runBoot({files:new Map([[FAIL,fail(A)]]),boot});
      const old=await runBoot({files:new Map([[FAIL,fail(undefined,{channel:"telegram",target:"chat-1"})]]),boot});
      const internal=await runBoot({files:new Map([[FAIL,fail(A,{...origin,threadKey:"worker:job-1"})]]),boot});
      out.push(assert("origin session: success and failure land in the requesting non-default session; legacy marker stays default with no origin",
        ok.success.length===1&&ok.success[0].observeThreadKey==="dashboard:side"&&ok.success[0].originThreadKey==="dashboard:side"&&ok.success[0].target==="chat-1"&&
        bad.failure.length===1&&bad.failure[0].observeThreadKey==="dashboard:side"&&bad.failure[0].originThreadKey==="dashboard:side"&&
        old.failure.length===1&&old.failure[0].observeThreadKey==="dashboard:default"&&old.failure[0].originThreadKey===undefined&&
        internal.failure[0]?.observeThreadKey==="dashboard:default",{ok:ok.deliveries,bad:bad.deliveries,old:old.deliveries,internal:internal.deliveries}));
    }
    // 시도 판정 — 다른 시도의 실패는 이 시도의 성공을 막지 않는다 · 같은 시도/옛 마커(시도 없음)는 실패 우선.
    for (const [label,failAttempt,pendAttempt,wantSuccess] of [["other attempt",B,A,1],["same attempt",A,A,0],["legacy failure without attempt",undefined,A,0],["legacy pending without attempt",B,undefined,0]] as const) {
      const files=new Map([[PEND,JSON.stringify({...confirmed,...(pendAttempt?{attempt:pendAttempt}:{}),notify:origin})],[FAIL,fail(failAttempt)]]);
      const r=await runBoot({files,boot});
      out.push(assert(`attempt arbitration: ${label} → success ${wantSuccess}, its failure delivered once to its own origin`,r.success.length===wantSuccess&&r.failure.length===1&&r.restart.length===0&&!files.has(FAIL),{r:r.deliveries}));
    }
    // 대기 중 이 시도의 실패가 나타남 → 이번 부팅에 1회 통지 · 다음 부팅 0 · 다른 시도의 실패는 대기를 끊지 않는다.
    {
      const k=clockFor(); const files=new Map([[PEND,JSON.stringify({...pending,attempt:A,notify:origin})]]);
      let n=0; const r=await runBoot({files,boot,now:k.now,sleep:async(ms)=>{await k.sleep(ms);if(++n===2)files.set(FAIL,fail(A));}});
      const next=await runBoot({files,boot:nextBoot});
      out.push(assert("late same-attempt failure while waiting is notified this boot exactly once; next boot sends nothing for it",r.updateNotified&&r.failure.length===1&&r.success.length===0&&r.restart.length===0&&k.k.t===500&&!files.has(FAIL)&&next.failure.length===0,{r:r.deliveries,next:next.deliveries,t:k.k.t}));
      const k2=clockFor(); const files2=new Map([[PEND,JSON.stringify({...pending,attempt:A,notify:origin})]]);
      let m=0; const r2=await runBoot({files:files2,boot,now:k2.now,sleep:async(ms)=>{await k2.sleep(ms);if(++m===2)files2.set(FAIL,fail(B));if(m===4)files2.set(PEND,JSON.stringify({...confirmed,attempt:A,notify:origin}));}});
      out.push(assert("other attempt's failure appearing while waiting does not decide this attempt",r2.success.length===1&&r2.failure.length===0&&files2.has(FAIL),{r2:r2.deliveries}));
    }
    // CLI 조기 종료 — pending 그대로 · 유한 대기 · 통지 0 · 일반 재시작 통지로 대신하지 않는다.
    {
      const k=clockFor(); const raw=JSON.stringify({...pending,attempt:A,notify:origin}); const files=new Map([[PEND,raw]]);
      const r=await runBoot({files,boot,now:k.now,sleep:k.sleep,reboot:false});
      out.push(assert("CLI died before confirming: pending preserved byte-for-byte, wait bounded, no success/failure, restart notice not substituted",r.updateNotified===true&&r.deliveries.length===0&&files.get(PEND)===raw&&k.k.t===helper.UPDATE_CONFIRM_WAIT_MS&&files.has(path.posix.join(H,".update-observed")),{d:r.deliveries,t:k.k.t}));
    }
    // 읽기·통지 구분 — 부재/선점 실패/깨짐/배달 거절/배달 예외.
    {
      const refused=await runBoot({files:new Map([[FAIL,fail(A)],[PEND,JSON.stringify({...confirmed,attempt:A,notify:origin})]]),boot,deliver:()=>({delivered:false,reason:"channel not registered"})});
      const thrown=await runBoot({files:new Map([[FAIL,fail(A)]]),boot,deliver:()=>{throw new Error("send failed");}});
      const broken=await runBoot({files:new Map([[FAIL,"{broken"],[PEND,JSON.stringify({...confirmed,attempt:A,notify:origin})]]),boot});
      const lockedFiles=new Map([[FAIL,fail(A)],[PEND,JSON.stringify({...confirmed,attempt:A,notify:origin})]]);
      const locked=await runBoot({files:lockedFiles,boot,renameFail:"EPERM"});
      const none=await runBoot({files:new Map(),boot});
      const unreadFiles=new Map([[FAIL,fail(A)],[PEND,JSON.stringify({...confirmed,attempt:A,notify:origin})]]);
      const unread=await runBoot({files:unreadFiles,boot,claimReadFail:true});
      out.push(assert("claimed but unreadable failure record is kept (not deleted), success and restart notices blocked",unread.boot.consumed&&unread.deliveries.length===0&&[...unreadFiles.keys()].some(n=>n.includes(".claim-"))&&JSON.parse([...unreadFiles.entries()].find(([n])=>n.includes(".claim-"))![1]).attempt===A,{keys:[...unreadFiles.keys()],d:unread.deliveries}));
      out.push(assert("read vs notify: refused/throw = consumed, delivered false, logged · broken = consumed, no send, success blocked · claim error = success blocked, file kept · absent = not a failure",
        refused.boot.consumed&&refused.boot.delivered===false&&refused.success.length===0&&refused.logs.some(l=>/배달되지 않았습니다/.test(l))&&
        thrown.boot.consumed&&thrown.boot.delivered===false&&thrown.logs.some(l=>/배달이 실패/.test(l))&&
        broken.boot.consumed&&broken.deliveries.length===0&&broken.updateNotified===true&&
        locked.boot.consumed&&locked.deliveries.length===0&&lockedFiles.has(FAIL)&&locked.restart.length===0&&
        none.boot.consumed===false&&none.restart.length===1,{refused:refused.boot,thrown:thrown.boot,broken:broken.deliveries,locked:locked.deliveries,none:none.deliveries}));
    }
    // 선점 직후 CLI 가 새 기록 B 를 쓰면 B 는 남는다(지우지 않는다).
    {
      const files=new Map([[FAIL,fail(A)]]); let wrote=false;
      const r=await runBoot({files,boot,afterClaim:(f)=>{if(!wrote){wrote=true;f.set(FAIL,fail(B));}}});
      out.push(assert("record written right after the claim survives for the next consumer",r.failure.length===1&&JSON.parse(files.get(FAIL)??"{}").attempt===B&&![...files.keys()].some(n=>n.includes(".claim-")),{keys:[...files.keys()]}));
    }
    // 관찰한 A 를 선점하기 **전**에 CLI 가 A 를 .unsent 로 옮기고 B 를 공개 → A·B 각자 자기 좌표로 1회(§14 — 종전엔 A 보존만·배달 0) · 성공 0 · 다음 부팅 0.
    {
      const k=clockFor(); const files=new Map([[PEND,JSON.stringify({...pending,attempt:A,notify:origin})]]);
      const originB={channel:"http-bridge",target:"chat-B",threadKey:"dashboard:other"};
      let n=0, moved=false;
      const r=await runBoot({files,boot,now:k.now,sleep:async(ms)=>{await k.sleep(ms);if(++n===1)files.set(FAIL,fail(A));},
        beforeClaim:(f)=>{if(moved||!f.has(FAIL))return;moved=true;f.set(FAIL+".unsent-1",f.get(FAIL)!);f.set(FAIL,fail(B,originB));}});
      const next=await runBoot({files,boot:nextBoot});
      const toB=r.failure.filter(d=>d.target==="chat-B"), toA=r.failure.filter(d=>d.target==="chat-1");
      out.push(assert("observed A moved aside before the claim: A and B each delivered once to their own origin, no success, no restart notice, next boot 0",
        moved&&r.success.length===0&&r.restart.length===0&&r.failure.length===2&&toB.length===1&&toB[0]!.channel==="http-bridge"&&toB[0]!.observeThreadKey==="dashboard:other"&&toB[0]!.originThreadKey==="dashboard:other"&&
        toA.length===1&&toA[0]!.channel==="telegram"&&toA[0]!.observeThreadKey==="dashboard:side"&&toA[0]!.originThreadKey==="dashboard:side"&&
        ![...files.keys()].some(x=>x.startsWith(FAIL))&&next.deliveries.filter(d=>d.text!=="srv.restart.complete").length===0,{r:r.deliveries,keys:[...files.keys()],next:next.deliveries}));
    }
    // §14 옆 보존본 쓸기 경계 — 각자 한 번·자기 좌표 · 빈 예약/깨짐 = 배달 0·지움 · 읽기 오류 = 선점본 보존 · 배달 거절 = 시도 1·지움 · `.claim-*`/`.next-*` 손대지 않음 · 목록 실패 = 로그 · 판정 무관.
    {
      const C={channel:"telegram",target:"chat-C",threadKey:"dashboard:c"}, D={channel:"telegram",target:"chat-D"};
      const files=new Map([[FAIL,fail(B)],[FAIL+".unsent-1000-1-aaaa",fail(A,C,"rolled-back")],[FAIL+".unsent-2000-1-bbbb",fail(undefined,D)],
        [FAIL+".claim-9-9",fail(A,{channel:"telegram",target:"chat-claimed"})],[FAIL+".next-3000-1-cccc",fail(A,{channel:"telegram",target:"chat-next"})],[FAIL+".unsent-0500-1-dddd.claim-7-7",fail(A,{channel:"telegram",target:"chat-claimed2"})]]);
      const r=await runBoot({files,boot});
      const next=await runBoot({files,boot:nextBoot});
      const t=(x:string)=>r.failure.filter(d=>d.target===x);
      out.push(assert("sweep: fixed + two aside records each delivered once to their own origin (legacy aside = default session); claim/next leftovers untouched; next boot 0",
        r.failure.length===3&&t("chat-1").length===1&&t("chat-C").length===1&&t("chat-C")[0]!.observeThreadKey==="dashboard:c"&&t("chat-D").length===1&&t("chat-D")[0]!.observeThreadKey==="dashboard:default"&&t("chat-D")[0]!.originThreadKey===undefined&&
        r.restart.length===0&&files.has(FAIL+".claim-9-9")&&files.has(FAIL+".next-3000-1-cccc")&&files.has(FAIL+".unsent-0500-1-dddd.claim-7-7")&&![...files.keys()].some(x=>x.includes(".unsent-")&&!x.includes(".claim-"))&&
        next.failure.length===0&&r.logs.some(l=>l.endsWith("옆 보존 실패 기록 — 발견 2건 · 요청 좌표로 배달 시도 2건 · 배달 2건.")),{r:r.deliveries,keys:[...files.keys()],next:next.deliveries,logs:r.logs}));
      const edge=new Map([[FAIL+".unsent-1-empty",""],[FAIL+".unsent-2-broken","{broken"],[FAIL+".unsent-3-unread",fail(A,C)],[FAIL+".unsent-4-refused",fail(A,D)]]);
      const e=await runBoot({files:edge,boot,claimReadFail:(n)=>n.endsWith("-u2"),deliver:(d)=>d.target==="chat-D"?{delivered:false,reason:"channel not registered"}:{delivered:true}});
      const keys=[...edge.keys()];
      out.push(assert("sweep edges: empty reservation/broken = no send + removed · unreadable = claim kept, no send · refused = one attempt, not delivered, removed, logged · consumed records suppress the restart notice (fixed-path rule)",
        e.failure.length===1&&e.failure[0]!.target==="chat-D"&&keys.length===1&&keys[0]!.includes(".claim-")&&JSON.parse(edge.get(keys[0]!)!).notify.target==="chat-C"&&
        e.logs.some(l=>/배달되지 않았습니다/.test(l))&&e.logs.some(l=>/깨져/.test(l))&&e.logs.some(l=>l.endsWith("옆 보존 실패 기록 — 발견 4건 · 요청 좌표로 배달 시도 1건 · 배달 0건."))&&e.restart.length===0,{d:e.deliveries,keys,logs:e.logs}));
      // 생산자의 빈 예약(`wx`)을 소비자가 건드린 직후 생산자의 rename 이 완성본을 그 이름에 놓는다 — 그 기록은 살아남아 다음 부팅이 정확히 1회 보낸다(선점 없이 읽고 지우면 사라진다).
      const RES=FAIL+".unsent-5-reserved"; const resFiles=new Map([[RES,""]]); let filled=false;
      const fill=(f:Map<string,string>)=>{if(!filled){filled=true;f.set(RES,fail(B,C));}};
      const res1=await runBoot({files:resFiles,boot,afterClaim:(f)=>{if([...f.entries()].some(([k,v])=>k.includes(".claim-")&&v===""))fill(f);},afterRead:(n,f)=>{if(n===RES)fill(f);}});
      const res2=await runBoot({files:resFiles,boot:nextBoot});
      const res3=await runBoot({files:resFiles,boot:{...nextBoot,bootId:"55555555-5555-4555-8555-555555555555"}});
      out.push(assert("sweep vs producer filling a reservation: the record survives the sweep and the next boot delivers it exactly once",
        filled&&res1.failure.length===0&&res2.failure.length===1&&res2.failure[0]!.target==="chat-C"&&res3.failure.length===0&&resFiles.size===0,{res1:res1.deliveries,res2:res2.deliveries,keys:[...resFiles.keys()]}));
      const ld=new Map([[FAIL,fail(A)],[FAIL+".unsent-1",fail(B,C)]]);
      const l=await runBoot({files:ld,boot,readdirFail:true});
      out.push(assert("sweep listing failure: logged, fixed record still delivered, aside kept for a later boot",l.failure.length===1&&l.failure[0]!.target==="chat-1"&&ld.has(FAIL+".unsent-1")&&l.logs.some(x=>/목록을 읽지 못했습니다/.test(x)),{d:l.deliveries,logs:l.logs}));
      // 판정 무관: 이 부팅이 기다린 시도 A 의 성공은 옆 보존본(B 의 실패)에 막히지 않고, 옆 보존본은 자기 좌표로 따로 간다.
      const ok=await runBoot({files:new Map([[PEND,JSON.stringify({...confirmed,attempt:A,notify:origin})],[FAIL+".unsent-1",fail(B,C)]]),boot});
      out.push(assert("sweep does not decide this boot's attempt: A success 1 + aside B failure 1 to its own origin, no restart notice",ok.success.length===1&&ok.success[0]!.target==="chat-1"&&ok.failure.length===1&&ok.failure[0]!.target==="chat-C"&&ok.restart.length===0,ok.deliveries));
    }
    // 재부팅 스케줄이 있어도 업데이트 결과는 업데이트 통지로 간다(일반 재시작 통지 0).
    {
      const r=await runBoot({files:new Map([[PEND,JSON.stringify({...confirmed,attempt:A,notify:origin})]]),boot,reboot:true});
      out.push(assert("reboot schedule present: update success still delivered by the update consumer, no built-in restart notice",r.success.length===1&&r.restart.length===0,r.deliveries));
    }
    const self=await readFile(path.join(ROOT,"src/core/self-update.ts"),"utf8");
    const a=self.indexOf("    // ── 단계 7: 완료 마커");const b=self.indexOf("    // ── 단계 9:",a);
    // 즉시 통지의 동적 import 만 대역으로 바꾼다(검사 쪽 치환) — 나머지는 실제 컴파일 결과.
    const producerSrc=ts.transpileModule(self.slice(a,b),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const lazyImport=producerSrc.includes('await import("./outbound.js")');
    out.push(assert("direct-mode restart notice still imports outbound lazily (fixture substitution point)",lazyImport,{lazyImport,producerChars:producerSrc.length}));
    const producer=producerSrc.replace('await import("./outbound.js")',"await __outbound()");
    for(const fixturePath of fixturePaths) for(const fail of [false,true]) {
      const pendingFile=fixturePath.join(c.homeAbs,".update-pending");
      const files=new Map<string,string>();let callback:()=>void=()=>{};
      const writes:string[]=[],reads:string[]=[];let restarted=0;const sent:any[]=[];
      const sideNotify={...pending.notify,threadKey:"dashboard:side"};
      const oldBoot={...boot,bootId:expected.oldBootIds[0],startedAt:boot.startedAt-1000};
      const deps={path:fixturePath,getPaths:()=>({home:c.homeAbs}),UPDATE_PENDING_MARKER:".update-pending",getUpdateBoot:()=>oldBoot,
        fs:{mkdir:async()=>{},writeFile:async(n:string,s:string)=>{writes.push(n);files.set(n,s);}},readFileSync:(n:string)=>{reads.push(n);return files.get(n);},writeFileSync:(n:string,s:string)=>{writes.push(n);files.set(n,s);},
        reportFrom:"old",newSha:boot.revision,changed:["fixture"],randomUUID:()=>A,notify:sideNotify,deps:{notify:sideNotify},updateOriginSession,translate:(k:string)=>k,__outbound:async()=>({deliverOutbound:async(d:any)=>{sent.push(d);return {delivered:true};}}),resolveRestart:()=>()=>{restarted++;return !fail;},restartDelayMs:1,console:{error(){}},setTimeout:(f:()=>void)=>{callback=f;return {unref(){}};}};
      await new AsyncFunction(...Object.keys(deps),"let triggeredRestart=false;"+producer)(...Object.values(deps));callback();
      await new Promise(r=>setTimeout(r,20));
      const marker=JSON.parse(files.get(pendingFile)??"null");
      out.push(assert(`direct-mode ${fixturePath.sep} ${fail?"restart refusal notice lands in the requesting session":"no immediate notice"}`,fail?sent.length===1&&sent[0].observeThreadKey==="dashboard:side"&&sent[0].originThreadKey==="dashboard:side"&&sent[0].target==="original-target":sent.length===0,sent));
      const fresh={...boot,startedAt:Date.now()};
      out.push(assert(`actual self-update compiled producer ${fixturePath.sep} ${fail?"restart refusal":"ready"}`,marker?.mode==="direct"&&marker.state===(fail?"failed":"ready")&&marker.attempt===A&&marker.notify.target==="original-target"&&helper.updateMarkerMatches(marker,fresh)===!fail&&restarted===1&&writes.length===(fail?2:1)&&writes.every(n=>n===pendingFile)&&reads.length===(fail?1:0)&&!files.has(fixturePath.join(c.homeAbs,".update-complete")),{marker,writes,reads,restarted}));
    }
    {
      const pendingFile=path.posix.join(c.homeAbs,".update-pending");
      const files=new Map<string,string>();let callback:()=>void=()=>{};
      const oldBoot={...boot,bootId:expected.oldBootIds[0],startedAt:boot.startedAt-1000};
      const deps={path:path.posix,getPaths:()=>({home:c.homeAbs}),UPDATE_PENDING_MARKER:".update-pending",getUpdateBoot:()=>oldBoot,
        fs:{mkdir:async()=>{},writeFile:async(n:string,s:string)=>{files.set(n,s);}},readFileSync:(n:string)=>files.get(n),writeFileSync:(n:string,s:string)=>{files.set(n,s);},
        reportFrom:"old",newSha:boot.revision,changed:["fixture"],randomUUID:()=>A,notify:pending.notify,deps:{notify:pending.notify},updateOriginSession,translate:(k:string)=>k,
        __outbound:async()=>({deliverOutbound:async()=>({delivered:true})}),resolveRestart:()=>()=>false,restartDelayMs:1,console:{error(){}},setTimeout:(f:()=>void)=>{callback=f;return {unref(){}};}};
      await new AsyncFunction(...Object.keys(deps),"let triggeredRestart=false;"+producer)(...Object.values(deps));
      const other=JSON.stringify({...JSON.parse(files.get(pendingFile)!),attempt:B});
      files.set(pendingFile,other);callback();await new Promise(r=>setTimeout(r,20));
      out.push(assert("direct-mode restart refusal does not rewrite another attempt's pending",files.get(pendingFile)===other,files.get(pendingFile)));
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
