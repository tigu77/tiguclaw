/**
 * 회귀: **폴백은 이유를 말한다** (2026-08-31).
 *
 * ★사고: 지정 모델이 안 되면 화면엔 *"쓸 수 없어 기본 모델로 답했습니다"* 만 떴고 진짜
 *  사유는 **데몬 로그에만** 남았다. 그래서 사용자는 *모델명을 잘못 썼는지*, *키가 없는지*,
 *  *그 provider 가 그 기능을 못 하는지* 를 구분할 수 없었다. 원격 인스턴스(회사 PC·윈도우)
 *  에선 로그도 못 본다 — [[feedback_logs_must_stand_alone]] 의 반대편이다.
 *  실측(2026-08-31): `google:gemini-2.5-flash` 가 404 *"no longer available to new users"*
 *  를 받았는데 화면엔 그 문장이 한 글자도 없었다.
 *
 * 지키는 것 셋:
 *  ① 폴백 고지에 **사유가 실린다**.
 *  ② 사유는 **재액터를 지난다** — 상류 오류 본문에 자격증명이 섞여도 화면·기록으로 안 샌다.
 *  ③ ★**provider 별 분기가 없다** — 사유는 그 어댑터가 낸 것을 그대로 옮긴다(LLM 무관).
 *
 * 등급: 대조(조립부 소스) + **동작**(재액터를 실제로 실행해 토큰이 지워지는지 본다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../../core/outbound-sanitize.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "fallback-says-why",
  guards:
    "지정 모델이 안 될 때 화면이 '쓸 수 없어' 만 말하고 사유는 로그에만 남아, 사용자가 오타·키부재·기능미지원을 구분 못 하던 것(원격 인스턴스는 로그도 못 본다)",
  run: async (): Promise<Assertion[]> => {
    const src = readFileSync(path.join(REPO, "src/core/llm-runtime/index.ts"), "utf8");
    // 고지를 만드는 블록만 본다 — 파일 전체에서 낱말을 세면 주석에 걸린다.
    // ★**주석을 먼저 지운다** — 안 그러면 이 수정을 *설명하는 글*이 검사 대상이 된다.
    //  첫 판이 정확히 그렇게 빨간불이었다: 근거로 적어둔 `google:gemini-3.6-flash` 를
    //  "벤더 분기" 로 셌다. 이 레포가 이미 겪은 부류다(주석 속 `<style>` 를 태그로 센 게이트)
    //  — **검사 대상은 코드지 그걸 설명하는 글이 아니다.**
    const code = src
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const at = code.indexOf("지정 모델 \\`${requestedLabel}\\`");
    const block = at < 0 ? "" : code.slice(Math.max(0, at - 1200), at + 600);

    const carries = /사유: \$\{reason\}/.test(block);
    // ★**해설이 자르기보다 앞에 놓인다** (적대 검토 P1). 종전엔 해설이 본문 뒤에 붙고
    //  전체를 200자로 잘랐다 — 동기가 된 실측 오류가 **485자**라 해설이 통째로 잘려나갔다.
    //  즉 이 릴리스의 요점이 **정작 그 사례에서 안 보였다.** 자르는 건 상류 원문뿐이어야 한다.
    // 자르는 대상이 `body`(상류 원문)이고, `reason` 은 해설을 **앞에** 이어 붙인다.
    const noteFirst =
      /const body = [\s\S]{0,200}?\.slice\(0, 200\)/.test(block) &&
      /const reason = note === ""/.test(block) &&
      /`★ \$\{note\}/.test(block) &&
      !/const reason[\s\S]{0,120}?\.slice\(0, 200\)/.test(block);
    const redacted = /redactSecrets\(/.test(block);
    // ★사유는 lastError 에서 온다 — 문구를 새로 짓지 않는다(어댑터가 낸 것을 그대로).
    const fromAdapter = /errorDetail\(lastError\)/.test(block);

    // ③ provider 이름으로 분기하는 자리가 고지 조립에 없다.
    const vendorBranch = /(google|gemini|anthropic|codex|openrouter)/i.test(block);

    // ② 동작 — 재액터가 실제로 토큰을 지우는가(문자열 존재가 아니라 실행으로).
    const probe = `400 upstream said Authorization: Bearer sk-or-v1-${"a".repeat(40)} failed`;
    const cleaned = redactSecrets(probe);
    const wiped = !cleaned.includes(`sk-or-v1-${"a".repeat(40)}`);

    return [
      assert(
        "★★폴백 고지가 **사유를 싣는다** — 없으면 사용자는 오타와 기능미지원을 구분할 수 없고, 원격 인스턴스는 로그도 못 본다",
        block !== "" && carries && fromAdapter && noteFirst,
        block === "" ? "★고지 블록을 못 찾음" : `사유 포함=${String(carries)} · 어댑터 원문=${String(fromAdapter)} · 해설이 자르기 앞=${String(noteFirst)}`,
      ),
      assert(
        "★★그 사유가 **재액터를 지난다** — 상류 오류 본문엔 요청 헤더가 섞여 나올 수 있고, 이 문장은 화면과 기록으로 간다",
        redacted && wiped,
        `조립부 redactSecrets=${String(redacted)} · 실행 검증(토큰 지워짐)=${String(wiped)}`,
      ),
      assert(
        "★고지 조립에 **provider 이름 분기가 없다** — 사유는 어댑터가 낸 것을 그대로 옮긴다(한 provider 만 고치면 다음 provider 에서 같은 침묵이 난다)",
        !vendorBranch,
        vendorBranch ? "★벤더 이름이 조립부에 있다" : "벤더 분기 0",
      ),
    ];
  },
};
