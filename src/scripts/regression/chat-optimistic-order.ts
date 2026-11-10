/** Product-function regression: optimistic input, authoritative echo and live/history ordering. */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
const root = path.join(process.cwd(), "packages/dashboard/js");
const extract = (file: string, name: string, optional = false): string => {
  const src = readFileSync(path.join(root, file), "utf8");
  const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const node of ast.statements) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === name)) return node.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.getText(ast) === name) return node.getText(ast);
  }
  if (optional) return "";
  throw new Error("Missing product function " + file + ":" + name);
};
const setup = `
class Node {
 constructor(tag='div'){this.tagName=tag;this.dataset={};this.children=[];this.parentNode=null;this.style={};this.textContent='';this.className='';this.classList={contains:c=>this.className.split(' ').includes(c),add:c=>{if(!this.classList.contains(c))this.className+=' '+c},remove:c=>{this.className=this.className.split(' ').filter(x=>x!==c).join(' ')},toggle:()=>{}};}
 appendChild(n){if(n.parentNode)n.parentNode.removeChild(n);this.children.push(n);n.parentNode=this;return n;}
 removeChild(n){this.children.splice(this.children.indexOf(n),1);n.parentNode=null;return n;}
 get firstChild(){return this.children[0]||null;} get parentElement(){return this.parentNode;}
 querySelector(q){for(const c of this.children){if(q==='[data-ts]' && c.dataset.ts)return c;if(q.startsWith('.')&&c.classList.contains(q.slice(1)))return c;const n=c.querySelector(q);if(n)return n;}return null;}
 remove(){if(this.parentNode)this.parentNode.removeChild(this);} addEventListener(){}
}
const document={createElement:t=>new Node(t),getElementById:()=>null};
let now=0; const Date={now:()=>now};
const vtItems=[],vtIndex=new Map(),cardByThread=new Map(),pendingQueued=[],renderedMsgKeys=new Set();
const vtObserver={observe:()=>{}};let vtReorderAnchor=null;const pageScroll=()=>false,pinsBottom=()=>true;let vtJumpTop=false;const getClientH=()=>800;
const vtRecomputeDividers=()=>{},vtCap=()=>{},scheduleRelayout=()=>{},applyFilter=()=>{},refreshChatEmpty=()=>{},scrollChatToNewest=()=>{};
const assistantName='assistant',i18n=x=>x,makeCardCaret=()=>new Node('span');
const buildChannelBadge=()=>null,renderModelLabel=()=>{},isInternalText=()=>false,isInternalMessage=()=>false,isRecordOnlyMessage=()=>false,setTurnModel=()=>{},setTurnCost=()=>{},renderKindIcon=()=>'';
const setChatBody=(el,text)=>{el.textContent=text};
const buildReplyRef=()=>null,buildAttachmentsPreview=()=>new Node();
const ADAPTERS=['codex'],isEndpointThread=()=>false,metaEffort=()=>'',renderedActivityKeys=new Set(),actKey=(ts,t,s)=>ts+'|'+t+'|'+s;
const stepKey=(thread,seq)=>thread+'|'+seq,activityByStep=new Map(),deltaSeenByStep=new Map();
const isActiveThread=tk=>!tk||tk===activeThreadKey,cancelErrClear=()=>{},markTurnActive=()=>{},forgetPromptCardReopener=()=>{},msgKey=(ts,role)=>ts+'|'+role;
const currentView='chat',activeThreadKey='room';let localChatCount=0;
function buildHistoryDiv(e){const n=new Node();n.className='ev local channel-chat';n.dataset.ts=String(e.ts);const h=new Node();const stamp=new Node();stamp.className='ts';stamp.textContent=String(e.ts);h.appendChild(stamp);n.appendChild(h);const b=new Node();b.className='chat-message';b.textContent=e.text;n.appendChild(b);return n;}

let fetch=async()=>{throw Error("Unexpected fixture fetch")};
let cidCounter=0;const self={crypto:{randomUUID:()=>"send-"+(++cidCounter)}};
const activeTurns=new Set(["room"]),recordTypedTags=()=>{},setChatWorking=()=>{},renderLocalChat=()=>{},reopenPromptCard=()=>{};
let firstEvent=false,evCount=0;const evCountEl=new Node(),fmtTime=x=>String(x),handleActivityLiveEvent=()=>{},markTurnDone=()=>{},holdSseEventDuringHistory=()=>false,bumpUnread=()=>{};
const handleWorkerActivity=()=>false,setTurnPhase=()=>{};
const window={},agentOfThread=()=>null,kindIcon=()=>'',buildActivityLine=()=>new Node(),annotateToolDuration=()=>{},sessionNameFor=()=>'';
const reset=()=>{vtItems.length=0;vtIndex.clear();cardByThread.clear();pendingQueued.length=0;renderedMsgKeys.clear();renderedActivityKeys.clear();};
const send=(type,ts,payload)=>renderEvent({type,ts,payload:{threadKey:activeThreadKey,adapter:'codex',...payload}});
const texts=()=>vtItems.flatMap(it=>{const body=it.node.querySelector('.chat-message');return body?[body.textContent]:[]});
`;

export const check: RegressionCheck = {
  name: "chat-optimistic-order", guards: "연속 입력·늦은 에코·첫 영속 그룹 좌표의 live/history 순서",
  run: async () => {
    assertIsolated();
    const out: Assertion[] = [];
    const ctx = vm.createContext({ console: { debug() {}, warn() {} }, setTimeout() {} });
    vm.runInContext(setup, ctx);
    const funcs: Record<string, string[]> = {
      "virtualization.js": ["vtTsOf", "vtNewestTs", "vtIsStaleForAppend", "vtMakeItem", "vtAppend", "vtReposition", "confirmTurnGroupTs", "createTurnCard", "createDeltaGroup", "ensureReplyBubble"],
      "token-delta.js": ["renderDelta", "renderActivity", "interruptOpenTurn", "completeTurnGroup"],
      "axis1-options.js": ["queueOptimisticBubble", "foldQueuedEntry", "foldRejectedQueuedBubble", "cancelQueuedBubble"],
      "reply.js": ["sendChatMessage", "messageReachedServer"],
      "util.js": ["sendRejectionAction", "arrivalOutcome"],
      "channel-hints.js": ["renderChannelMessage"],
      "sse.js": ["renderEvent"],
      "background-drawer.js": ["skillStepInfo"],
      "history-render.js": ["canonicalBodyFor", "groupMergedItems"],
    };
    for (const [file, names] of Object.entries(funcs)) for (const name of names) vm.runInContext(extract(file, name, ["vtReposition", "confirmTurnGroupTs"].includes(name)), ctx);
    const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
    const eq = (name: string, code: string, expected: unknown): void => {
      const actual = run<unknown>("{\n" + code + "\n}");
      out.push(assert(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected }));
    };
    run(`const VT_STALE_TOLERANCE_MS=5000;`);
    eq("원 실패: 느린 시계 연속 입력과 서버 에코 후 live/history 순서가 같다", `
      send('llm.delta',41000,{delta:'partial'});
      now=29000;queueOptimisticBubble('U1',{cid:'c1',queued:true});
      send('channel.message.in',47000,{text:'U1',correlationId:'c1'});
      send('llm.activity',48000,{kind:'text',seq:1,text:'answer',ts:48000});
      completeTurnGroup('room');
      now=37000;queueOptimisticBubble('U2',{cid:'c2',queued:true});
      send('channel.message.in',55000,{text:'U2',correlationId:'c2'});texts();`, ["U1", "answer", "U2"]);
    eq("첫 delta의 서버 원시각이 임시 그룹에 전달된다", `reset();send('llm.delta',41000,{delta:'part'});vtTsOf(cardByThread.get('room').group);`, 41000);
    eq("낙관 입력은 시계와 무관하게 tail이며 서버 echo 전에는 기존 진행 경계를 보존한다", `
      now=-90000;queueOptimisticBubble('slow',{cid:'slow'});
      const wasClosed=cardByThread.get('room').closed;
      now=999999;queueOptimisticBubble('fast',{cid:'fast'});
      [texts(),wasClosed];`, [["part", "slow", "fast"], false]);
    eq("다중 pending 첫 에코는 뒤 pending 앞에 남고 노드·측정 item을 보존한다", `
      const old=pendingQueued[0].el,item=vtIndex.get(old);item.h=123;item.measured=true;
      send('channel.message.in',42000,{text:'slow',correlationId:'slow'});
      [texts(),vtIndex.get(old)===item,item.h,item.measured,pendingQueued.length];`, [["slow", "fast"], true, 123, true, 1]);
    eq("늦은 에코는 입력 이후 시작한 진행 답을 재차 끊지 않는다", `
      reset();now=900000;queueOptimisticBubble('U1',{cid:'u'});
      send('llm.delta',48000,{delta:'keep'});const current=cardByThread.get('room');
      send('channel.message.in',47000,{text:'U1',correlationId:'u'});
      [texts(),current.closed,!!current.replyBubble];`, [["U1", "keep"], false, true]);
    eq("반례: 입력 전 추가 delta→echo→영속 text는 입력 아래 새 그룹으로 확정된다", `
      reset();now=1;queueOptimisticBubble('U1',{cid:'u'});
      send('llm.delta',43000,{delta:'old partial'});
      send('channel.message.in',47000,{text:'U1',correlationId:'u'});
      send('llm.activity',48000,{kind:'text',seq:1,text:'answer',ts:48000});texts();`, ["U1", "answer"]);
    eq("첫 delta 고정 반례: text 확정·완료 뒤 에코도 첫 영속 좌표 기준을 따른다", `
      reset();now=1;queueOptimisticBubble('U1',{cid:'u'});
      send('llm.delta',43000,{delta:'part'});
      send('llm.activity',48000,{kind:'text',seq:1,text:'answer',ts:48000});
      completeTurnGroup('room');send('channel.message.in',47000,{text:'U1',correlationId:'u'});
      [texts(),vtTsOf(cardByThread.get('room').group)];`, [["U1", "answer"], 48000]);
    eq("첫 영속 키는 후속 세그먼트·답글 행 좌표로 바뀌지 않는다", `
      const group=cardByThread.get('room').group;
      cardByThread.get('room').closed=false;
      send('llm.activity',49000,{kind:'text',seq:2,text:'more',ts:49000});
      send('channel.message.out',50000,{text:'answer\\nmore',turn:{id:'done-turn'}});
      const card=cardByThread.get('room');
      [vtTsOf(group),card.lastTextBubble.dataset.ts,card.lastTextBubble.dataset.rowts,card.lastTextBubble.dataset.seg,card.lastTextBubble.dataset.turn];`, [48000, "49000", "50000", "1", "done-turn"]);
    eq("세그먼트 없는 최종 out도 같은 1회 권위 승격을 한다", `
      reset();now=1;queueOptimisticBubble('U1',{cid:'u'});
      send('llm.delta',43000,{delta:'part'});
      send('channel.message.out',48000,{text:'answer',turn:{id:'out-turn'}});
      send('channel.message.in',47000,{text:'U1',correlationId:'u'});
      const c=cardByThread.get('room');[texts(),vtTsOf(c.group),c.group.querySelector('.channel-chat').dataset.ts];`, [["U1", "answer"],48000,"48000"]);
    eq("타 대화 늦은 out/delta/echo는 현재 대화의 본문·진행 카드를 바꾸지 않는다", `
      const before=JSON.stringify(texts());
      send('llm.delta',51000,{delta:'other',threadKey:'other'});
      send('channel.message.out',52000,{text:'other',threadKey:'other'});
      send('channel.message.in',53000,{text:'other',threadKey:'other',correlationId:'no'});
      JSON.stringify(texts())===before;`, true);
    eq("확정 메시지 replay는 같은 버블을 중복 생성하지 않는다", `
      const before=JSON.stringify(texts());send('channel.message.in',47000,{text:'U1',correlationId:'u'});JSON.stringify(texts())===before;`, true);
    eq("이력 재구성은 사용자→영속 텍스트→사용자 순서를 보존한다", `
      groupMergedItems([{ts:47000,role:'user',text:'U1',threadKey:'room'},{ts:48747,role:'assistant',text:'answer',threadKey:'room'},{ts:55000,role:'user',text:'U2',threadKey:'room'}],[{ts:48000,kind:'text',seq:1,text:'answer',threadKey:'room'}]).map(u=>u.kind==='text'?u.act.text:u.kind==='msg'?u.entry.text:'tool');`, ["U1","answer","U2"]);
    eq("입력 전 도구·delta→에코→새 텍스트는 도구를 보존하고 입력 아래 답한다", `
      reset();now=1;queueOptimisticBubble('U1',{cid:'u'});
      send('llm.activity',43000,{kind:'tool',seq:1,label:'Read'});
      const tool=cardByThread.get('room'),toolItem=vtIndex.get(tool.group);
      send('llm.delta',44000,{delta:'old partial'});
      send('channel.message.in',47000,{text:'U1',correlationId:'u'});
      send('llm.activity',48000,{kind:'text',seq:2,text:'answer',ts:48000});
      [texts(),vtIndex.get(tool.group)===toolItem,vtTsOf(tool.group),tool.closed];`, [["U1","answer"],true,43000,true]);
    eq("늦은 에코 경계는 나중 텍스트를 기다리지 않고 입력 전 임시 답을 즉시 제거한다", `
      reset();now=1;queueOptimisticBubble('U1',{cid:'u'});
      send('llm.delta',43000,{delta:'old partial'});
      send('channel.message.in',47000,{text:'U1',correlationId:'u'});texts();`, ["U1"]);
    eq("도구 그룹의 첫 영속 활동 키는 나중 텍스트 시각으로 승격되지 않는다", `
      reset();send('llm.activity',43000,{kind:'tool',seq:1,label:'Read'});
      send('llm.activity',44000,{kind:'text',seq:2,text:'answer',ts:44000});vtTsOf(cardByThread.get('room').group);`,43000);
    eq("에코 전에도 느린 로컬 시계의 두 번째 입력은 기존 확정 질문 뒤에 보인다", `
      reset();send('channel.message.in',47000,{text:'U1'});
      now=29000;queueOptimisticBubble('U2',{cid:'u2'});texts();`, ["U1","U2"]);
    eq("확정 final→낙관 입력→out은 확정 답을 한 번만 남긴다", `
      reset();send('llm.activity',100,{kind:'text',seq:1,text:'Final'});
      queueOptimisticBubble('next',{cid:'next',queued:true});
      send('channel.message.out',110,{text:'Final',turn:{id:'final-turn'}});
      [texts(),cardByThread.get('room').lastTextBubble.dataset.turn];`, [["Final","next"],"final-turn"]);
    eq("text→tool→steering echo→후속 text는 입력 아래 새 답이며 기존 텍스트도 보존한다", `
      reset();send('llm.activity',100,{kind:'text',seq:1,text:'before'});
      send('llm.activity',110,{kind:'tool',seq:2,label:'Read'});
      const old=cardByThread.get('room');queueOptimisticBubble('steer',{cid:'steer',queued:true});
      send('channel.message.in',120,{text:'steer',correlationId:'steer'});
      send('llm.activity',130,{kind:'text',seq:3,text:'after'});
      send('channel.message.out',140,{text:'before\\nafter'});
      [texts(),old.interrupted];`, [["before","steer","after"],true]);
    eq("다른 queueKey echo는 표시 탭의 진행 답을 끊지 않고 CID 버블만 승격한다", `
      reset();send('llm.delta',100,{delta:'keep'});const old=cardByThread.get('room');
      queueOptimisticBubble('hidden',{cid:'hidden',queueKey:'worker:hidden',queued:true});
      send('channel.message.in',110,{text:'hidden',correlationId:'hidden',threadKey:'worker:hidden'});
      [texts(),old.closed,pendingQueued.length];`, [["keep","hidden"],false,0]);
    eq("동일 텍스트 연속 입력은 역순 echo도 정확 CID 노드와 대기 배지를 보존한다", `
      reset();queueOptimisticBubble('same',{cid:'a',queued:true});queueOptimisticBubble('same',{cid:'b',queued:true});
      const a=pendingQueued[0].el,b=pendingQueued[1].el;
      send('channel.message.in',120,{text:'same',correlationId:'b'});
      const intermediate=[pendingQueued.map(p=>p.cid),a.classList.contains('queued'),b.classList.contains('queued')];
      send('channel.message.in',110,{text:'same',correlationId:'a'});
      [intermediate,a.dataset.ts,b.dataset.ts,pendingQueued.length,vtItems.indexOf(vtIndex.get(a))<vtItems.indexOf(vtIndex.get(b))];`, [[["a"],true,false],"110","120",0,true]);
    for (const mode of ["cancelled", "already-started", "http-failure", "network-failure"]) {
      const actual = await run<Promise<unknown>>(`(async()=>{
        reset();send('llm.delta',100,{delta:'partial'});const old=cardByThread.get('room');
        queueOptimisticBubble('queued',{cid:'cancel',queued:true,queueKey:'worker:queue'});
        const entry=pendingQueued[0],button=entry.el.querySelector('.queued-cancel');let posted;
        fetch=async(url,opts)=>{posted=JSON.parse(opts.body);if(${JSON.stringify(mode)}==='network-failure')throw Error('offline');
          return {ok:${mode !== "http-failure"},json:async()=>({result:${JSON.stringify(mode)}})};};
        await cancelQueuedBubble(entry,button);
        const boundaryIntact=!old.closed && !!old.replyBubble;
        send('channel.message.out',110,{text:'Final'});
        return [boundaryIntact,texts(),pendingQueued.length,posted.threadKey,entry.el.classList.contains('cancelled-turn')];
      })()`);
      const expected=[true,["Final","queued"],mode === "cancelled" ? 0 : 1,"worker:queue",mode === "cancelled"];
      out.push(assert("큐 취소 "+mode+"는 기존 턴 경계를 남기지 않는다",JSON.stringify(actual)===JSON.stringify(expected),{actual,expected}));
    }
    for (const mode of ["closed", "rejected", "network-failure", "server-failure"]) {
      const actual = await run<Promise<unknown>>(`(async()=>{
        reset();send('llm.delta',100,{delta:'partial'});const old=cardByThread.get('room');
        fetch=async(url)=>{if(url.startsWith('/api/chat-history'))return {ok:true,json:async()=>({entries:[]})};
          if(${JSON.stringify(mode)}==='network-failure')throw Error('offline');
          return {ok:false,status:${mode === "server-failure" ? 502 : 400},json:async()=>(${mode === "closed" ? "{code:'prompt-closed'}" : "{}"})};};
        const result=await sendChatMessage('failed');const boundaryIntact=!old.closed && !!old.replyBubble;
        send('channel.message.out',110,{text:'Final'});
        return [boundaryIntact,texts(),!!result.closed,!!result.restore];
      })()`);
      const expected=[true,["Final","failed"],mode === "closed",mode !== "closed"];
      out.push(assert("실제 sendChatMessage "+mode+"는 기존 답의 경계를 끊지 않는다",JSON.stringify(actual)===JSON.stringify(expected),{actual,expected}));
    }
    return out;
  },
};
