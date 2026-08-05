/**
 * 회귀: **선택지가 새로고침 후에도 남는다** (2026-08-02 사용자 제보).
 *
 * 사용자: *"대시보드 채팅에서 옵션이 한번 뜬 다음 새로고침을 해도 다시 안 떠있네"*.
 *
 * ★이 사고의 교훈은 원인 자체보다 **어디에 있었나**다. 부품은 **전부 있었다**:
 *   - 생산 — `prompt.options` 가 `chat_log` 에 `kind` 행으로 쌓인다(실측 08-02 이후 7/7 일치)
 *   - 읽기 — `getRecentChatLog` 가 `kind`·`data` 를 실어 준다
 *   - 빌더 — `registerChatKindBuilder("prompt.options", …)` 로 **라이브와 같은 빌더** 재사용
 *   - dedup — `renderedPromptOptionKeys` 로 라이브/이력 이중 렌더 방지
 *  그런데 화면엔 안 나왔다. **병합 단계에서 버려졌기 때문**이다 — `groupMergedItems` 의
 *  "직전에 텍스트 세그먼트가 있었으면 뒤따르는 flat assistant 행은 그 중복" 가드가
 *  **선택지 행도 assistant 라서** 같이 집어삼켰다.
 *
 * 실측 순서(19:57:33): `llm.activity kind:"text"` → **같은 초** `prompt.options`.
 * 모델은 말을 하고 나서 선택지를 띄우므로 **항상 이 순서**다 = 100% 드롭이었다.
 *
 * ★`kind` 행은 2026-08-01 에 생긴 **새 값**인데, 그 값을 분기·열거하는 이 자리를 같이
 *  보지 않았다([[feedback_scope_of_a_fix]] 의 "새 값 → 분기처 전수"). 첨부(`mHasAtt`)가
 *  이미 **같은 이유로** 예외였는데도 한 번 더 놓쳤다 — 그래서 검사는 이름이 아니라
 *  **"kind 행은 텍스트 중복이 아니다"** 라는 성질로 건다.
 *
 * ★부수 확인: SSE 리플레이는 이 결함의 구제책이 못 된다. 창이 50건인데 가장 최근
 *  선택지도 이후 이벤트가 **228건**(옛것은 1,280~1,850건)이라 이미 창 밖이다.
 *  즉 이력 경로가 유일한 복원 수단이고, 그게 막혀 있었다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Unit {
  kind: string;
  entry?: { ts: number; kind?: string; role?: string };
  act?: { kind?: string };
}
type Group = (
  entries: Array<Record<string, unknown>>,
  activities: Array<Record<string, unknown>>,
) => Unit[];

export const check: RegressionCheck = {
  name: "history-keeps-prompt-options",
  guards:
    "선택지가 새로고침 후 사라지던 것 — 이력 병합이 선택지 행을 '텍스트 세그먼트의 중복'으로 보고 드롭",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = readFileSync(
      path.join(REPO, "packages/dashboard/js/history-render.js"),
      "utf8",
    );

    // 브라우저 IIFE 라 import 가 안 된다 → 함수 본문만 떼어 vm 에서 **실제로 돌린다**
    // (문자열 존재 검사로는 이 결함이 안 잡힌다 — 모든 부품이 "있었으니까").
    const m = /const groupMergedItems = \([\s\S]*?\n {6}\};/.exec(src);
    out.push(
      assert("groupMergedItems 를 떼어낸다(검사 전제)", m !== null, m === null ? "★못 찾음" : "OK"),
    );
    if (m === null) return out;

    const ctx: { groupMergedItems?: Group } = {};
    vm.createContext(ctx);
    vm.runInContext(
      `const renderedMsgKeys = new Set();
       const msgKey = (ts, role) => ts + "|" + role;
       ${m[0]}
       this.groupMergedItems = groupMergedItems;`,
      ctx,
    );
    const group = ctx.groupMergedItems as Group;

    const TK = "dashboard:a7e92761";
    // ★실측 형상 그대로(19:57:33): 텍스트 세그먼트 …777 → 선택지 …784(7ms 뒤) → 다음
    //  텍스트 → 최종 assistant 행. 같은 *초* 지만 같은 ms 는 아니다 — 시각을 동률로 두면
    //  정렬 tie-break 라는 다른 것을 검사하게 된다.
    const units = group(
      [
        { ts: 1000, threadKey: TK, role: "user", text: "골라줘" },
        { ts: 2007, threadKey: TK, role: "assistant", text: "", kind: "prompt.options", data: { options: [{ label: "A" }] } },
        { ts: 4000, threadKey: TK, role: "assistant", text: "정리했습니다" },
      ],
      [
        { ts: 2000, threadKey: TK, kind: "text", seq: 1, text: "이렇게 할까요?" },
        { ts: 3000, threadKey: TK, kind: "text", seq: 2, text: "정리했습니다" },
      ],
    );

    const optUnits = units.filter((u) => u.entry?.kind === "prompt.options");
    out.push(
      assert(
        "★텍스트 세그먼트 바로 뒤의 선택지가 살아남는다(실측 순서 그대로)",
        optUnits.length === 1,
        optUnits.length === 1
          ? `유닛 ${units.length}개 중 선택지 1개 보존`
          : `★선택지가 ${optUnits.length}개 — 텍스트 중복으로 드롭됐다(사용자 증상)`,
      ),
    );
    // 순서 — 선택지는 그 텍스트 뒤, 다음 텍스트 앞에 있어야 한다(대화 흐름 보존).
    const idxOpt = units.findIndex((u) => u.entry?.kind === "prompt.options");
    const textIdx = units.map((u, i) => (u.kind === "text" ? i : -1)).filter((i) => i >= 0);
    out.push(
      assert(
        "선택지가 앞뒤 텍스트 사이 제자리에 놓인다",
        idxOpt > textIdx[0]! && idxOpt < textIdx[1]!,
        `텍스트 ${JSON.stringify(textIdx)} · 선택지 ${idxOpt}`,
      ),
    );
    // ★반대 방향 — 원래 가드는 살아 있어야 한다. 순수 텍스트 assistant 행은 여전히 중복이다
    //  (이걸 안 보면 "선택지를 살리려다 모든 중복을 되살린" 회귀를 못 잡는다).
    const plain = units.filter((u) => u.entry?.role === "assistant" && u.entry.kind === undefined);
    out.push(
      assert(
        "순수 텍스트 assistant 행은 여전히 세그먼트 중복으로 드롭된다(과잉 복원 0)",
        plain.length === 0,
        plain.length === 0 ? "중복 0" : `★${plain.length}건이 되살아났다 — 같은 말이 두 번 보인다`,
      ),
    );
    // 첨부 행도 같은 이유로 예외였다 — 그 예외가 유지되는가(같은 가드의 형제 사례).
    const withAtt = group(
      [{ ts: 2000, threadKey: TK, role: "assistant", text: "", attachments: [{ kind: "image" }] }],
      [{ ts: 1500, threadKey: TK, kind: "text", seq: 1, text: "보냈습니다" }],
    );
    out.push(
      assert(
        "첨부를 실은 assistant 행도 계속 살아남는다(기존 예외 유지)",
        withAtt.some((u) => u.entry?.role === "assistant"),
        `유닛 ${withAtt.length}개`,
      ),
    );
    return out;
  },
};
