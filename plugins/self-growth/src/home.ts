/**
 * **이 교훈은 어디 사는가** — 산출물의 자리를 정하는 순수 판정 (2026-09-05).
 *
 * ★왜 생겼나: 자가성장의 산출물이 넷이든 다섯이든 **말끝이 전부 같았다** — *"비서가
 *  사용자에게 확인하세요"*. 그래서 받는 쪽은 매번 «그래서 뭘 하라는 거지» 를 처음부터
 *  생각해야 했고, 4개월간 확정된 지침은 0건이었다. 문제는 게이트가 빡세서가 아니라
 *  **모양이 다른 것들에 문이 하나뿐**이었다는 것이다.
 *
 * ★이 레포엔 이미 교훈이 살 자리가 넷 있고, **셋은 프롬프트를 0바이트 먹는다**:
 *   - `regression` — 검사로 못 박을 수 있는 것. 기억이 아니라 **강제**다. 매 턴 비용 0.
 *   - `skill`      — 절차인 것(도구 시퀀스 반복·작업 설계). 본문은 부를 때만 지불.
 *   - `directive`  — 상시 규범인 것만. `SELF_GROWTH.md`(시스템 슬롯, 캡 있음).
 *   - `ask`        — 모르겠으면 사람에게. **모르는 걸 아는 척하지 않는다.**
 *
 * ★**`hook` 은 일부러 뺐다.** 훅은 「특정 도구 실행 전후」라는 자리인데, 지금 자가성장이
 *  받는 신호(오류 지문·원인 분류·도구 시퀀스)로는 «그 이음매에서만 필요한 규칙» 인지
 *  판정할 근거가 없다. 근거 없는 분기를 만들면 그건 «집행 없는 선언» 이다 — 신호가
 *  생기면 그때 넣는다.
 *
 * ★판정은 **여기 한 곳**이다. 각 산출물 자리에서 문장으로 적으면 그게 곧 네 벌이 되고,
 *  한쪽만 고쳐지는 날 같은 실패가 두 곳으로 간다.
 */

/** 교훈이 살 수 있는 자리. 앞의 셋은 매 턴 프롬프트를 안 먹는다. */
export type LessonHome = "regression" | "skill" | "directive" | "ask";

export interface HomeVerdict {
  readonly home: LessonHome;
  /** 왜 거기인가 — 한 줄(산출물 본문에 그대로 실린다). */
  readonly why: string;
  /** 받는 쪽이 **다음에 할 일** — «확인하세요» 대신 이게 들어간다. */
  readonly action: string;
}

/**
 * **결정적 실패인가** — 같은 입력이면 같은 결과인가.
 *
 * ★네트워크·한도·과부하·타임아웃은 **우리가 못 고치는 바깥 사정**이라 검사로 못 박는다.
 *  그걸 회귀로 보내면 «되지도 않을 일» 을 시키는 것이고, 그 검사는 깜빡이다가 무시된다
 *  (이 레포가 이미 아는 부류 — 항상 초록인 가짜 검사의 반대편).
 */
const isDeterministic = (errorKind: string): boolean =>
  !/(timeout|rate|overload|network|econn|etimedout|5\d\d|quota|cooldown)/i.test(errorKind);

/**
 * 자리를 정한다. 입력은 **자가성장이 실제로 들고 있는 것만** 받는다(없는 신호를 요구하면
 * 호출부가 지어내게 된다).
 */
export const suggestHome = (input: {
  /** 산출물 종류 — skill_proposal · skill_improve · failure · segment · drift */
  kind: string;
  /** 실패 원인 분류(있을 때만) — skill · prompt_config · task_design · core · uncertain */
  cause?: string;
  /** 오류 지문 종류(있을 때만) — 결정성 판정에 쓴다. */
  errorKind?: string;
  /** 원인 한 줄이 잡혔나 — 없으면 무엇도 못 정한다. */
  hasCause?: boolean;
}): HomeVerdict => {
  // 절차 후보 — 도구 시퀀스 반복·스킬 개선은 그 자체로 «스킬» 모양이다.
  if (input.kind === "skill_proposal" || input.kind === "skill_improve") {
    return {
      home: "skill",
      why: "같은 절차가 반복된다 — 절차는 스킬로 굳히면 매 턴 비용 없이 재사용된다.",
      action: "사용자 확인 후 `harness:harness` 로 스킬을 만들거나 고친다.",
    };
  }

  if (input.kind === "failure") {
    // 원인을 모르면 자리도 모른다. 지어내지 않는다.
    if (input.hasCause === false) {
      return {
        home: "ask",
        why: "원인이 안 잡혔다 — 자리를 정할 근거가 없다.",
        action: "원인을 아는 사람(또는 그 턴을 돌던 비서)이 한 줄을 채운 뒤 다시 판정한다.",
      };
    }
    if (input.cause === "core") {
      return {
        home: "regression",
        why: "코어 결함이면 다음에도 같은 입력에서 재발한다 — 기억보다 검사가 싸고 확실하다.",
        action: "재현 조건을 회귀 검사로 옮긴다(`npm run test:regression`). 검사가 서면 이 제안은 닫는다.",
      };
    }
    if (input.cause === "task_design" || input.cause === "skill") {
      return {
        home: "skill",
        why: "작업 설계·절차가 원인이다 — 그 절차를 고쳐야 다음 실행이 달라진다.",
        action: "관련 스킬을 고치거나(harness) 작업 설계를 바꾼다. 스킬이 없으면 만들 후보다.",
      };
    }
    if (input.cause === "prompt_config") {
      return isDeterministic(input.errorKind ?? "")
        ? {
            home: "directive",
            why: "설정·지침이 원인이고 재발이 결정적이다 — 상시 규범 한 줄이 막는다.",
            action: "SELF_GROWTH.md 확정 지침으로 올린다(사용자 승인). 설정 값이면 사용자가 바꾼다.",
          }
        : {
            home: "ask",
            why: "바깥 사정(타임아웃·한도·과부하)이라 우리 쪽 규칙으로 막히지 않는다.",
            action: "재시도·대기 정책이 이미 있는지 확인하고, 없으면 사용자와 정한다. 규범으로 만들지 않는다.",
          };
    }
    return {
      home: "ask",
      why: "원인 분류가 불확실하다.",
      action: "사람이 한 번 보고 자리를 정한다 — 자동으로 규범을 만들지 않는다.",
    };
  }

  // 반복 패턴·드리프트 = 사용자가 같은 말을 여러 번 했다는 신호 → 상시 규범 후보.
  if (input.kind === "segment" || input.kind === "drift") {
    return {
      home: "directive",
      why: "같은 종류의 규범이 반복해서 쌓인다 — 한 줄로 합치면 매번 다시 말하지 않아도 된다.",
      action: "합칠 한 줄을 만들어 사용자 승인 후 SELF_GROWTH.md 로 올린다.",
    };
  }

  return {
    home: "ask",
    why: "아직 자리를 정할 만큼의 신호가 없다.",
    action: "사람이 보고 정한다.",
  };
};

/** 산출물 본문에 그대로 실리는 세 줄(자리·이유·다음 할 일). */
export const homeFields = (v: HomeVerdict): Record<string, string> => ({
  suggested_home: v.home,
  home_reason: v.why,
  suggested_action: v.action,
});
