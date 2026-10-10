/**
 * 회귀: **선택지의 «기타» 칸 — Shift+Enter 는 줄바꿈, 한글 조합 중 Enter 는 조합 확정** (2026-10-10 정태님 신고).
 *
 * 사고: 기타 칸이 한 줄 `<input>` 이고 keydown 이 `Enter` 면 무조건 보냈다 — Shift+Enter 로 줄을 바꿀 수 없었고, 한글을 조합하는
 *  중의 Enter(조합 확정)도 그대로 전송됐다. 메인 입력창(perf.js)은 이미 «Shift·조합·터치» 를 가르고 있었다 — 두 입력의 규칙이 갈렸다.
 *
 * 지키는 것(실제 `prompt-options.js` 를 vm 에서 돌려 진짜 keydown 을 보낸다):
 *  ① 여러 줄을 담을 수 있는 칸이다(textarea)
 *  ② Shift+Enter · 조합 중 Enter 는 보내지 않는다 / 그냥 Enter 는 보낸다(값 그대로, 줄바꿈 포함)
 *  ③ 터치 기기에선 Enter 가 줄바꿈이다(보내기는 버튼) — 메인 입력창과 같은 판정
 *
 * 등급: **동작**(미니 DOM).
 */
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { dashSource, dispatch, makeDomContext, makeEvent } from "./_mini-dom.js";

const build = (touch: boolean) => {
  const { ctx, document } = makeDomContext({ i18n: (k: string) => k });
  vm.createContext(ctx);
  vm.runInContext(
    `let firstEvent = false; let localChatCount = 0; const refreshChatEmpty = () => {}; const currentView = "chat";
     const showOverview = () => {}; const submitted = []; const submitOptionValue = (v) => submitted.push(v);
     const vtAppend = () => {}; const registerChatKindBuilder = () => {}; const assistantName = "비서";
     const isTouchPrimary = () => ${String(touch)};`,
    ctx,
  );
  vm.runInContext(dashSource("prompt-options.js"), ctx, { filename: "prompt-options.js" });
  const div = vm.runInContext(`buildPromptOptions({ question: "어느 쪽?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }, "10:00", ${String(Date.now())})`, ctx);
  document.body.appendChild(div);
  const input = div.querySelector(".prompt-other-input");
  const submitted = (): string[] => vm.runInContext("submitted", ctx) as string[];
  const key = (init: Record<string, unknown>): boolean => dispatch(input, makeEvent("keydown", { key: "Enter", shiftKey: false, isComposing: false, ...init }));
  return { input, submitted, key };
};

export const check: RegressionCheck = {
  name: "prompt-other-input-multiline",
  guards: "선택지 «기타» 칸이 한 줄 input 이라 Shift+Enter 줄바꿈이 안 되고 바로 보내지던 것 + 한글 조합 중 Enter 도 전송되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const d = build(false);
    out.push(assert("① 기타 칸은 여러 줄을 담는 textarea 다", d.input?.tagName?.toLowerCase() === "textarea", d.input?.tagName));
    d.input.value = "첫 줄";
    const shiftDefault = d.key({ shiftKey: true });
    const composingDefault = d.key({ isComposing: true });
    const afterHeld = [...d.submitted()];
    d.input.value = "첫 줄\n둘째 줄";
    d.key({});
    out.push(
      assert(
        "★② Shift+Enter·조합 중 Enter 는 보내지 않고(기본 동작 = 줄바꿈·조합 확정을 막지 않는다) · 그냥 Enter 는 줄바꿈 포함 값 그대로 보낸다",
        afterHeld.length === 0 && shiftDefault === true && composingDefault === true && d.submitted().length === 1 && d.submitted()[0] === "첫 줄\n둘째 줄",
        { 보류중전송: afterHeld, shift기본동작유지: shiftDefault, 조합기본동작유지: composingDefault, 전송: d.submitted() },
      ),
    );
    const t = build(true);
    t.input.value = "터치";
    t.key({});
    out.push(assert("③ 터치 기기에선 Enter 가 줄바꿈이다(보내기는 버튼) — 메인 입력창과 같은 판정", t.submitted().length === 0, { 전송: t.submitted() }));
    return out;
  },
};

export default check;
