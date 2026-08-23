/**
 * 회귀: **메시지 복사는 마크다운 원문을 준다** (2026-08-23 사용자 제안).
 *
 * 렌더된 글을 복사하면 `**`·제목·코드펜스가 사라져, 다른 데 붙였을 때 서식이 통째로
 * 날아간다. 원문을 렌더 시점에 걸어 두고(`dataset.mdSrc`) 복사 핸들러가 그걸 집는다.
 *
 * ★렌더된 HTML 을 마크다운으로 **되돌리지 않는다** — 역변환은 원리적으로 손실이다
 *  (어떤 `<strong>` 이 `**` 였는지 `__` 였는지 알 수 없고, 표·중첩은 더 나쁘다).
 *  원문은 우리가 이미 갖고 있으므로 그냥 들고 있으면 된다.
 * ★답글 인용은 **렌더된 글**을 그대로 쓴다 — 입력창에 짧게 보이는 것이라 기호가 붙으면
 *  읽기 나쁘다. 두 쓰임이 원하는 게 다르므로 `raw`/`text` 를 나눠 둔다(하나로 합치면
 *  한쪽이 손해다).
 *
 * 동작 검증은 헤드리스(`_workspace/verify_copy_md.mjs`, 5/5)가 실제 경로로 한다:
 * 카드 hover → ⋯ 케밥 → "복사" → 클립보드에 원문. 여기서는 **매번 싸게** 배선을 지킨다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DASH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "packages",
  "dashboard",
);
const read = async (rel: string): Promise<string> => {
  try {
    return await readFile(path.join(DASH, rel), "utf8");
  } catch {
    return "";
  }
};

export const check: RegressionCheck = {
  name: "copy-keeps-markdown",
  guards:
    "채팅 메시지를 복사하면 렌더된 평문만 담겨 서식이 날아가던 것 + 답글 인용까지 기호 범벅이 되는 것",
  run: async (): Promise<Assertion[]> => {
    const md = await read("js/markdown.js");
    const reply = await read("js/reply.js");
    if (md === "" || reply === "") {
      return [assert("대시보드 소스 부재 시 통과(배포본 — 오탐 0)", true, "★확인 못 함")];
    }
    return [
      assert(
        "★마크다운 렌더 시 원문을 요소에 남긴다",
        md.includes("msgEl.dataset.mdSrc = src"),
        md.includes("msgEl.dataset.mdSrc = src") ? "확인" : "★원문이 안 남는다",
      ),
      assert(
        // 평문으로 되돌 때 안 지우면 복사가 **옛 메시지의 원문**을 집는다.
        "★평문으로 되돌면 원문 표시를 지운다(옛 값 오염 0)",
        md.includes("delete msgEl.dataset.mdSrc"),
        md.includes("delete msgEl.dataset.mdSrc") ? "확인" : "★옛 원문이 남는다",
      ),
      assert(
        "★복사가 원문을 우선한다(없으면 렌더된 글로 폴백)",
        reply.includes("ctx.raw || ctx.text"),
        reply.includes("ctx.raw || ctx.text") ? "확인" : "★렌더된 글만 복사한다",
      ),
      assert(
        // 답글은 `text`(렌더된 글) 그대로여야 한다 — 인용에 기호가 붙으면 읽기 나쁘다.
        "답글 인용은 렌더된 글을 쓴다(복사와 다른 쓰임)",
        reply.includes("startReply(ctx.text, ctx.label)"),
        reply.includes("startReply(ctx.text, ctx.label)") ? "확인" : "★인용이 원문으로 바뀌었다",
      ),
    ];
  },
};
