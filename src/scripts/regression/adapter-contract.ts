/**
 * 회귀: **어댑터 행동 계약 — 같은 상황에 세 어댑터가 같게 동작한다** (2026-10-18, 정태님 «능력 비대칭 검토도 자동으로 · 뒤늦게 알게 되니»).
 *
 * ★왜: OpenAI 어댑터가 취소를 «빈 성공» 으로 돌려주던 결함이 오래 살아 있었다 — 어댑터마다 자기 검사만 있었고 `*-parity` 검사는
 *  «배선이 있다» 는 글자만 봤다. 여기선 시나리오를 추상 대본으로 **한 번** 적고(`_adapter-contract-child.ts`), Codex(가짜 네트워크)·
 *  Claude(가짜 SDK 질의)·OpenAI(주입한 가짜 Model)에 **같은 대본**을 돌려 결과를 나란히 본다. 시나리오를 더하면 세 어댑터에 자동으로 걸린다.
 * ★어댑터 단독 + facade(`runRegionA`) 두 경로 — 사용자가 겪는 것은 facade 까지 거친 결과다.
 * ★계약은 «내부 구현이 같다» 가 아니라 «사용자가 겪는 결과가 같다» 다(아스트라 회신: 동등성 = 같은 작업·중단·기억·계측 계약).
 *
 * 지금 계약: 취소·시한(2026-10-18 OpenAI P1) · 원격 MCP 도구 호출(같은 날). 다음 단계(사용량·이력)를 고칠 때 그 계약을 여기에 더한다.
 * 등급: **동작** — 어댑터×시나리오×경로 하나 = 자식 프로세스 하나.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "_adapter-contract-child.ts");
const ADAPTERS = ["codex", "claude", "openai"] as const;
type U = { inputTokens?: number; outputTokens?: number; cachedTokens?: number; inputTokensTotal?: number; outputTokensTotal?: number; cachedTokensTotal?: number; iterations?: number };
type J = { usage?: U; outcome?: string; name?: string; text?: string; events?: string[]; message?: string; remoteCalls?: Array<{ text: string; hdr: string }>; cli?: { configHasSecret: boolean; blocksCliAuth: boolean } };

const child = async (adapter: string, scenario: string, via: "adapter" | "facade"): Promise<J> => {
  const argv = ["--import", "tsx", CHILD, adapter, scenario, ...(via === "facade" ? ["facade"] : [])];
  const r = await spawnWithin(60_000, `contract(${adapter},${scenario},${via})`, argv, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  if (r.timedOut) return { outcome: "timeout" };
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  try {
    return line === undefined ? { outcome: "no-output", message: r.err.slice(-200) } : (JSON.parse(line) as J);
  } catch {
    return { outcome: "bad-json" };
  }
};

/** 결과 한 칸 — 사람이 읽는 요약(어긋난 어댑터가 바로 보이게). */
const cell = (j: J): string =>
  j.usage !== undefined && j.text?.startsWith("결과 ") ? `usage:${[j.usage.inputTokens, j.usage.outputTokens, j.usage.cachedTokens].join("/")}|${[j.usage.inputTokensTotal, j.usage.outputTokensTotal, j.usage.cachedTokensTotal].join("/")}|it=${j.usage.iterations}` :
  j.outcome === "returned" ? `ok:${j.text ?? ""}${j.events?.includes("llm.turn_done") ? "+done" : ""}${j.remoteCalls !== undefined ? ` 서버=${JSON.stringify(j.remoteCalls)}` : ""}${j.cli !== undefined ? ` cli=${JSON.stringify(j.cli)}` : ""}` : `${j.outcome}:${j.name ?? j.message ?? ""}${j.events?.includes("llm.turn_done") ? "+done" : ""}`;

/** 시나리오별 계약 — 기대하는 사용자 결과(세 어댑터 공통). */
const CONTRACTS: Array<{ scenario: string; title: string; ok: (j: J, via: "adapter" | "facade") => boolean }> = [
  { scenario: "complete", title: "정상 완료 — 답을 돌려주고, facade 는 turn_done 을 남긴다(대조군)",
    ok: (j, via) => j.outcome === "returned" && j.text === "끝" && (via === "adapter" || (j.events ?? []).includes("llm.turn_done")) },
  { scenario: "abort-before-output", title: "★첫 출력 전 /stop — 사용자 취소로 올라오고 성공 기록이 없다",
    ok: (j) => j.outcome === "threw" && j.name === "UserCancelledError" && !(j.events ?? []).includes("llm.turn_done") },
  { scenario: "abort-mid-text", title: "★텍스트 중 턴 시한 — 시한 에러로 올라오고 부분 텍스트가 성공 답이 되지 않는다",
    ok: (j) => j.outcome === "threw" && j.name === "TurnTimeoutError" && !(j.events ?? []).includes("llm.turn_done") },
  { scenario: "pre-aborted", title: "★이미 취소된 턴 — 사용자 취소로 올라온다",
    ok: (j) => j.outcome === "threw" && j.name === "UserCancelledError" && !(j.events ?? []).includes("llm.turn_done") },
  // ★원격 MCP(2026-10-18 정태님 «어댑터 공통으로 다 적용된 거야? · 제대로 검증을»). 실제 HTTP 서버 — Codex·OpenAI 는 우리 브리지가,
  //  Claude 는 CLI 가 붙는다(가짜 CLI 가 어댑터가 넘긴 설정만으로 붙는다). 설정은 `${VAR}` 로 적고 헤더까지 서버에 닿아야 한다.
  { scenario: "remote-tool", title: "★원격(HTTP) MCP 도구 — 서버가 헤더와 함께 정확히 한 번 받고, 그 결과가 모델에 돌아와 답이 된다",
    ok: (j) => j.outcome === "returned" && j.text === "결과 echo:ping-1:hdr-ok" &&
      JSON.stringify(j.remoteCalls ?? []) === JSON.stringify([{ text: "ping-1", hdr: "hdr-ok" }]) &&
      // Claude 만: CLI 명령줄로 가는 설정에 헤더 값이 없고(환경변수 참조), CLI 자체 로그인 도구가 막혀 있다(적대 검토 P2-3·P2-4).
      (j.cli === undefined || (!j.cli.configHasSecret && j.cli.blocksCliAuth)) },
  // ★사용량 — 같은 숫자가 아니라 **같은 의미**(아스트라 회신 Q5 · OpenAI 동등성 감사 7번). 요청마다 «입력(캐시 포함)·캐시 읽기·출력» 을
  //  각 공급자 형식으로 넣고(Anthropic 은 캐시를 뺀 입력을 준다), 계약(types.ts): inputTokens·outputTokens·cachedTokens = **마지막 호출 1회** ·
  //  *Total = 턴 합계 · iterations = 호출 수(2 이상). 공급자가 준 것만 — 관측 못 한 값을 0 으로 꾸미지 않는다.
  { scenario: "usage-two-calls", title: "★사용량 — 마지막 호출(150/20/캐시120)과 턴 합계(250/30/캐시160)를 같은 의미로 돌려준다",
    ok: (j) => j.outcome === "returned" && j.usage !== undefined &&
      j.usage.inputTokens === 150 && j.usage.outputTokens === 20 && j.usage.cachedTokens === 120 &&
      j.usage.inputTokensTotal === 250 && j.usage.outputTokensTotal === 30 && j.usage.cachedTokensTotal === 160 && j.usage.iterations === 2 },
];

export const check: RegressionCheck = {
  name: "adapter-contract",
  guards: "같은 상황에 어댑터마다 다르게 동작하던 것(OpenAI 만 취소가 빈 성공) — 어댑터별 검사만 있고 같은 대본을 셋에 던지는 그물이 없었다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const jobs: Array<{ key: string; run: () => Promise<J> }> = [];
    for (const c of CONTRACTS) for (const a of ADAPTERS) for (const via of ["adapter", "facade"] as const) {
      jobs.push({ key: `${c.scenario}|${a}|${via}`, run: () => child(a, c.scenario, via) });
    }
    // 동시 6개 — 자식마다 tsx 부팅이 무겁다.
    const res = new Map<string, J>();
    for (let i = 0; i < jobs.length; i += 6) {
      const batch = jobs.slice(i, i + 6);
      for (const [k, v] of await Promise.all(batch.map(async (j) => [j.key, await j.run()] as const))) res.set(k, v);
    }
    const out: Assertion[] = [];
    for (const c of CONTRACTS) {
      for (const via of ["adapter", "facade"] as const) {
        const row = Object.fromEntries(ADAPTERS.map((a) => [a, res.get(`${c.scenario}|${a}|${via}`) ?? {}]));
        out.push(assert(`${c.title} — ${via === "facade" ? "facade" : "어댑터"} · 세 어댑터`,
          ADAPTERS.every((a) => c.ok(row[a]!, via)),
          ADAPTERS.map((a) => `${a}=${cell(row[a]!)}`).join(" · ")));
      }
    }
    return out;
  },
};
