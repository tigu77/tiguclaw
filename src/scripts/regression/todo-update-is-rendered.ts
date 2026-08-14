/**
 * 회귀: 할일 도구 카드가 **접히면 요약, 펼치면 전체 목록** (2026-08-14).
 *
 * 배경: `update_todos` 의 두 값 중 ②사용자 가시성이 죽어 있었다(이벤트 138건 발행, 소비처 0).
 * 처음엔 입력창 위에 전용 패널을 붙였다가 **되돌렸다** — 같은 호출이 이미 도구 카드로 뜨고,
 * 패널은 메인 세션 것만 그려 커버리지가 오히려 좁았다(카드는 `llm.activity` 가 threadKey 로
 * 제 자리를 찾아가 워커·에이전트 계획도 각자 잡 카드에 뜬다). 그래서 남은 일은 카드를
 * 제대로 그리는 것뿐이었다.
 *
 * ★막는 것 둘(둘 다 실제로 틀렸던 것):
 *  ① 접힌 줄이 JSON 덤프로 돌아가는 것 — 원래 `todos=[{"content":"…` 였다.
 *  ② 펼쳐도 **빈 카드**인 것 — 두 이름이 출력 제외 목록에 있었다("detail 이 곧 내용" 이라
 *    뺐던 건데 detail 을 요약으로 바꾸면서 근거가 사라졌다). 나는 확인 없이 "펼치면 나온다"
 *    고 말했고 틀렸다.
 *
 * ★claude 는 이 카드가 **안 뜬다**(2026-08-14 실측). 두 인스턴스 6일치 claude 도구 호출
 *  1,304건 중 `TodoWrite` 0건이고, SDK 정의를 보면 후계가 `TaskCreate/TaskUpdate/TaskList`
 *  다(`activeForm` 설명이 토씨까지 같고 ID·의존성·삭제가 더해졌다 = 배열 덮어쓰기 →
 *  항목별 CRUD 로 **모델이 바뀜**). 그래서 `TodoWrite` 를 겨눈 배선은 넣었다가 **뺐다** —
 *  이름만 바꾸면 되는 일이 아니라 우리가 상태를 누적해야 하는 별건이다.
 *  ★검사는 그 사실을 박지 않는다: 상류 이름은 우리 소관이 아니고, 여기 적으면 그 이름이
 *   또 바뀔 때 이 검사가 거짓말이 된다. 지키는 것은 **우리 렌더 계약**뿐이다.
 */
import {
  buildActivityDetail,
  buildActivityDetailFromJson,
} from "../../core/llm-runtime/adapters/_activity-detail.js";
import { buildActivityOutput } from "../../core/llm-runtime/adapters/_activity-output.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const TODOS = [
  { content: "명세 확인", status: "completed", activeForm: "확인 중" },
  { content: "evaluate 구현", status: "in_progress", activeForm: "evaluate 구현 중" },
  { content: "테스트 통과", status: "pending", activeForm: "검증 중" },
];

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 접힌 줄 = 요약 (JSON 덤프 금지) ──────────────────────────────────────
  const detail = buildActivityDetailFromJson(JSON.stringify({ todos: TODOS }));
  out.push(
    assert(
      "★접힌 줄이 요약이다(개수 + 지금 하는 것)",
      detail === "할일 1/3 · 지금: evaluate 구현 중",
      String(detail),
    ),
  );
  out.push(
    assert(
      "진행 중이 없으면 개수만",
      buildActivityDetail({ todos: TODOS.map((t) => ({ ...t, status: "completed" })) }) ===
        "할일 3/3",
      String(buildActivityDetail({ todos: TODOS.map((t) => ({ ...t, status: "completed" })) })),
    ),
  );
  // 인자 shape 이 두 갈래다 — codex/openai 는 JSON 문자열, claude 는 객체. 같은 함수를 타야
  // 어느 어댑터가 이 도구를 갖게 되든 화면이 갈리지 않는다.
  out.push(
    assert(
      "객체 인자(claude 경로)도 같은 요약을 낸다",
      buildActivityDetail({ todos: TODOS }) === detail,
      String(buildActivityDetail({ todos: TODOS })),
    ),
  );

  // ── ② 펼치면 내용이 있다 (빈 카드 금지) ────────────────────────────────────
  const expanded = buildActivityOutput("update_todos", "할일 1/3 완료:\n[x] 명세 확인");
  out.push(
    assert(
      "★펼치면 전체 목록이 나온다(출력 제외 목록에 다시 들어가면 빈 카드가 된다)",
      expanded !== undefined && expanded.text.includes("명세 확인"),
      expanded === undefined ? "출력 없음 — 제외 목록 확인" : expanded.text.slice(0, 40),
    ),
  );

  // ── 다른 도구는 무영향 — todos 특례가 일반 규칙을 밀어내지 않는다 ──────────
  out.push(
    assert(
      "todos 특례가 다른 도구의 detail 을 안 건드린다",
      buildActivityDetail({ command: "node --test" }) === "command=node --test",
      String(buildActivityDetail({ command: "node --test" })),
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "todo-update-is-rendered",
  guards:
    "할일 카드가 접힌 줄엔 JSON 덤프, 펼치면 빈 카드였던 것 — 소비처 0이던 값(이벤트 138건)을 카드 하나로 되살린 계약",
  run,
};
