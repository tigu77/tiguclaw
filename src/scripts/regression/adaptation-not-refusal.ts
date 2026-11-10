/**
 * 회귀: **「없어서 못 합니다」로 끝내지 않는다** — 적응은 능력이 아니라 태도다 (2026-08-18).
 *
 * 사용자 지정: *"환경에 없더라도 무한 적응도 티구클로가 가져야 할 부분인 거야."*
 *
 * 사고: claude 백엔드에 PDF 를 첨부했더니 **"PDF 리더가 없어서 읽을 수 없다"** 로 끝났다.
 * 능력 습득 넛지는 있었지만 가리키는 길이 셋 다 **티구클로 내부**였다 — 새 스킬(`harness`),
 * 외부 도구 연결(`add_mcp_server`), 외부 앱 호출(`register_endpoint`). **"환경에 없는
 * 프로그램·라이브러리를 설치한다"** 는 어디에도 없었다. Bash 를 들고 있으면서 `brew install
 * poppler` 가 정당한 경로라고 말해주는 문장이 없었고, 그래서 막힌 자리에서 멈췄다.
 *
 * ★이 검사가 지키는 것은 **문구의 존재**지 행동이 아니다. 산문 지침이라 "모델이 실제로
 *  제안하는가" 는 스위트가 못 잰다(그건 실사용에서만 보인다). 그러니 등급은 낮다 —
 *  **누가 이 문장을 지웠을 때 알려주는 것**이 전부다. 그 이상을 하는 척하지 않는다
 *  ([[feedback_gate_must_actually_run]]: 지키지도 못하면서 지킨다고 적어둔 검사가 가장 나쁘다).
 *
 * ★그래도 **렌더된 프롬프트**를 본다(소스 grep 아님). 프롬프트가 어디서 어떻게 조립되든
 *  모델에게 실제로 가는 결과물이 대상이다 — `shipped-prompt-has-no-dev-only` 와 같은 방식.
 *
 * ★자리: 어댑터 sysprompt 한 곳이다. SYSTEM.md 에 **같이 적지 않는다** — 그 둘은 SYSTEM.md
 *  §4 가 명시하듯 "모든 설치본에 같은 배포본" 인 **동급 층**이라, 양쪽에 적으면 같은 판단이
 *  두 곳이 된다(그리고 둘은 반드시 갈린다).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const ADAPTERS = [
  "claude-agent-sdk.ts",
  "openai-agents-sdk.ts",
  "openai-codex-oauth.ts",
] as const;

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const { REGION_A_SYSTEM_PROMPT } = await import(
    "../../core/llm-runtime/adapters/_shared-sysprompt.js"
  );
  const prompt = String(REGION_A_SYSTEM_PROMPT);

  out.push(
    assert(
      "프롬프트가 실제로 렌더된다(빈손 통과 금지)",
      prompt.length > 2000,
      `${prompt.length}자`,
    ),
  );
  if (prompt.length === 0) return out;

  // ── ① 막혔을 때 **멈추지 말라**고 말한다 ────────────────────────────────────
  //  ★공유 프롬프트는 메인·매니저·서브 **모든 칸**에 간다 — 이 태도는 칸과 무관하다.
  out.push(
    assert(
      "★「없어서 못 합니다」로 끝내지 말라고 지시한다(모든 칸 공유 프롬프트)",
      /「없어서 못 합니다」로 끝내지/.test(prompt) && /정말 길이 없을 때만/.test(prompt),
      /없어서 못 합니다/.test(prompt) ? "지시 확인" : "★그 문장이 사라졌다",
    ),
  );

  // ── ② 갖추는 경로가 **환경까지** 뻗는다 ─────────────────────────────────────
  //  내부 습득(스킬·MCP·엔드포인트)만 있으면 이번 사고가 그대로 재발한다. 바깥 고리
  //  (그 기계에 프로그램을 설치)가 목록에 있어야 한다.
  out.push(
    assert(
      "★습득 경로가 환경 구비(패키지 설치)까지 포함한다",
      /패키지 매니저 설치/.test(prompt),
      /패키지 매니저/.test(prompt) ? "환경 고리 확인" : "★내부 습득만 남았다",
    ),
  );

  // ── ②-b 내부 습득 도구는 **그 도구가 닿는 칸의 조립본**에서 본다 (2026-11-10 지침 통합 후속) ──
  //  종전엔 공유 프롬프트에 `add_mcp_server`·`register_endpoint`·`run_in_background` 를 적게 했는데,
  //  그 셋은 REACH 상 메인 전용이라 매니저·서브는 **없는 도구를 쓰라는 지시**를 받았다. 이름의
  //  자리는 공유 프롬프트가 아니라 메인 칸 헌법(`scopeConstitution(…, "main")`)이다.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { scopeConstitution } = await import("../../core/constitution-scope.js");
  const { reaches } = await import("../../core/llm-runtime/capability-reach.js");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const constitution = readFileSync(path.join(repo, "SYSTEM.md"), "utf8");
  const scoped = (k: "main" | "manager" | "subagent"): string => {
    const s = scopeConstitution(constitution, k);
    return `${prompt}\n${s.body}\n${s.roleExtra}`;
  };
  const mainView = scoped("main");
  const MAIN_ONLY = [
    { tool: "add_mcp_server", cap: "mcp-admin" },
    { tool: "register_endpoint", cap: "endpoints" },
    { tool: "run_in_background", cap: "workers" },
  ] as const;
  out.push(
    assert(
      "내부 습득 경로(harness 스킬·add_mcp_server·register_endpoint)가 메인 칸 조립본에 있다",
      // ★`harness:harness` 는 **안 풀리는 이름**이었다(콜론 이름 스킬 0개) — 실재하는 이름으로 본다.
      /`harness` 스킬/.test(mainView) && mainView.includes("add_mcp_server") && mainView.includes("register_endpoint"),
      "harness · add_mcp_server · register_endpoint (main 조립)",
    ),
  );
  const leaked = MAIN_ONLY.filter((t) => prompt.includes(t.tool));
  // 목록이 표와 갈리면(어느 도구가 매니저까지 닿게 바뀌면) 이 단언부터 다시 봐야 한다 — 표로 묶는다.
  const reachOk = MAIN_ONLY.every((t) => !reaches(t.cap, "manager"));
  out.push(
    assert(
      "★공유 프롬프트(모든 칸)는 메인 전용 도구를 지시하지 않고, 도구 없는 칸은 소환자에게 요청하라고 한다",
      leaked.length === 0 && reachOk && /도구가 없는 역할은 소환자에게 필요한 능력을 요청/.test(prompt),
      { 새는도구: leaked.map((t) => t.tool), 표확인: reachOk },
    ),
  );

  // ── ③ 그러면서 **승인선을 지운 게 아니다** ──────────────────────────────────
  //  "무한 적응" 이 "남의 기계를 마음대로 바꾼다" 가 되면 그건 다른 사고다. 동시에 이미 승인된
  //  범위 안의 일을 다시 묻게 만들지도 않는다 — 새 승인이 필요한 부분만 확인한다.
  out.push(
    assert(
      "★사용자 기계·계정 변경은 새 승인 대상으로 남고, 승인된 범위는 수행하며, 제안은 언제나 한다(적응 ≠ 무단 변경)",
      /기계·계정을 바꾸/.test(prompt) && /새 승인이 필요한 부분만 확인/.test(prompt) &&
        /이미 승인된 작업·권한 안이면 그대로 수행/.test(prompt) && /제안까지는 언제나/.test(prompt),
      "승인선 유지 + 승인 범위 수행 + 제안 의무",
    ),
  );

  // ── ④ LLM 무관 — 세 어댑터가 같은 프롬프트를 쓴다 ───────────────────────────
  //  한 어댑터만 이 태도를 가지면 "백엔드 바꾸니 포기한다" 가 된다(원칙 #2).
  const { readFile } = await import("node:fs/promises");
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../core/llm-runtime/adapters",
  );
  const missing: string[] = [];
  for (const a of ADAPTERS) {
    const src = await readFile(path.join(dir, a), "utf8");
    if (!src.includes("REGION_A_SYSTEM_PROMPT")) missing.push(a);
  }
  out.push(
    assert(
      "★세 어댑터가 모두 이 프롬프트를 싣는다(백엔드를 바꿔도 같은 태도)",
      missing.length === 0,
      missing.length === 0 ? "3/3" : `★빠진 어댑터: ${missing.join(" ")}`,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "adaptation-not-refusal",
  guards:
    "막혔을 때 '없어서 못 합니다'로 끝내던 것 — 능력 습득 넛지가 티구클로 내부(스킬·MCP·엔드포인트)만 가리키고 '환경에 없으면 설치한다'는 없어서, Bash 를 들고도 PDF 를 못 읽는다고 답했다. ★등급: 문구 존재만 지킨다(산문이라 실제 행동은 스위트가 못 잰다)",
  run,
};
