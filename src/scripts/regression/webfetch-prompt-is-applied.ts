/**
 * 회귀: `WebFetch(prompt)` 가 **본문에 실제로 돌아간다** — 그리고 못 돌리면 **말한다** (2026-08-15).
 *
 * 사고: 우리 `WebFetch` 는 `prompt` 를 선언만 하고 **한 번도 안 썼다**(`args.prompt` 참조 0회).
 * SDK 계약은 *"The prompt to run on the fetched content"* 다. codex 가 *"이게 진짜 AAD
 * 페이지인지 확인해줘"* 라고 물으면 답 대신 **페이지 전문**이 돌아왔고, 에러도 로그도 없었다.
 * 20일 실측: codex 22건 **전부** prompt 를 실었고 **전부 무시**. claude 는 SDK 것이라 정상
 * 처리돼서 **어댑터 간 비대칭**이기도 했다(원칙 1 슈퍼셋 + "모든 기능 LLM 무관" 둘 다 위반).
 *
 * ★검사의 핵심은 **성공 경로가 아니라 실패 경로**다. 이 결함의 본질이 "조용한 무시" 였으니
 *  지켜야 할 계약은 이것이다 — **추출이 안 되면 ①본문을 잃지 않고 ②왜 못 했는지 말한다.**
 *
 * ★처음엔 "회귀 프로세스엔 모델 인증이 없으니 추출은 반드시 실패한다" 고 **단정하고** 그
 *  위에 검사를 세웠다. 틀렸다 — 폴백 체인의 **로컬 모델(ollama)이 실제로 추출에 성공**해서
 *  검사가 빨간불이 났다(그리고 한 번에 24초를 먹었다). 기능이 도는 건 그렇게 확인됐지만,
 *  **환경에 따라 답이 갈리는 검사는 검사가 아니다.** 그래서 지금은 `timeout` 을 1초로 줘
 *  실패를 **결정적으로 만든 뒤** 폴백 계약을 본다(CI 엔 로컬 모델도 인증도 없다 — 어느
 *  쪽이든 같은 결과).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildExtractPrompt,
  extractFromContent,
  WEBFETCH_EXTRACT_MAX_CHARS,
} from "../../core/llm-runtime/webfetch-extract.js";
import { createFileOpsMcpServer } from "../../core/llm-runtime/capabilities/file-ops-mcp.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const BODY = "<html><body><h1>가격표</h1><p>기본 9,900원</p></body></html>";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 지시문(순수 함수) — 지어내기 금지 + 잘림 고지 ──────────────────────────
  const p1 = buildExtractPrompt({ url: "https://x/y", prompt: "가격만", content: "본문", truncated: false });
  out.push(
    assert(
      "★없는 걸 지어내지 말라고 박는다(호출자는 검증할 수단이 없다)",
      p1.includes("문서에 없음") && p1.includes("지어내지"),
      p1.slice(0, 70).replace(/\n/g, " "),
    ),
  );
  out.push(
    assert(
      "본문이 지시와 섞이지 않게 경계로 감싼다",
      p1.includes("--- 문서 시작 ---") && p1.includes("--- 문서 끝 ---"),
      "경계 확인",
    ),
  );
  const p2 = buildExtractPrompt({ url: "https://x/y", prompt: "가격만", content: "본문", truncated: true });
  out.push(
    assert(
      "★잘렸으면 **모델에게 말한다**(모르고 답하면 '문서에 없다' 는 틀린 답이 나온다)",
      p2.includes("앞부분만") && !p1.includes("앞부분만"),
      `truncated=${p2.includes("앞부분만")} / 아닐 때=${p1.includes("앞부분만")}`,
    ),
  );

  // ── ② 빈 prompt 는 모델을 부르지 않는다(공짜로 실패) ─────────────────────────
  const empty = await extractFromContent({ url: "https://x", prompt: "   ", content: "본문" });
  out.push(
    assert(
      "빈 prompt 는 모델 호출 없이 즉시 거절",
      !empty.ok && empty.reason.includes("비어"),
      empty.ok ? "★모델을 불렀다" : empty.reason,
    ),
  );

  // ── ③ ★핵심 — 추출이 실패해도 **본문을 잃지 않고, 조용하지 않다** ────────────
  //  timeout 1초로 실패를 **만들어** 폴백 경로를 태운다(환경에 기대지 않는다 — 위 헤더 참조).
  {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(BODY);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const mcp = await adaptClaudeMcpServer(
        createFileOpsMcpServer(process.cwd()),
        "file-ops",
      );
      // timeout=1초 → 추출은 반드시 시한 초과. 폴백 경로를 결정적으로 태운다.
      const r = await mcp.callTool("WebFetch", {
        url: `http://127.0.0.1:${port}/`,
        prompt: "가격만 뽑아줘",
        timeout: 1,
      });
      const text = typeof r === "string" ? r : JSON.stringify(r);
      out.push(
        assert(
          "★추출 실패해도 본문을 잃지 않는다(가져온 것을 버리지 않는다)",
          text.includes("9,900"),
          text.slice(0, 120).replace(/\n/g, " "),
        ),
      );
      out.push(
        assert(
          "★추출 실패를 **말한다**(조용한 무시가 이 결함의 본질이었다)",
          text.includes("⚠️") && text.includes("prompt"),
          text.includes("⚠️") ? "실패 고지 확인" : "★조용히 본문만 돌려줬다 — 사고 재발",
        ),
      );
      // prompt 없이 부르면 종전대로 본문만 — 고지 문구가 끼어들지 않는다.
      const plain = await mcp.callTool("WebFetch", { url: `http://127.0.0.1:${port}/` });
      const ptext = typeof plain === "string" ? plain : JSON.stringify(plain);
      out.push(
        assert(
          "prompt 없으면 종전 그대로(본문만, 경고 없음)",
          ptext.includes("9,900") && !ptext.includes("⚠️"),
          ptext.slice(0, 90).replace(/\n/g, " "),
        ),
      );
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }

  // ── ④ 모델에 먹이는 양에 상한이 있다 ────────────────────────────────────────
  //  fetch 는 5MB 까지 받는다. 그걸 그대로 넣으면 추출이 아끼려던 토큰을 도로 태운다.
  out.push(
    assert(
      "★모델 입력에 상한이 있다(5MB 를 그대로 넣지 않는다)",
      WEBFETCH_EXTRACT_MAX_CHARS > 0 && WEBFETCH_EXTRACT_MAX_CHARS <= 200_000,
      `상한 ${WEBFETCH_EXTRACT_MAX_CHARS}자`,
    ),
  );

  // ── ⑤ 호출자가 준 시한이 추출까지 덮는다 ────────────────────────────────────
  //  안 그러면 `timeout: 5` 라고 적은 쪽이 30초를 기다린다(시한을 준 이유가 사라진다).
  {
    const t0 = Date.now();
    await extractFromContent({ url: "https://x", prompt: "가격만", content: "본문", timeoutMs: 300 });
    const ms = Date.now() - t0;
    out.push(assert("★시한이 실제로 추출을 끊는다", ms < 4000, `${ms}ms 만에 반환`));
  }

  return out;
};

export const check: RegressionCheck = {
  name: "webfetch-prompt-is-applied",
  guards:
    "WebFetch 가 `prompt` 를 선언만 하고 무시해, codex 가 물어본 답 대신 페이지 전문을 받던 것(20일간 22건 전부, 에러·로그 0). claude 는 SDK 것이라 정상이라 어댑터 간 비대칭이기도 했다",
  run,
};
