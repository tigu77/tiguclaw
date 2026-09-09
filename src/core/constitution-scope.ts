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
 *
 * ★★**역할 구역은 «꼬리»로 낸다** (2026-09-08). 이 파일의 첫 판은 표시된 구역을 **제자리
 *  에서** 걸렀는데, 그러면 역할마다 본문이 **맨 앞에서** 갈린다 — 실측으로 `SYSTEM.md` 의
 *  첫 표시가 468자(3.2%) 지점에 있어서, 메인↔자식 공유 프리픽스가 **94% → 18%** 로
 *  주저앉았다. 하루 전 커밋(`fece6f4b`)이 *"역할 전용 슬롯을 꼬리로"* 로 53%→94% 를
 *  만들어 놨는데, 이 파일이 그 처방을 **머리에서 되돌린** 것이다.
 *
 *  실측 지문(2026-09-08 데몬 로그): codex 14턴 연속 `cached=3,712` 고정 — 요청 앞
 *  ~7,500자에서 끊겼고, 그게 정확히 메인↔자식이 갈리는 7,661자 지점이었다. 같은 창에서
 *  `instructions` 45,165자·`tools` 34,007자는 **바이트 동일**이었으니 우리 payload 변형이
 *  아니라 **배치**가 원인이다.
 *
 *  그래서 본문을 둘로 낸다: **[표시 없는 공용 본문]** + **[이 칸이 닿는 역할 구역]**.
 *  공용 본문은 모든 칸에서 바이트 동일이라 프리픽스가 거기까지 공유된다. 내용은 하나도
 *  안 버린다 — **순서만** 바뀐다.
 *
 * ★**원 위치를 같이 적는다.** 구역 중엔 목록 *안*의 불릿이 있어서(예: 「안전선」의
 *  `register_endpoint` 항목) 통째로 뜯으면 그 틀(*"여기만 묻고 멈춘다"*)을 잃는다.
 *  가장 가까운 앞선 제목을 한 줄로 달아 맥락을 들려 보낸다.
 */
import { turnReaches, type Reach, type TurnKind } from "./llm-runtime/capability-reach.js";

/** 여는 표시 `<!--role:main-->` / `<!--role:manager-->` / `<!--role:subagent-->`. */
const OPEN_RE = /^[ \t]*<!--\s*role:(main|manager|subagent)\s*-->[ \t]*$/;
/** 닫는 표시 `<!--/role-->`. */
const CLOSE_RE = /^[ \t]*<!--\s*\/role\s*-->[ \t]*$/;

/**
 * 역할 구역 부록의 머리말.
 *
 * ★**«덜 중요한 것» 이 아니라 «이 칸에만 해당하는 것»** 이라고 말한다 — 자리가 뒤라고
 *  약한 규칙으로 읽히면, 옮긴 것 자체가 헌법을 약화시킨 셈이 된다.
 */
const ROLE_APPENDIX_HEADER =
  "## 이 칸에만 해당하는 지침\n\n앞의 헌법과 **같은 무게**입니다 — 자리가 뒤인 것은 " +
  "칸마다 달라서일 뿐입니다(다른 칸은 이 절을 받지 않습니다).";

export interface ConstitutionScoped {
  /** 표시 **밖**의 공용 본문 — 모든 칸에서 바이트 동일. 시스템 채널 **머리**로 간다. */
  readonly body: string;
  /**
   * 이 칸이 닿는 역할 구역 — 시스템 채널 **맨 꼬리**로 간다(없으면 "").
   *
   * ★**`body` 에 붙여 돌려주지 않는다.** 붙이면 부록이 `system` 슬롯 *안* 꼬리에 앉고,
   *  그 뒤에 오는 공용 슬롯(스킬 인덱스·AGENT.md·메모리 인덱스…)이 전부 갈린다.
   *  실측: 붙였을 때 메인↔자식 공유 41.8%, 슬롯으로 빼서 꼬리에 두면 90%대.
   */
  readonly roleExtra: string;
  readonly stats: ConstitutionScopeStats;
}

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
): ConstitutionScoped => {
  const lines = text.split("\n");
  /** 표시 **밖**의 글 — 모든 칸에서 바이트 동일이라 프리픽스가 여기까지 공유된다. */
  const shared: string[] = [];
  /** 이 칸이 닿는 역할 구역 — 꼬리로 간다. */
  const extra: string[] = [];
  const malformed: string[] = [];
  let level: Reach | undefined;
  /** 여는 표시 바로 앞의 가장 가까운 제목 — 뜯긴 불릿에 맥락을 들려 보낸다. */
  let heading = "";
  let regions = 0;
  let dropped = 0;
  for (const [i, line] of lines.entries()) {
    const open = OPEN_RE.exec(line);
    if (open !== null) {
      if (level !== undefined) malformed.push(`L${i + 1}: 중첩된 role 표시`);
      level = open[1] as Reach;
      regions += 1;
      if (turnReaches(turn, level)) {
        // 구역 사이를 한 줄 띄우고, 어디서 온 글인지 한 줄 남긴다.
        if (extra.length > 0) extra.push("");
        if (heading !== "") extra.push(`> (원 위치: ${heading})`);
      }
      continue;
    }
    if (CLOSE_RE.test(line)) {
      if (level === undefined) malformed.push(`L${i + 1}: 짝 없는 닫는 표시`);
      level = undefined;
      continue;
    }
    if (level === undefined) {
      // 제목은 **공용 본문에서만** 딴다 — 구역 안의 제목을 따면 자기 자신을 가리킨다.
      if (/^#{1,6} /.test(line)) heading = line.replace(/^#+\s*/, "").trim();
      shared.push(line);
      continue;
    }
    if (!turnReaches(turn, level)) {
      dropped += Buffer.byteLength(`${line}\n`, "utf8");
      continue;
    }
    extra.push(line);
  }
  if (level !== undefined) malformed.push("파일 끝: 안 닫힌 role 표시");
  if (malformed.length > 0) {
    return { body: text, roleExtra: "", stats: { regions, droppedBytes: 0, malformed } };
  }
  // 표시를 걷어내며 생긴 빈 줄 연속은 접는다 — 표시가 없던 때와 같은 모양이 되도록.
  const fold = (xs: string[]): string => xs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const tail = fold(extra);
  return {
    body: fold(shared),
    roleExtra: tail === "" ? "" : `${ROLE_APPENDIX_HEADER}\n\n${tail}`,
    stats: { regions, droppedBytes: dropped, malformed },
  };
};
