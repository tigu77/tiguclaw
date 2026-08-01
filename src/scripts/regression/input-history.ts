/**
 * 회귀: **대시보드 입력창 ↑/↓ 히스토리** (2026-08-01 신규 기능).
 *
 * Claude Code CLI 는 되는데 대시보드는 안 되던 갭(원칙 1: 슈퍼셋).
 *
 * ★새 저장소를 두지 않는다 — "이 세션에서 내가 보낸 말" 은 이미 로드돼 있다
 *  (`chat_log` → `/chat-history` → `vtItems`). 별도 배열을 만들면 같은 판단이 두 곳이 되고
 *  둘이 어긋난다(오늘 하루 그 병만 세 번 봤다). 새로 갖는 상태는 **커서 하나**뿐이라
 *  세션 분리가 공짜다(vtItems 가 이미 탭별).
 *
 * ★이 검사가 지키는 것은 "위를 누르면 뭔가 뜬다" 가 아니라 **경계**다:
 *  맨 끝에서 멈추는가 · 끝까지 내려오면 쓰던 draft 가 돌아오는가 · 기록이 없을 때 조용한가.
 *  경계가 틀리면 입력이 사라지거나(draft 유실) 히스토리에 갇힌다.
 *
 * 브라우저 없이 **실제 배포되는 코드**를 돌린다 — 파일에서 순수 함수를 꺼내 vm 에서 평가한다.
 * (문자열 존재 확인으로 때우면 동작이 바뀌어도 초록이다. 오늘 그런 검사를 5건 걷어냈다.)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

interface Step {
  cursor: number | null;
  text: string | null;
}
type HistoryStep = (
  entries: string[],
  cursor: number | null,
  dir: number,
  draft: string,
) => Step;

export const check: RegressionCheck = {
  name: "input-history",
  guards:
    "대시보드 입력창 ↑/↓ 히스토리의 경계 — 맨 끝 정지·draft 복귀·기록 0일 때 무동작",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../packages/dashboard/js/input-history.js",
    );
    const src = await readFile(file, "utf8");
    // 순수 함수만 잘라 평가한다(나머지는 DOM 전역을 만진다). 잘라내기가 실패하면
    // 아래 단언들이 전부 빨간불이 되므로 조용히 통과하지 않는다.
    const m = /const historyStep = \([\s\S]*?\n {6}\};/.exec(src);
    const mi = /const historyIntent = \([\s\S]*?\n {6}\};/.exec(src);
    out.push(
      assert(
        "판정 함수를 실제 배포 파일에서 꺼낸다(문자열 확인 아님)",
        m !== null,
        m === null ? "★historyStep 을 못 찾음 — 검사 불가" : `${m[0].length}자`,
      ),
    );
    if (m === null) return out;
    const ctx: { historyStep?: HistoryStep } = {};
    vm.createContext(ctx);
    vm.runInContext(`${m[0]}\nthis.historyStep = historyStep;`, ctx);
    const step = ctx.historyStep as HistoryStep;
    const ctx2: { historyIntent?: (...a: unknown[]) => number } = {};
    vm.createContext(ctx2);
    if (mi !== null) vm.runInContext(`${mi[0]}\nthis.historyIntent = historyIntent;`, ctx2);
    const intent = ctx2.historyIntent as (
      k: string, composing: boolean, s0: number, s1: number, v: string, c: number | null,
    ) => number;
    out.push(
      assert(
        "개입 판정 함수도 배포 파일에서 꺼낸다",
        mi !== null && typeof intent === "function",
        mi === null ? "★historyIntent 못 찾음" : "확보",
      ),
    );

    const E = ["첫 질문", "두번째", "세번째"]; // 오래된→최신

    // ★① 위 — 밖에서 누르면 **가장 최근**부터. 셸과 같다.
    const up1 = step(E, null, -1, "쓰던 것");
    out.push(
      assert(
        "★밖에서 ↑ 는 가장 최근 입력을 불러온다",
        up1.cursor === 2 && up1.text === "세번째",
        `cursor=${String(up1.cursor)} text=${String(up1.text)}`,
      ),
    );
    // 계속 올라가면 과거로.
    const up2 = step(E, 2, -1, "쓰던 것");
    const up3 = step(E, 1, -1, "쓰던 것");
    out.push(
      assert(
        "↑ 를 계속 누르면 과거로 간다",
        up2.text === "두번째" && up3.text === "첫 질문",
        `${String(up2.text)} → ${String(up3.text)}`,
      ),
    );
    // ★맨 끝에서 멈춘다 — 넘어가면 입력이 비거나 튄다.
    const up4 = step(E, 0, -1, "쓰던 것");
    out.push(
      assert(
        "★가장 오래된 것에서 멈춘다(넘어가지 않는다)",
        up4.cursor === 0 && up4.text === "첫 질문",
        `cursor=${String(up4.cursor)} text=${String(up4.text)}`,
      ),
    );

    // ★② 아래 — 최근 쪽으로, 끝을 넘으면 **쓰던 draft 로 복귀**(이게 없으면 입력이 사라진다).
    const dn1 = step(E, 0, 1, "쓰던 것");
    out.push(
      assert("↓ 는 최근 쪽으로 돌아온다", dn1.text === "두번째", String(dn1.text)),
    );
    const dn2 = step(E, 2, 1, "쓰던 것");
    out.push(
      assert(
        "★히스토리 끝을 넘으면 쓰던 입력이 돌아온다(draft 유실 0)",
        dn2.cursor === null && dn2.text === "쓰던 것",
        `cursor=${String(dn2.cursor)} text=${String(dn2.text)}`,
      ),
    );
    // 빈 draft 도 그대로 복원(빈 것이 정상 상태다).
    const dn3 = step(E, 2, 1, "");
    out.push(
      assert(
        "draft 가 비어 있었으면 빈 채로 돌아온다",
        dn3.cursor === null && dn3.text === "",
        `text=${JSON.stringify(dn3.text)}`,
      ),
    );

    // ★③ 무동작 — 건드리면 안 되는 경우. text=null 이 "입력창 손대지 마라" 다.
    const outside = step(E, null, 1, "쓰던 것");
    out.push(
      assert(
        "★밖에서 ↓ 는 아무 일도 안 한다(커서 이동을 뺏지 않는다)",
        outside.cursor === null && outside.text === null,
        `cursor=${String(outside.cursor)} text=${String(outside.text)}`,
      ),
    );
    const empty = step([], null, -1, "쓰던 것");
    out.push(
      assert(
        "★기록이 없으면 ↑ 도 아무 일도 안 한다",
        empty.cursor === null && empty.text === null,
        `cursor=${String(empty.cursor)} text=${String(empty.text)}`,
      ),
    );

    // ★⑤ **언제 손대지 않는가** — 이 기능의 어려운 절반. 하나라도 틀리면 입력이 망가진다.
    if (typeof intent === "function") {
      const cases: Array<[string, number, string]> = [
        // [설명, 기대값, 실제]
        ["빈 칸에서 ↑ 는 진입한다", -1, String(intent("ArrowUp", false, 0, 0, "", null))],
        ["★쓰던 입력이 있으면 ↑ 가 진입하지 않는다", 0, String(intent("ArrowUp", false, 3, 3, "쓰는중", null))],
        ["★이미 탐색 중이면 값이 있어도 계속 탐색한다", -1, String(intent("ArrowUp", false, 3, 3, "세번째", 2))],
        ["★IME 조합 중엔 개입하지 않는다", 0, String(intent("ArrowUp", true, 0, 0, "", null))],
        ["★선택 영역이 있으면 개입하지 않는다", 0, String(intent("ArrowUp", false, 0, 2, "", null))],
        ["★여러 줄에서 커서가 첫 줄이 아니면 ↑ 는 커서 이동", 0, String(intent("ArrowUp", false, 6, 6, "첫줄\n둘째", 1))],
        ["★여러 줄에서 커서가 마지막 줄이 아니면 ↓ 는 커서 이동", 0, String(intent("ArrowDown", false, 1, 1, "첫줄\n둘째", 1))],
        ["다른 키는 무관", 0, String(intent("Enter", false, 0, 0, "", null))],
      ];
      const bad = cases.filter(([, want, got]) => String(want) !== got);
      out.push(
        assert(
          `★개입 판정 ${cases.length}종이 옳다(손대지 말아야 할 때 안 댄다)`,
          bad.length === 0,
          bad.length === 0
            ? `${cases.length}종 전부 정확`
            : bad.map(([d, w, g]) => `${d}: 기대 ${w} 실제 ${g}`).join(" / "),
        ),
      );
    }

    // ★④ 배선 — 슬래시 팝업보다 **뒤**여야 한다. 순서가 뒤집히면 슬래시 목록 탐색이 죽는다.
    const { sourceOrder } = await import("./_wiring.js");
    const order = await sourceOrder("../../../packages/dashboard/js/perf.js", [
      /if \(slashKeydown\(e\)\) return;/,
      /if \(historyKeydown\(e, input\)\) return;/,
      /e\.key === "Enter"/,
    ]);
    out.push(
      assert(
        "★↑/↓ 처리가 슬래시 팝업 뒤·Enter 전송 앞에 있다",
        order.ok,
        order.detail,
      ),
    );
    // 원문 보관이 버블 생성 지점에 있다 — 없으면 히스토리가 항상 비어 있다.
    const { sourceHas } = await import("./_wiring.js");
    const raw = await sourceHas("../../../packages/dashboard/js/history-render.js", [
      /div\.dataset\.raw = entry\.text;/,
    ]);
    out.push(
      assert(
        "★내 입력 원문이 버블에 보관된다(히스토리의 유일한 재료)",
        raw.ok,
        raw.ok ? "보관 확인" : `누락 ${raw.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
