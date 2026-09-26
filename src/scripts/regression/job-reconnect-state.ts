import fs from "node:fs";
import vm from "node:vm";
import { registerJob, markDone, markCancelled, markFailed, __resetJobsForTest } from "../../core/worker-jobs.js";
import { initStore } from "../../store/sessions.js";
import { assert, assertIsolated, loadPluginModule, type RegressionCheck } from "./_framework.js";
export const check: RegressionCheck = {
  name: "job-reconnect-state", guards: "놓친 종료 이벤트를 목록 부재로만 판단해 완료·취소 결과를 복원하지 못하는 것",
  run: async () => {
    assertIsolated(); initStore(); __resetJobsForTest();
    const { handleWorkerJobs } = await loadPluginModule<{handleWorkerJobs:(ctx:unknown)=>Promise<void>}>("../../../plugins/http-bridge/routes-work.js");
    const read = async (suffix:string) => {
      let body="";
      await handleWorkerJobs({req:{},res:{writeHead:()=>{},end:(s:string)=>{body=s;}},url:new URL('http://x/worker-jobs'+suffix)});
      return JSON.parse(body);
    };
    const base={label:"복원",task:"합성",threadKey:"dashboard:restore",channel:"cli",channelUserId:"fixture"};
    const done=registerJob(base), cancelled=registerJob(base), failed=registerJob(base), running=registerJob(base);
    markDone(done,"결과 원문");markCancelled(cancelled,"사용자 취소");markFailed(failed,"실패 사유");
    const snapshots = await Promise.all([done,cancelled,failed,running].map(id=>read('?jobId='+id)));
    const list=await read('');
    const source=fs.readFileSync(new URL('../../../packages/dashboard/js/background-drawer.js',import.meta.url),'utf8');
    const extract=(name:string)=>{const m=source.match(new RegExp(`      const ${name} = \\([^)]*\\) => \\{[\\s\\S]*?\\n      \\};`));if(!m)throw Error(name);return m[0];};
    const cards=new Map<string,any>(snapshots.map(p=>[p.jobId,{status:'running',stateVersion:0,startTs:1}]));
    const applied:any[]=[];let fetches=0;let release:(()=>void)|undefined;
    const ctx:any={jobCards:cards,recoveringJobs:new Set(),TERMINAL_JOB_STATUS:new Set(['done','failed','cancelled','interrupted']),fmtTime:String,
      fetch:async(url:string)=>{fetches++;if(release)await new Promise<void>(r=>{release=r;});return {ok:true,json:()=>read(url.slice(url.indexOf('?')))};},
      handleWorkerEvent:(p:any)=>{applied.push(p);Object.assign(cards.get(p.jobId),p);cards.get(p.jobId).stateVersion++;}};
    vm.createContext(ctx);vm.runInContext(extract('recoverJobState')+'\n'+extract('applyJobsSnapshot')+'\nthis.recover=recoverJobState; this.apply=applyJobsSnapshot;',ctx);
    try {
      ctx.apply({jobs:[]},Date.now());
      for(let i=0;i<100&&ctx.recoveringJobs.size;i++)await new Promise(r=>setTimeout(r,5));
      const recovered=snapshots.map(p=>({id:p.jobId,status:cards.get(p.jobId).status,result:cards.get(p.jobId).result,error:cards.get(p.jobId).error}));
      // 새 SSE 상태를 늦은 단건 응답이 덮지 않는다.
      const entry=cards.get(running);release=()=>{};
      const pending=ctx.recover(running,entry);ctx.recover(running,entry);
      const beforeRelease=fetches;entry.stateVersion++;entry.status='cancelled';
      release!();await pending;release=undefined;
      // ── 1-3·그물 보강 (2026-09-26 전체 검토) ─────────────────────────────────────
      //  «중단됨» 카드도 대조 대상이다(M4) · 서버가 모르는 잡은 «중단됨»(M6) · 그렇게 정리된 카드는
      //  변화가 없으면 다시 안 묻는다(스냅샷이 턴마다 돌아 카드마다 매번 GET 이 나가던 것).
      const guessed=registerJob(base);markDone(guessed,"늦게 안 결과");
      cards.set(guessed,{status:'interrupted',stateVersion:0,startTs:1});
      const ghost='ghost-job-not-on-server';
      cards.set(ghost,{status:'running',stateVersion:0,startTs:1});
      const settle=async()=>{for(let i=0;i<100&&ctx.recoveringJobs.size;i++)await new Promise(r=>setTimeout(r,5));};
      ctx.apply({jobs:[]},Date.now());await settle();
      const guessedAfter=cards.get(guessed).status, ghostAfter=cards.get(ghost).status;
      const f1=fetches;ctx.apply({jobs:[]},Date.now());await settle();
      const refetch=fetches-f1;
      const versionBump=/const entry = ensureJobCard\(p\.jobId, \{ \.\.\.p, ts \}\);\s*\n\s*entry\.stateVersion = \(entry\.stateVersion \|\| 0\) \+ 1;/.exec(source.replace(/^\s*\/\/.*$/gm,''));
      return [
        assert('실제 종료 잡의 상태와 결과를 단건 조회', snapshots[0].status==='done'&&snapshots[0].result==='결과 원문'&&snapshots[1].status==='cancelled'&&snapshots[2].error==='실패 사유',snapshots),
        assert('실행 목록은 종료 잡을 섞지 않음',list.jobs.length===1&&list.jobs[0].jobId===running,list.jobs),
        assert('목록 누락 카드의 완료·취소·실패와 결과 복원',recovered[0].status==='done'&&recovered[0].result==='결과 원문'&&recovered[1].status==='cancelled'&&recovered[2].status==='failed',recovered),
        assert('목록에서 누락됐어도 서버가 running이면 유지',recovered[3].status==='running',recovered[3]),
        assert('★클라이언트가 «중단됨» 으로 추측한 카드도 서버 조회로 실제 완료를 되찾는다',guessedAfter==='done',{guessedAfter}),
        assert('★서버도 모르는 잡은 완료로 꾸미지 않고 «중단됨»',ghostAfter==='interrupted',{ghostAfter}),
        assert('★정리된 카드는 변화가 없으면 다음 스냅샷에서 다시 조회하지 않는다',refetch===0,{refetch}),
        assert('★실제 handleWorkerEvent 가 카드에 이벤트를 반영할 때마다 stateVersion 을 올린다(늦은 응답 판정의 전제)',versionBump!==null,versionBump?.[0]??'★ensureJobCard 바로 뒤에 stateVersion 증가 없음'),
        assert('중복 조회 합치기와 늦은 응답 덮어쓰기 방지',beforeRelease===5&&entry.status==='cancelled'&&ctx.recoveringJobs.size===0,{fetches,beforeRelease,status:entry.status,pending:ctx.recoveringJobs.size}),
      ];
    } finally {__resetJobsForTest();}
  },
};
