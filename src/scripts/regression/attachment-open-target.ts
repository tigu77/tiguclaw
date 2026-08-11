/**
 * 회귀: **첨부를 누르면 열린다 — 빈 화면이 아니라.**
 *
 * 사용자 신고 (2026-08-11): "대시보드 채팅에서 내가 보낸 파일들을 채팅 카드에서 누르면
 *  그냥 빈화면 나온다."
 *
 * 뿌리는 한 변수가 두 질문을 겸한 것이다 — 썸네일 `src` 는 *"무엇을 표시할까"* 로 만든
 * 값인데, 클릭 핸들러가 그걸 그대로 `window.open` 에 넘겨 *"무엇을 열까"* 로도 썼다.
 * 전송 직후 낙관적 버블에서 그 값은 **`data:` URI** 이고, 브라우저는 **`data:` 최상위
 * 이동을 차단**한다 → 새 탭이 그냥 빈 화면.
 *
 * 확인한 것(실측): 서빙 엔드포인트는 정상이다 — jpg·json·txt 전부 200 + 올바른 mime.
 * 즉 배달이 아니라 **여는 주소 선택**이 문제였다.
 *
 * 고침: 서빙 주소(`rel`)가 있으면 그걸 쓰고, 없으면 base64 를 **blob** 으로 바꿔 연다
 * (blob 은 최상위 이동 허용). 둘 다 없으면 **열지 않는다** — 빈 탭을 만들지 않는다.
 * 덤으로 열기 어포던스를 이미지 전용에서 **열 수 있는 모든 칩**으로 넓혔다(문서 칩은
 * 종전에 눌러도 아무 일이 없었다).
 *
 * ★판정을 `util.js` 순수 함수로 뽑은 이유: 렌더 클로저 안에 두면 검사가 브라우저를 띄워
 *  **옛 첨부를 화면에 올려야만** 확인된다 — 실제로 그걸 시도하다 막혔다(가상화된 히스토리라
 *  스크롤로 안 올라옴). 껄끄러움은 코드 배치의 진술이다(원칙 게이트 Q7). 지금은 실행해서 지킨다.
 */
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import type { Assertion, RegressionCheck } from "./_framework.js";

const JS_DIR = new URL("../../../packages/dashboard/js/", import.meta.url);

type Target = { kind: "served"; url: string } | { kind: "blob" } | { kind: "none" };

/** util.js 에서 판정 함수만 떼어 **실행 가능한 형태**로 만든다(브라우저 없이). */
const loadDecider = async (): Promise<((a: unknown) => Target) | null> => {
  const src = await readFile(new URL("util.js", JS_DIR), "utf8");
  const m = /const attachmentOpenTarget = \(a\) => \{[\s\S]*?\n      \};/.exec(src);
  if (m === null) return null;
  const ctx: { fn?: (a: unknown) => Target } = {};
  vm.createContext(ctx);
  vm.runInContext(`${m[0]}\nfn = attachmentOpenTarget;`, ctx);
  return ctx.fn ?? null;
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const decide = await loadDecider();
  if (decide === null) {
    return [
      {
        name: "★util.js 에서 attachmentOpenTarget 을 뽑아 실행한다",
        ok: false,
        got: "🔴 함수를 못 찾음 — 이름이 바뀌었거나 클로저로 되돌아갔다",
      },
    ];
  }

  // ── ① 서빙 주소가 있으면 그걸 연다 ──────────────────────────────────────
  {
    const t = decide({ rel: "http-bridge/20260808/abc.json", mime: "application/json" });
    out.push({
      name: "저장된 첨부는 서빙 주소로 연다",
      ok: t.kind === "served" && t.url === "/api/attachments/http-bridge/20260808/abc.json",
      got: JSON.stringify(t),
    });
  }

  // ── ② ★rel 이 없으면 data: 가 아니라 blob 이다 — 이게 이 검사의 존재 이유 ─
  {
    const t = decide({ dataBase64: "aGVsbG8=", mime: "image/png" });
    out.push({
      name: "★낙관적 버블(base64)은 blob 으로 연다(data: 는 브라우저가 막아 빈 화면)",
      ok: t.kind === "blob",
      got: `${JSON.stringify(t)} (기대 blob)`,
    });
    out.push({
      name: "어떤 경우에도 data: URI 를 열기 대상으로 주지 않는다",
      ok: !(t.kind === "served" && String(t.url).startsWith("data:")),
      got: t.kind === "served" ? String(t.url).slice(0, 24) : "served 아님",
    });
  }

  // ── ③ rel 이 우선한다(둘 다 있으면 서빙본 — 용량·캐시 이득) ─────────────
  {
    const t = decide({ rel: "a/b.png", dataBase64: "aGVsbG8=", mime: "image/png" });
    out.push({
      name: "둘 다 있으면 서빙 주소가 이긴다",
      ok: t.kind === "served" && t.url === "/api/attachments/a/b.png",
      got: JSON.stringify(t),
    });
  }

  // ── ④ ★열 게 없으면 열지 않는다 — 빈 탭을 만들지 않는다 ─────────────────
  {
    const cases: Array<[string, unknown]> = [
      ["빈 객체", {}],
      ["rel 빈 문자열", { rel: "" }],
      ["base64 빈 문자열", { dataBase64: "" }],
      ["null", null],
    ];
    const bad = cases.filter(([, v]) => decide(v).kind !== "none").map(([n]) => n);
    out.push({
      name: "★열 주소가 없으면 none — 빈 탭을 만들지 않는다",
      ok: bad.length === 0,
      got: bad.length === 0 ? `${cases.length}종 전부 none` : `🔴 none 아님: ${bad.join(", ")}`,
    });
  }

  // ── ⑤ 렌더가 그 판정을 실제로 쓰는가(수행부 배선) ───────────────────────
  {
    const hr = await readFile(new URL("history-render.js", JS_DIR), "utf8");
    const uses = /attachmentOpenTarget\(a\)/.test(hr);
    const noRawData = !/window\.open\(src\b/.test(hr);
    out.push({
      name: "★history-render 가 판정을 쓰고, src 를 그대로 열지 않는다",
      ok: uses && noRawData,
      got: `판정 사용=${uses} · src 직접 열기=${!noRawData} (기대 true / false)`,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "attachment-open-target",
  guards:
    "채팅 카드에서 방금 보낸 첨부를 누르면 빈 화면이 뜨던 것 — 표시용 src(낙관적 버블에선 data: URI)를 그대로 window.open 에 넘겨 브라우저가 최상위 이동을 차단했다",
  run,
};
