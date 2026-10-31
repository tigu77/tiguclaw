/**
 * 회귀: **플러그인 `host.ask` 의 지정 프로필 · 시한·취소 · 실제 모델·사용량** (2026-10-31).
 *
 * 설계: `docs/decisions/2026-10-30-plugin-designated-profile-design.md`(R4 GPT 통과 + R5 구현 선택).
 * 원 요구: 비서·매니저·서브가 플러그인 기능을 부르고, 그 기능이 사용자가 정한 프로필로 처리한 결과를 받아 원 작업을
 * 계속한다(인계 2026-10-28). 도구 0개 `ask` 로 «전처리 → 지정 프로필 모델 → 후처리» 가 되는지를 **검증용 일회성
 * 플러그인**(자식이 격리 홈에 쓰는 `regr-tidy` — 제품 기능 아님)으로 실제 로더·배선·도구 서버를 지나 확인한다.
 *
 * 지키는 것:
 *  ① 프로필 미지정 = 기본 풀 1단(종전) · 그래도 시한·외부 취소는 걸린다(의도된 동작 변경)
 *  ② 지정 = 그 프로필 자기 풀 · 실제 응답 모델과 어댑터 보고 사용량을 그대로 돌려준다
 *  ③ 고를 수 없는 이름(없는 이름·provider:model·사용자 프로필이 있을 때 등급 별칭·문자열 아님·실행 가능 후보 0)은
 *     **모델 호출 0** + `reason:"profile"` — 기본 풀로 조용히 가지 않는다
 *  ④ 구조적 실패·런타임 실패 모두 다른 프로필로 안 간다(자기 풀만) · 풀 안 후보 폴백은 그대로이고 텍스트에 고지가 안 붙는다
 *  ⑤ 취소: 이미 끊긴 부모면 호출 0 · 도중에 끊기면 어댑터가 부모 사유 그대로 받는다 · 시한 하나가 후보를 넘어 이어진다
 *  ⑥ 도구 0개 · 깊이 = 서브에이전트 · 좌표 `plugin:<이름>:<scope>`
 *  ⑦ 설정: 프로필 정의 변경은 다음 `ask` 부터 · 한 번 만든 호스트의 `settings` 가 파일 변경을 따라간다 · 협조 수준(A)
 *  ⑧ 연계: 부모 턴 → 플러그인 도구 → `ask(profile)` → 후처리 결과가 부모에게 · 부모 취소가 도구 안 `ask` 까지 · `host.turn` 에 신호가 안 샌다
 *  ⑨ `plugin:` 좌표는 사람의 대화가 아니다(세션 목록·파생 판정) · 30일 안 쓴 행은 정리된다
 *
 * 등급: 전부 **동작**(자식 프로세스에서 실제 함수 실행, 가짜 어댑터 · 네트워크 0).
 */
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";

type R = { ok: boolean; reason?: string; text?: string; model?: string; usage?: unknown };

/** 웹검색 모양 연계 판정 — 검색 1 + 본문 2 만 나갔고, 프롬프트엔 읽은 본문만, 결과엔 출처 구분·실제 모델. */
const searchOk = (e: { searchOut?: string; prompt?: string; childModels?: string[]; fetched?: string[] } | undefined): boolean => {
  if (e === undefined) return false;
  let o: { answer?: string; read?: string[]; seen?: string[]; model?: string } = {};
  try {
    o = JSON.parse(e.searchOut ?? "{}") as typeof o;
  } catch {
    return false;
  }
  const p = e.prompt ?? "";
  return (
    JSON.stringify(e.fetched) ===
      JSON.stringify([
        "https://search.regr.test/search?q=can%20plugins%20ask%20a%20profile%3F",
        "https://pages.regr.test/a",
        "https://pages.regr.test/b",
      ]) &&
    p.includes("PAGE-A body") &&
    !p.includes("gamma snippet") &&
    JSON.stringify(o.read) === JSON.stringify(["https://pages.regr.test/a", "https://pages.regr.test/b"]) &&
    JSON.stringify(o.seen) === JSON.stringify(["https://pages.regr.test/c"]) &&
    o.model === "served-x-search" &&
    JSON.stringify(e.childModels) === JSON.stringify(["regr-x"])
  );
};

export const check: RegressionCheck = {
  name: "plugin-ask-profile",
  guards:
    "플러그인이 모델을 부를 때 사용자가 정한 프로필로 돌릴 수 없고(언제나 기본 풀), 시한·부모 취소가 없어 매달리거나 /stop 뒤에도 돌고, 실제 모델·사용량을 버리던 것 + 그걸 열면서 생길 수 있는 조용한 대체(없는 이름·빈 풀·구조적 실패 → 기본 모델)·고지 문구의 데이터 오염·`host.turn` 으로의 내부 신호 누출·플러그인 좌표가 세션 목록에 섞이는 것",
  run: async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const childHome = mkdtempSync(`${tmpdir()}/tiguclaw-regression-ask-profile-`);
    const r = await spawnWithin(
      60000,
      "플러그인 ask 지정 프로필",
      ["--import", "tsx", fileURLToPath(new URL("./_plugin-ask-profile-child.ts", import.meta.url))],
      { env: { ...process.env, TIGUCLAW_HOME: childHome } },
    ).finally(() => rmSync(childHome, { recursive: true, force: true }));
    const line = r.out.split("\n").find((x) => x.startsWith("ASK_PROFILE "));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (line ? JSON.parse(line.slice("ASK_PROFILE ".length)) : {}) as Record<string, any>;
    const s = (v: unknown): string => JSON.stringify(v ?? null).slice(0, 300);
    const bad = (g.badNames?.rs ?? {}) as Record<string, R>;
    const badKeys = ["nope", "anthropic:regr-x", "high", "123", "dead"];
    let e2eTool: { summary?: string; model?: string; usage?: { inputTokens?: number } } = {};
    try {
      e2eTool = JSON.parse(String(g.e2e?.toolOut ?? "{}")) as typeof e2eTool;
    } catch {
      /* 아래 단언이 빨강으로 보여 준다 */
    }
    return [
      assert("자식이 결과를 냈다(없으면 아래는 공짜 초록)", line !== undefined, line === undefined ? r.err.slice(-400) : "ok"),
      assert(
        "① 프로필 미지정 = 기본 풀 첫 후보 한 번 · 결과 그대로(고지 없음)",
        s(g.noProfile?.models) === s(["regr-base"]) && g.noProfile?.r?.ok === true && g.noProfile?.r?.text === "plain",
        s(g.noProfile),
      ),
      assert(
        "★① 미지정 `ask` 에도 시한이 걸린다 — 어댑터가 신호를 받고, 시한이 지나면 `reason:\"timeout\"`(프로필 있을 때만 컨트롤러를 만들면 빨강)",
        g.noProfile?.hasSignal === true && g.noProfileTimeout?.r?.reason === "timeout" && Number(g.noProfileTimeout?.ms) < 2000,
        s(g.noProfileTimeout),
      ),
      assert(
        "★② 지정 프로필 x → x 의 첫 후보로 돌고, 반환 `model` 은 어댑터가 낸 실제 모델 · `usage` 는 보고값 그대로",
        s(g.profileX?.models) === s(["regr-x"]) &&
          g.profileX?.r?.model === "served-x" &&
          s(g.profileX?.r?.usage) === s({ inputTokens: 11, outputTokens: 7 }),
        s(g.profileX),
      ),
      assert(
        "★★③ 고를 수 없는 이름(없는 이름·provider:model·등급 별칭·문자열 아님·실행 가능 후보 0) → 전부 `reason:\"profile\"` 이고 **모델 호출 0**(빈 칸만 기본 풀 1회)",
        badKeys.every((k) => bad[k]?.ok === false && bad[k]?.reason === "profile") && s(g.badNames?.calls) === s(["regr-base"]),
        s({ reasons: Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v.reason ?? "ok"])), calls: g.badNames?.calls }),
      ),
      assert(
        "★★④ 단일 모델 프로필의 **구조적** 실패 → `reason:\"model\"` · 기본 풀(regr-base) 호출 0(자기 풀만 — 다른 프로필 모델로 비용이 나가지 않는다)",
        g.structural?.r?.reason === "model" && s(g.structural?.models) === s(["regr-x"]),
        s(g.structural),
      ),
      assert(
        "④ 런타임 실패도 다른 풀로 안 간다",
        g.runtime?.r?.reason === "model" && s(g.runtime?.models) === s(["regr-x"]),
        s(g.runtime),
      ),
      assert(
        "★④ 풀 **안** 후보 폴백은 그대로(p1 실패 → p2) · 텍스트는 어댑터가 낸 그대로(고지 문구가 데이터에 안 붙는다)",
        s(g.intraPool?.models) === s(["regr-p1", "regr-p2"]) && g.intraPool?.r?.text === "from-p2" && g.intraPool?.r?.model === "served-p2",
        s(g.intraPool),
      ),
      assert(
        "★⑤ 이미 끊긴 부모 → `reason:\"cancelled\"` · 모델 호출 0",
        g.preAborted?.r?.reason === "cancelled" && g.preAborted?.calls === 0,
        s(g.preAborted),
      ),
      assert(
        "★★⑤ 도중에 부모가 끊기면 어댑터의 신호가 끊기고 **부모 사유가 그대로** 간다(사용자 /stop 판정이 유지된다) · `reason:\"cancelled\"`",
        g.midAbort?.r?.reason === "cancelled" && g.midAbort?.abortedAtEnd === true && g.midAbort?.sameReason === true,
        s(g.midAbort),
      ),
      assert(
        "★⑤ 시한은 **하나**다 — 첫 후보가 120ms 쓰고 실패하면 다음 후보는 남은 시간만(200ms 시한 → 총 ~200ms, 후보마다 새로 재면 ~320ms)",
        g.oneTimer?.r?.reason === "timeout" && Number(g.oneTimer?.ms) < 290 && s(g.oneTimer?.models) === s(["regr-p1", "regr-p2"]),
        s(g.oneTimer),
      ),
      assert(
        "★★⑤ 경쟁 — 부모가 먼저 끊고 어댑터가 시한 뒤에 끝나도 `cancelled` · 시한이 먼저면 부모가 뒤에 끊어도 `timeout`(먼저 끊은 쪽 하나)",
        g.race?.stopFirst?.reason === "cancelled" && g.race?.timeFirst?.reason === "timeout",
        s(g.race),
      ),
      assert(
        "빌트인 `default` — 사용자 프로필이 없으면 고를 수 있다(가이드 문장과 같은 판정) · 등급 별칭 `high` 는 못 고른다(호출 0)",
        g.builtin?.d?.ok === true && g.builtin?.hi?.reason === "profile" && g.builtin?.calls === 1,
        s(g.builtin),
      ),
      assert(
        "⑤ 사용량·모델을 어댑터가 안 주면 필드도 없다(0·추정으로 채우지 않는다)",
        g.bare?.r?.ok === true && g.bare?.hasUsage === false && g.bare?.hasModel === false,
        s(g.bare),
      ),
      assert(
        "⑥ 도구 0개(`toolPolicy:none`·플러그인 MCP 0) · 깊이 = 서브에이전트",
        g.noProfile?.tool === "none" && g.noProfile?.extra === 0 && g.noProfile?.depth === g.depthConst && g.noProfileKind === "subagent",
        s({ tool: g.noProfile?.tool, extra: g.noProfile?.extra, depth: g.noProfile?.depth, kind: g.noProfileKind }),
      ),
      assert(
        "★⑦ 프로필 정의를 바꾸면 다음 `ask` 부터 새 풀 · 한 번 만든 호스트(부팅 `start()` 와 같은 수명)의 `settings` 가 파일 변경을 따라간다",
        s(g.reload?.models) === s(["regr-x2"]) && g.reload?.before === "x" && g.reload?.after === "y",
        s(g.reload),
      ),
      assert(
        "⑦ 선택은 협조 수준(A) — 플러그인 설정이 x 여도 호출 인자 y 로 돈다(문서의 «어느 이름을 쓸지는 플러그인이 정한다» 와 같은 동작)",
        g.conflictA?.setting === "x" && s(g.conflictA?.models) === s(["regr-y"]),
        s(g.conflictA),
      ),
      assert(
        "선언(`needs.llm`) 없으면 `reason:\"llm-not-declared\"` · 호출 0",
        g.undeclared?.r?.reason === "llm-not-declared" && g.undeclared?.calls === 0,
        s(g.undeclared),
      ),
      assert(
        "★★⑧ 연계 — 부모 턴이 플러그인 도구를 부르면 **전처리된** 텍스트가 지정 프로필(x) 모델로 가고, **후처리된** 결과·실제 모델·사용량이 부모에게 돌아온다(실제 로더·배선·도구 서버)",
        g.fixtureLoaded === true &&
          s(g.e2e?.childPrompts) === s(["SUMMARIZE:alpha beta gamma"]) &&
          s(g.e2e?.childModels) === s(["regr-x"]) &&
          e2eTool.summary === "ALPHA BETA GAMMA SUMMARY" &&
          e2eTool.model === "served-x-real" &&
          e2eTool.usage?.inputTokens === 21 &&
          g.e2e?.childThread === "plugin:regr-tidy:tidy" &&
          g.e2e?.childTool === "none",
        s(g.e2e),
      ),
      assert(
        "★★⑧ 원 요구의 첫 사례 모양(웹검색) — **홈에 설치한** 플러그인이 선언한 호스트로 `host.fetch`(검색·본문, 격리 대역) → 읽은 본문만 지정 프로필 모델에 → 출처를 «읽음 / 결과만» 으로 갈라 돌려준다(종전엔 홈 플러그인의 `host.fetch` 가 선언과 무관하게 늘 거절됐다)",
        searchOk(g.e2eSearch),
        s(g.e2eSearch).slice(0, 300),
      ),
      assert(
        "★★⑧ 부모 턴 취소가 **도구 안의 `ask`** 까지 닿는다 — 자식 어댑터 신호가 끊기고 도구는 `cancelled` 로 답한다",
        g.e2eCancel?.toolOut2 === "ERR:FAIL:cancelled" && g.e2eCancel?.childAbortedAtEnd === true,
        s(g.e2eCancel),
      ),
      assert(
        "★★⑧ SDK 형(`getMcpServer`) 플러그인 경로도 같다 — 지정 프로필로 돌고, 부모 취소가 도구 안 `ask` 까지 닿고, `host.turn` 은 좌표 셋뿐",
        g.e2eMcp?.mcpOk === "OK|channel,target,threadKey" &&
          String(g.e2eMcp?.mcpCancel ?? "").startsWith("FAIL:cancelled|") &&
          g.e2eMcp?.childAbortedAtEnd === true,
        s(g.e2eMcp),
      ),
      assert(
        "★⑧ 내부 취소 신호가 `host.turn` 에 안 샌다 — 플러그인이 보는 좌표는 셋뿐(직렬화 계약)",
        g.e2e?.turnKeys === "channel,target,threadKey",
        String(g.e2e?.turnKeys),
      ),
      assert(
        "★⑨ `plugin:` 좌표는 사람의 대화가 아니다 — 대화 판정 false · 파생 판정 true · 세션 목록 조건에서 빠진다(일반 세션은 남는다)",
        g.prefix?.userConvo === false && g.prefix?.derived === true && s(g.prefix?.visiblePlugin) === s([]) && g.prefix?.visibleDashboard === true,
        s(g.prefix),
      ),
      assert(
        "⑨ 30일 넘게 안 쓴 `plugin:` 행은 정리되고 최근 행은 남는다",
        s(g.prefix?.leftAfterPrune) === s(["plugin:a:recent"]),
        s(g.prefix?.leftAfterPrune),
      ),
    ];
  },
};
