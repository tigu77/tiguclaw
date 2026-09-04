// src/core/constitution-scope.ts
/**
 * **작동 헌법의 역할 범위** — 어느 절이 어느 칸까지 가나 (2026-09-04).
 *
 * ★**왜 필요한가.** 헌법 일부는 **서브에이전트가 실행할 수단이 없다.** 가장 뚜렷한 예가
 *  「위임과 규모」 절인데, 그건 `spawn_agent`·`run_in_background` 를 전제하고 그 둘은
 *  `REACH` 상 각각 `manager`·`main` 이라 **서브에이전트 턴엔 등록조차 안 된다.** 즉 자식은
 *  *자기가 못 하는 일에 대한 지시*를 매 호출 받는다 — 이건 크기 문제가 아니라 **정확성**
 *  문제다(모델이 없는 도구를 찾다 턴을 버린 실측이 있다).
 *
 * ★**헌법을 두 벌로 만들지 않는다.** 이 레포엔 헌법이 갈려 **정반대 지시를 준** 사고가
 *  있고 그래서 `constitution-single-source` 회귀가 있다. 그러니 «자식용 요약본» 을 따로
 *  쓰는 대신 **원본에 범위를 표시하고 걸러 낸다** — 정본은 계속 하나다.
 *
 * ★**표시는 HTML 주석**이다. 렌더에 안 보이고, 고치는 사람 눈에는 바로 옆에 있고,
 *  파서가 한 줄로 읽는다. 문단 안에 `[메인]` 같은 표를 박으면 **모델이 매 턴 읽는 글**이
 *  지저분해지고 그 바이트를 메인이 낸다.
 *
 * ```markdown
 * <!--role:manager-->
 * ### 위임과 규모
 * ...
 * <!--/role-->
 * ```
 *
 * ★**사다리는 새로 안 만든다** — `capability-reach` 의 `turnReaches` 를 그대로 쓴다.
 *  도구가 «어디까지 닿나» 를 정하는 표와 헌법이 «어디까지 가나» 를 정하는 표가 **따로
 *  있으면 갈린다**(그리고 갈려도 조용하다).
 *
 * ★**기본은 «전부»** 다. 표시가 없는 글은 모든 칸에 간다 — 빠뜨림이 «조용히 사라짐» 이
 *  아니라 «종전대로» 가 되게 하는 쪽으로 틀린다.
 */
import { turnReaches, type Reach, type TurnKind } from "./llm-runtime/capability-reach.js";

/** 여는 표시 `<!--role:main-->` / `<!--role:manager-->` / `<!--role:subagent-->`. */
const OPEN_RE = /^[ \t]*<!--\s*role:(main|manager|subagent)\s*-->[ \t]*$/;
/** 닫는 표시 `<!--/role-->`. */
const CLOSE_RE = /^[ \t]*<!--\s*\/role\s*-->[ \t]*$/;

export interface ConstitutionScopeStats {
  /** 표시된 구간 수. */
  readonly regions: number;
  /** 이 칸에서 걸러진 바이트. */
  readonly droppedBytes: number;
  /** 짝이 안 맞는 표시 — 있으면 **원문을 그대로 쓴다**(아래 참조). */
  readonly malformed: string[];
}

/**
 * 이 칸이 받을 헌법 본문.
 *
 * ★**짝이 안 맞으면 원문을 통째로 돌려준다.** 헌법이 반쪽으로 실리는 것보다 안 자르는 게
 *  낫다 — 여는 표시만 있고 닫는 표시가 없으면 그 뒤 **전부**가 조용히 사라지는데, 그건
 *  «안전선» 이 통째로 빠지는 모양이다. 실패는 크게, 그리고 안전한 쪽으로.
 *
 * @param text 헌법 원문(`SYSTEM.md`).
 * @param turn 이 턴의 칸.
 */
export const scopeConstitution = (
  text: string,
  turn: TurnKind,
): { body: string; stats: ConstitutionScopeStats } => {
  const lines = text.split("\n");
  const kept: string[] = [];
  const malformed: string[] = [];
  let level: Reach | undefined;
  let regions = 0;
  let dropped = 0;
  for (const [i, line] of lines.entries()) {
    const open = OPEN_RE.exec(line);
    if (open !== null) {
      if (level !== undefined) malformed.push(`L${i + 1}: 중첩된 role 표시`);
      level = open[1] as Reach;
      regions += 1;
      continue;
    }
    if (CLOSE_RE.test(line)) {
      if (level === undefined) malformed.push(`L${i + 1}: 짝 없는 닫는 표시`);
      level = undefined;
      continue;
    }
    if (level !== undefined && !turnReaches(turn, level)) {
      dropped += Buffer.byteLength(`${line}\n`, "utf8");
      continue;
    }
    kept.push(line);
  }
  if (level !== undefined) malformed.push("파일 끝: 안 닫힌 role 표시");
  if (malformed.length > 0) {
    return { body: text, stats: { regions, droppedBytes: 0, malformed } };
  }
  // 표시를 걷어내며 생긴 빈 줄 연속은 접는다 — 표시가 없던 때와 같은 모양이 되도록.
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  return { body, stats: { regions, droppedBytes: dropped, malformed } };
};
