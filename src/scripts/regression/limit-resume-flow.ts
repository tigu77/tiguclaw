/**
 * 회귀: **한도 자동 이어가기 흐름** (2026-10-23 — 설계 docs/decisions/2026-10-22-limit-auto-resume-design.md §3·§7 R1·R3·R3′ⓐ·R5·R6·R7·R8·보존).
 *
 * 사용자: *«옵션이 걸려 있으면 한도가 풀리는 시간이 지나면 이어 간다고 알려 주고»* · *«살짝 여유를 줘도 좋겠어»* · 결정 «권고대로»(꺼짐·상한 3·여유 2분·
 *  섞이면 늦은 쪽에 한 번·`/stop` 이 예약도 지움). 지키는 것:
 *  R1 꺼짐(기본·명시) → 행 0 · 메인·작업 문구 **바이트 동일** · R7 켬 → 같은 한 메시지에 «{when} 이어서 · `/schedule delete id`»(when = 해제 + 2분) ·
 *  작업 문구에 «그 뒤 다시 시켜주세요»·«알려주시면» 없음 · 합류 결과도 같은 칸 · en·ko
 *  R3 세션당 타이머 하나 · 항목 합침 · 시각은 늦은 쪽 · 다른 세션은 따로 · R5 울림 → 그 세션에 합성 턴 1 · 글에 항목(작업 label·jobId·프로파일,
 *  메인 원문, 부분 실행 사유) · 하위·취소 작업은 항목 아님 · R3′ⓐ 차례 직전 합쳐지면 옛 차례로 안 돌고 새 시각에 합친 목록으로 한 번
 *  R6 재개 턴 자신이 한도 → 같은 행 제자리 · 실행기 정산 0(last_status·scheduler.error) · 3번 뒤 capped + 행 삭제 · 사람 메시지면 다시 ·
 *  보존: 재시작으로 끊긴 «넘겨받음» 을 부팅이 풀어 항목이 안 사라짐 · `/stop` 은 대기 중 예약만 지우고 다른 대화 것은 그대로 ·
 *  사람의 대화 아님·보관한 대화·스케줄러 없음·속성 없는 한도 문구 → 걸지 않음
 *  배선(소스 대조 — `src/index.ts` 핸들러 클로저는 import 로 못 뽑는다): 줄의 claim 자리 · 실패 출구의 한 글(인입·egress 같은 글) · `/stop` 네 갈래 ·
 *  사람 메시지의 횟수 초기화 · 부팅 · 합류 결과의 꼬리.
 *
 * 등급: **동작**(자식 `_limit-resume-flow-child.ts` — 진짜 재개 모듈·작업 레지스트리·스케줄러 플러그인·실행기·저장소) + 배선.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceSync } from "./_wiring.js";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_limit-resume-flow-child.ts");
type J = Record<string, Record<string, unknown>>;

const between = (s: string, a: string, b: string): string => {
  const i = s.indexOf(a);
  if (i < 0) return "";
  const j = s.indexOf(b, i + a.length);
  return j < 0 ? "" : s.slice(i, j);
};

export const check: RegressionCheck = {
  name: "limit-resume-flow",
  guards:
    "구독 한도로 멈춘 메인 답·백그라운드 작업이 풀린 뒤에도 사람이 다시 시켜야 했던 것 — 옵션으로 풀린 뒤 그 대화에서 이어 간다(세션당 하나·상한·취소 길)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const r = await spawnWithin(120_000, "limit-resume-flow", ["--import", "tsx", CHILD], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (r.timedOut || line === undefined) return [assert("자식이 결과를 낸다", false, r.timedOut ? "timeout" : r.err.slice(-400))];
    const d = JSON.parse(line) as J;
    const show = (k: string): string => JSON.stringify(d[k]).slice(0, 300);
    const out: Assertion[] = [
      assert("R1★꺼짐(기본) — 한도 실패에도 행 0·타이머 0 · 작업 통지 문구 **바이트 동일** · 메인 글 그대로", d.off!.note === null && d.off!.rows === 0 && d.off!.schedulesDelta === 0 && d.off!.jobTextSame === true && d.off!.base === true, show("off")),
      assert("R1 명시적 false 도 같다", d.offExplicit!.note === null && d.offExplicit!.rows === 0, show("offExplicit")),
      assert("R7★메인 턴 — 같은 한 메시지에 «{when} 이어서 · /schedule delete id» · when = 해제 + 2분(여유)", d.main!.hasDelete === true && d.main!.oneMessage === true && d.main!.wakeRel === 720, show("main")),
      assert("R3★같은 세션 메인 턴 + 작업 둘 → 타이머 1 · 항목 3 · 시각은 가장 늦은 wakeAt(해제 1200초 + 2분) · 합침은 횟수에 안 셈", d.merge!.timers === 1 && d.merge!.items === 3 && d.merge!.runAtRel === 1320 && d.merge!.arms === 1, show("merge")),
      assert("R7★작업 통지 — «멈췄습니다» 꼴 · 같은 메시지에 취소 길 · «그 뒤 다시 시켜주세요»·«알려주시면» 없음", d.merge!.jobIsLimitResumeForm === true && d.merge!.jobHasDelete === true && d.merge!.jobNoRetryAsk === true, show("merge")),
      assert("R3 다른 세션은 따로 한 행", d.otherSession!.timersS2 === 1 && d.otherSession!.timersS === 1, show("otherSession")),
      assert("R7 합류가 선점한 실패 — raw 통지 0 · 합류 결과가 같은 칸의 한 줄을 읽는다 · 항목엔 들어간다", d.join!.rawSent === "" && String(d.join!.line).includes("/schedule delete") && d.join!.items === 4, show("join")),
      assert("R5 하위 작업(소환자 = 매니저)·취소된 작업은 항목이 아니다", d.notItems!.items === 4 && d.notItems!.childNote === null && d.notItems!.cancelledNote === null, show("notItems")),
      assert("R5★울림 → 그 세션에 합성 턴 1 · 글에 작업 label·jobId·프로파일 · 메인 원문 · 부분 실행 사유 · 하위·취소 없음 · 끝나면 지움", d.wake!.turns === 1 && d.wake!.hasJobB === true && d.wake!.hasMain === true && d.wake!.hasPartial === true && d.wake!.noChild === true && d.wake!.noCancelled === true && d.wake!.rowGone === true, show("wake")),
      assert("R3′ⓐ★차례 직전 더 늦은 해제가 합쳐지면 옛 차례로 안 돈다 · 새 시각에 합친 목록(둘 다)으로 정확히 한 번", d.queuedMerge!.ranEarly === 0 && d.queuedMerge!.mergedAhead === true && d.queuedMerge!.finalTurns === 1 && d.queuedMerge!.both === true && d.queuedMerge!.gone === true, show("queuedMerge")),
      assert("R6★재개 턴 자신이 한도 → 같은 행 제자리(켜짐·새 시각) · 실행기 정산 0(last_status 그대로) · 횟수 1→2→3 · 목록은 그대로(재개 턴 자신은 항목이 아니다)", d.cap!.sameRow === true && JSON.stringify(d.cap!.arms) === "[2,3]" && JSON.stringify(d.cap!.lastStatus) === "[null,null]" && d.cap!.itemsKept === true, show("cap")),
      assert("R6★세 번째 재개 턴도 한도 → 걸지 않고 같은 메시지에 capped 줄 · 행 삭제 · «타이머 실패» 이벤트 0(자가 진단이 한 통 더 안 보낸다)", d.cap!.cappedLine === true && d.cap!.rowGone === true && d.cap!.schedulerErrors === 0, show("cap")),
      assert("R6 사람 메시지 → 다시 건다(횟수 처음부터)", d.capReset!.kind === "armed" && d.capReset!.arms === 1, show("capReset")),
      assert("보존★재개 턴 도중 재시작 → 부팅이 «넘겨받음» 을 풀어 다음 실패가 앞 항목을 지우지 않는다(같은 행에 합침)", JSON.stringify(d.restart!.items) === JSON.stringify(["재시작 전 항목", "재시작뒤작업"]) && d.restart!.sameRow === true, show("restart")),
      assert("보존★`/stop` 은 대기 중 예약을 지우고 시각을 알린다 · 두 번째는 없음 · 다른 대화 예약은 그대로", d.stop!.cancelled === true && d.stop!.again === null && d.stop!.rowGone === true && d.stop!.s2Kept === true, show("stop")),
      assert("★재개 턴이 도는 사이 다른 실패가 같은 행을 다시 걸고 그 턴도 한도 → 맡았던 목록이 대기로 돌아온다(B·A 둘 다) · 시각은 늦은 쪽(B) · 횟수는 한 번만 · 넘겨받음 해제",
        JSON.stringify(d.overlap!.items) === JSON.stringify(["B작업", "A항목"]) && d.overlap!.claimed === false && d.overlap!.claimedItems === 0 &&
          d.overlap!.midArms === 2 && d.overlap!.arms === 2 && d.overlap!.sameRow === true && Number(d.overlap!.runAtRel) >= 21 && d.overlap!.enabled === true,
        show("overlap")),
      assert("★재개 턴 A 가 도는 사이 B 가 다시 걸고 A 는 **성공** → A 가 맡은 세대를 내려놓아 재시작해도 대기엔 B 만 · 글에도 A 없음 · 예약은 남는다",
        JSON.stringify((d.successRelease!.afterRun as Record<string, unknown>).items) === JSON.stringify(["남을B"]) && (d.successRelease!.afterRun as Record<string, unknown>).claimed === false &&
          (d.successRelease!.afterRun as Record<string, unknown>).claimedItems === 0 && JSON.stringify(d.successRelease!.afterBoot) === JSON.stringify(["남을B"]) &&
          d.successRelease!.prompt === false && d.successRelease!.rowKept === true,
        show("successRelease")),
      assert("★상한에 닿은 재개 턴이 끝나 내려놓은 직후·정산 전의 다른 실패도 상한을 지킨다 — capped · 예약 0 · 끝난 행은 실행기가 지운다 · 그 순간 /stop 은 취소를 말하지 않는다",
        JSON.stringify(d.releaseCap!.late) === JSON.stringify({ kind: "capped", arms: 3 }) && d.releaseCap!.rowGone === true && d.releaseCap!.timers === 0 &&
          d.releaseCap!.stopAfterRelease === null, // 그 순간의 /stop 은 «취소했습니다» 를 말하지 않는다(대기 세대가 없다)
        show("releaseCap")),
      assert("★상한 미만의 재개 턴이 끝나 내려놓은 직후·정산 전의 실패 → 같은 행 제자리 다시 걸기(+1) · 대기엔 B 만 · 정산 뒤에도 예약 하나 · 울리면 B 를 이어 간다(A 없음)",
        d.releaseRearm!.sameId === true && JSON.stringify(d.releaseRearm!.mid) === JSON.stringify({ arms: 2, items: ["정산전B2"], claimed: false }) &&
          JSON.stringify((d.releaseRearm!.afterSettle as Record<string, unknown>).timers) === JSON.stringify([ (d.releaseRearm!.late as { scheduleId?: number }).scheduleId ]) &&
          JSON.stringify((d.releaseRearm!.afterSettle as Record<string, unknown>).row) === JSON.stringify({ enabled: true, lastStatus: null }) &&
          d.releaseRearm!.nextHasB === true && d.releaseRearm!.nextNoA === true && d.releaseRearm!.gone === true,
        show("releaseRearm")),
      assert("★옮긴 재개 타이머(`move_here`)는 옛 대화가 다시 걸거나 지우지 않는다 — 옛 대화의 새 실패는 새 행 · `/stop` 은 그 새 행만",
        d.moved!.stopBeforeNew === null && d.moved!.newRow === true && d.moved!.movedPromptSame === true && d.moved!.movedKeptOrigin === true && JSON.stringify(d.moved!.sItems) === JSON.stringify(["옮긴뒤작업"]) &&
          d.moved!.cancelHitFresh === true && d.moved!.movedAlive === true,
        show("moved")),
      assert("★매니저의 거두기 턴이 한도로 실패해도 재개 시각이 이어진다 — 걸리고 매니저가 항목이 된다", d.harvest!.status === "failed" && Number(d.harvest!.turns) >= 2 && d.harvest!.note === "armed" && d.harvest!.item === true, show("harvest")),
      assert("하지 않는 경우 — 사람의 대화 아님 · 보관한 대화 · 스케줄러 없음 · 런타임 표식 없는 한도 문구", d.skips!.notHuman === null && d.skips!.archived === null && d.skips!.noScheduler === null && d.skips!.notLimit === null && d.skips!.s2Timers === 1, show("skips")),
      assert("en 문구도 취소 길·횟수를 싣는다", String(d.en!.at).includes("/schedule delete 42") && String(d.en!.capped).includes("3 times"), show("en")),
    ];

    // ── 배선 — `src/index.ts` 핸들러 클로저 ───────────────────────────────────
    const idx = readSourceSync("src/index.ts");
    const queue = between(idx, "const skip = msg.beforeTurn?.() ?? null;", "return handler(msg);");
    const claimAfterSkip = queue.indexOf("if (skip !== null)") >= 0 && queue.indexOf("claimLimitResume(run.id, run.session)") > queue.indexOf("if (skip !== null)") &&
      /return handler\(msg\)\.finally\(\(\) => releaseLimitResume\(run\.id, run\.session\)\)/.test(queue);
    const catchBody = between(idx, "  } catch (e) {\n    // 사용자 /stop 으로 중단된 턴", "  } finally {\n    // 활동 표시 해제");
    const exitOrder =
      catchBody.indexOf("stoppedByUser(turnAc.signal)") >= 0 &&
      catchBody.indexOf('e.name === "WorkerCancelledError"') > catchBody.indexOf("stoppedByUser(turnAc.signal)") &&
      catchBody.indexOf("noteTurnLimitStop(e, msg)") > catchBody.indexOf('e.name === "WorkerCancelledError"');
    const oneText = /await replyCommand\(msg, failText, \{ turnFailed: true \}\)/.test(catchBody) && /await fanOutEgress\(egressTargets, failText, bus, msg\.threadKey, original\)/.test(catchBody);
    const onlyInCatch = idx.split("noteTurnLimitStop(").length - 1 === 1 && catchBody.includes("noteTurnLimitStop(e, msg)"); // 호출은 실패 출구 한 번뿐
    const stopBlock = between(idx, 'if (msg.text.trim() === "/stop") {', 'if (msg.text.trim() === "/update") {');
    const stopBranches = stopBlock.split("withCancel(").length - 1;
    const armsReset = /const queueHandler: MessageHandler = \(msg\) => \{\n[^\n]*\n\s*if \(msg\.synthetic !== true\) resetLimitResumeArms\(turnSessionOf\(msg\)\);/.test(idx);
    const boot = idx.indexOf("resetLimitResumeClaims();") > idx.indexOf("initStore();") && idx.indexOf("resetLimitResumeClaims();") < idx.indexOf("await wirePlugin(lp,") && /setLimitResumeRuntime\(\{ schedulerLive: /.test(idx);
    const reg = readSourceSync("src/core/llm-runtime/capabilities/agent-registry.ts");
    // 2026-10-31 — 실패 머리에 «(마무리 단계)» 표지가 낄 수 있다(완료 보고 복구 §4-1). 꼬리는 같은 칸 그대로.
    const joinTail = /🔴 실패\$\{[^`]*\} — \$\{job\.error \?\? "\(원인 미상\)"\}\$\{jobLimitResumeLine\(job\)\}/.test(reg);
    const wj = readSourceSync("src/core/worker-jobs.ts");
    const jobExit = between(wj, "      redactSecrets(outcome.error),", "  const found = jobs.get(jobId);").includes("noteJobLimitStop(jobId, outcome);");
    out.push(
      assert("[배선] 재개 턴 «넘겨받음» 은 줄에서 `beforeTurn` 통과 **직후** · 핸들러 직전", claimAfterSkip, queue.slice(0, 200)),
      assert("[배선] 실패 출구 — 사용자 중지·작업 취소를 지난 뒤에만 걸고 · 인입 응답과 egress 가 **같은 글**", exitOrder && oneText, JSON.stringify({ exitOrder, oneText })),
      assert("[배선] R2 메인 턴은 실패 출구 한 곳에서만 부른다(성공 턴엔 안 닿는다)", onlyInCatch, `등장 ${idx.split("noteTurnLimitStop(").length - 1}`),
      assert("[배선] `/stop` 네 갈래(진행 중·외부 턴·시작 중·없음) 모두 예약 취소 줄을 같은 답에", stopBranches === 4, `withCancel 호출 ${stopBranches}`),
      assert("[배선] 사람 메시지(합성 아님)는 줄 입구에서 자동 재개 횟수를 처음부터", armsReset, String(armsReset)),
      assert("[배선] 부팅 — 저장소 뒤·플러그인 앞에서 «넘겨받음» 해제 · 스케줄러 생존 탐지 주입", boot, String(boot)),
      assert("[배선] 작업 실패 출구는 마킹 바로 다음 · 합류 결과가 같은 칸의 꼬리를 읽는다", jobExit && joinTail, JSON.stringify({ jobExit, joinTail })),
    );
    return out;
  },
};
