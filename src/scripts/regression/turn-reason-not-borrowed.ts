/**
 * 회귀: **내가 친 턴이 남의 사유로 이름이 바뀌지 않는다** (2026-08-25 사용자 신고).
 *
 * 사용자: *"메인비서가 나랑 대화중이었는데 매니저에이전트 결과 정리중이 뜨는건 좀 그러네 /
 * 애매하면 그냥 정리중이 어때?"*
 *
 * ★기제: 진행 표시의 사유(`turnReason`)는 **턴이 왜 시작됐는지**를 말한다(2026-08-13).
 *  그런데 `markTurnActive` 가 **이미 도는 턴에도** 나중 사유를 덮어썼다. 그래서
 *  사용자가 말을 걸어 시작된 턴이 진행 중에 매니저 완료 재주입을 받으면, 입력창 바로 위
 *  줄이 그 순간 "매니저·에이전트 결과 정리" 로 바뀌었다 — 내가 시킨 일이 남의 이름을 달았다.
 *
 * 고침: 원인이 둘 이상 섞이면 **자세히 말하지 않고 뭉뚱그린다**("정리 중"). 지우지는 않는다
 * — 뭔가 정리 중인 건 사실이고 그건 알려주는 게 낫다.
 *
 * ★등급: **행동 게이트** — `markTurnActive` 를 떼어 vm 에서 실제로 돌린다. 기존
 *  `working-elapsed-own-session` 은 `turnReason` 을 직접 세워서 **이 경로를 안 지난다**
 *  (그래서 이 결함이 그물 안에서 살아 있었다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const SRC = path.join(REPO, "packages/dashboard/js/axis1-options.js");

interface Harness {
  active: (tk: string, opts?: Record<string, unknown>) => void;
  reasonOf: (tk: string) => string | undefined;
  done: (tk: string) => void;
}

/** `markTurnActive`·`markTurnDone` 과 그들이 쓰는 지도를 떼어 실제로 돌린다. */
const load = (): Harness => {
  const src = readFileSync(SRC, "utf8");
  const from = src.indexOf("      const restoredAt = new Map();");
  const to = src.indexOf("      const markTurnDone =");
  if (from < 0 || to < 0) throw new Error("markTurnActive 블록을 못 찾음 — 구조가 바뀌었나");
  const end = src.indexOf("\n", to);
  const block = src.slice(from, end);
  const ctx: Record<string, unknown> = {
    activeTurns: new Map<string, number | null>(),
    turnPhase: new Map<string, unknown>(),
    activeThreadKey: "dashboard:default",
    refreshWorking: () => {},
    // 화면 문구 — 브라우저 전역이라 여기선 원문을 그대로 돌려준다.
    i18n: (v: string) => v,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${block}\nthis.__active = markTurnActive;\nthis.__reason = (k) => turnReason.get(k);\n` +
      `this.__done = (k) => { activeTurns.delete(k); turnReason.delete(k); };`,
    ctx,
  );
  return {
    active: ctx.__active as Harness["active"],
    reasonOf: ctx.__reason as Harness["reasonOf"],
    done: ctx.__done as Harness["done"],
  };
};

const REINJECT = "매니저·에이전트 결과 정리";
const TK = "dashboard:default";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const h = load();

  // ① 재주입이 **턴을 시작**했으면 그 사유를 그대로 말한다(2026-08-13 이 붙인 값).
  h.active(TK, { reason: REINJECT });
  const started = h.reasonOf(TK);
  out.push(
    assert(
      "재주입이 턴을 시작하면 그 사유를 말한다(왜 도는지 알 수 있어야 한다)",
      started === REINJECT,
      String(started),
    ),
  );
  h.done(TK);

  // ② ★사용자가 시작한 턴이 **도는 중에** 재주입을 받으면 — 뭉뚱그린다.
  h.active(TK); // 사용자가 말을 걸었다 — 사유 없음
  const mine = h.reasonOf(TK);
  h.active(TK, { reason: REINJECT }); // 그 사이 매니저가 끝났다
  const after = h.reasonOf(TK);
  out.push(
    assert(
      "내가 친 턴엔 사유가 없다(자기가 뭘 시켰는지 아는 사람에겐 군더더기다)",
      mine === undefined,
      String(mine),
    ),
    assert(
      "★도는 중에 온 사유가 내 턴 이름을 덮지 않는다 — 애매하면 뭉뚱그린다",
      after !== REINJECT,
      String(after),
    ),
    assert(
      "그래도 뭔가 정리 중인 건 알려준다(지우면 사용자가 아무것도 모른다)",
      after === "정리 중",
      String(after),
    ),
  );
  h.done(TK);

  // ③ 사유 없는 활성화는 옛 사유를 지운다(다음 턴에 눌러붙지 않게 — 종전 규칙 유지).
  h.active(TK, { reason: REINJECT });
  h.done(TK);
  h.active(TK);
  const cleared = h.reasonOf(TK);
  out.push(
    assert(
      "턴이 끝나고 새로 시작하면 옛 사유가 안 눌러붙는다",
      cleared === undefined,
      String(cleared),
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "turn-reason-not-borrowed",
  guards:
    "내가 친 턴이 진행 중에 매니저·에이전트 완료 재주입을 받으면 입력창 위 줄이 남의 사유로 이름이 바뀌던 것",
  run,
};
export default check;
