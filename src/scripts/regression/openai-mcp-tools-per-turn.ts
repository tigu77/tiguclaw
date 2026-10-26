/**
 * 회귀: **OpenAI 어댑터에서 턴마다 그 턴의 도구 목록이 실린다** — 같은 프로세스에서 앞선(또는 동시에 도는) 다른 종류의 턴이 남긴 목록이
 * 아니라 (2026-10-26).
 *
 * 사고(2026-10-25 notify_owner 구현 중 발견, `docs/decisions/2026-10-26-openai-mcp-tool-cache.md`): @openai/agents 는
 * `cacheToolsList` 인 MCP 서버의 목록을 프로세스 전역에 서버 이름 키로 둔다. 우리 in-memory 브리지가 그걸 켜 두어, 매니저 턴의 `agents`
 * 목록(`steer_worker` 포함)이 다음 메인 턴에 재사용되고 메인의 `workers.steer_worker` 와 겹쳐 «Duplicate tool names» 로 모델 호출 없이
 * 죽었다. 거꾸로(메인 → 매니저)면 매니저가 `steer_worker` 를 잃었다.
 *
 * 판정: 턴의 **모든 모델 요청**에 실린 도구 정의(이름·설명·스키마)가 새 프로세스에서 그 턴 혼자 돌린 결과와 같다 — ① 한 프로세스에서
 * 매니저 → 메인 → 매니저 → 서브 → 메인 차례로 ② 매니저·메인·서브를 동시에(첫 요청을 서로 기다려 목록 조립이 겹치게). 턴마다 같은 이름의
 * 플러그인 둘을 새 인스턴스로 넣어(도구가 종류마다 다르다 — 하나는 코어와 겹치는 이름이 있어 이름 선점 래퍼로, 하나는 겹침 없이 공유
 * 브리지 그대로) 플러그인의 두 분기도 지난다. 각 턴은 플러그인 도구를 한 번 부른 뒤 답한다(한 턴 안 두 번째 조립).
 * 등급: 동작 검사(실제 어댑터 조립 · 모델 경계에서 본 요청, 모델 호출 0 · 외부 송신 0).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Turn = { which: string; calls: number; pong: boolean; err?: string; reqs: Array<Record<string, string>> };

const runChild = async (seq: string, mode: "seq" | "par"): Promise<Turn[] | string> => {
  const r = await spawnWithin(90_000, `openai-tools-${mode}-${seq}`, ["--import", "tsx", path.join(HERE, "_openai-mcp-tools-per-turn-child.ts"), seq, mode], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIGUCLAW_REGRESSION_NO_LIVE_MODEL: "1" },
  });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("[")).pop();
  return line === undefined ? (r.timedOut ? "timeout" : r.err.slice(-600)) : (JSON.parse(line) as Turn[]);
};

export const check: RegressionCheck = {
  name: "openai-mcp-tools-per-turn",
  guards:
    "OpenAI 어댑터가 MCP 도구 목록을 프로세스 전역(서버 이름 키)에 남겨, 매니저 턴 뒤 메인 턴이 steer_worker 중복으로 모델 호출 없이 죽고 메인 턴 뒤 매니저 턴이 steer_worker 를 잃던 것(플러그인·동시 턴·턴 안 두 번째 요청 포함)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const [main, worker, sub, mixed, par] = await Promise.all([
      runChild("main", "seq"), runChild("worker", "seq"), runChild("sub", "seq"),
      runChild("worker,main,worker,sub,main", "seq"), runChild("worker,main,sub", "par"),
    ]);
    const bad = Object.entries({ main, worker, sub, mixed, par }).filter(([, v]) => typeof v === "string");
    if (bad.length > 0) return [assert("자식이 결과를 낸다", false, JSON.stringify(Object.fromEntries(bad)).slice(0, 800))];
    const solo: Record<string, Turn> = { main: (main as Turn[])[0]!, worker: (worker as Turn[])[0]!, sub: (sub as Turn[])[0]! };
    const count = (req: Record<string, string> | undefined, name: string): number => Object.keys(req ?? {}).filter((n) => n === name).length;
    const out: Assertion[] = [];

    // 전제 — 단독 턴이 두 요청(플러그인 도구 호출 → 답)을 다 지나고, 비교 대상이 실제로 갈린다: 메인·매니저 steer_worker 정확히 하나 ·
    //  플러그인 도구가 종류마다 다르게 실림 · 코어와 겹친 플러그인 read_memory 는 가려져 하나만.
    const pre = Object.fromEntries(Object.entries(solo).map(([k, t]) => [k, {
      calls: t.calls, pong: t.pong, err: t.err, steer: count(t.reqs[0], "steer_worker"), only: count(t.reqs[0], `regr_${k}_only`), only2: count(t.reqs[0], `regr2_${k}_only`), mem: count(t.reqs[0], "read_memory"),
      same2: JSON.stringify(t.reqs[0]) === JSON.stringify(t.reqs[1]),
    }]));
    out.push(assert(
      "전제 — 단독 메인·매니저·서브가 플러그인 도구 호출 뒤 답까지(요청 2) · 메인·매니저 steer_worker 하나 · 두 플러그인(겹침 있음·없음) 도구가 종류마다 다름 · 겹친 read_memory 는 하나",
      Object.entries(pre).every(([k, p]) => p.calls === 2 && p.pong && p.err === undefined && p.only === 1 && p.only2 === 1 && p.mem === 1 && p.same2 && (k === "sub" || p.steer === 1)),
      JSON.stringify(pre),
    ));

    const judge = (turns: Turn[]) => turns.map((t) => {
      const s = solo[t.which]!;
      const diff = [0, 1].flatMap((i) => {
        const a = s.reqs[i] ?? {}, b = t.reqs[i] ?? {};
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((n) => a[n] !== b[n]).map((n) => `${i}:${n}`);
      });
      return { which: t.which, calls: t.calls, pong: t.pong, err: t.err, diff };
    });
    const ok = (rows: ReturnType<typeof judge>, n: number): boolean => rows.length === n && rows.every((r) => r.calls === 2 && r.pong && r.err === undefined && r.diff.length === 0);
    const seqRows = judge(mixed as Turn[]);
    out.push(assert(
      "★한 프로세스에서 매니저→메인→매니저→서브→메인 차례로 — 모든 턴이 모델까지 가고, 두 요청 모두 도구 정의(이름·설명·스키마)가 단독 실행과 같다",
      ok(seqRows, 5),
      JSON.stringify(seqRows),
    ));
    const parRows = judge(par as Turn[]);
    out.push(assert(
      "★한 프로세스에서 매니저·메인·서브를 동시에(첫 요청을 서로 기다려 목록 조립이 겹침) — 두 요청 모두 도구 정의가 단독 실행과 같다",
      ok(parRows, 3),
      JSON.stringify(parRows),
    ));
    return out;
  },
};

export default check;
