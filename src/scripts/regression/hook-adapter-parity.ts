/**
 * 회귀: **훅은 어느 LLM 으로 돌든 똑같이 동작한다** (원칙 #2, 2026-08-07).
 *
 * `settings.json` 에 훅 블록 하나를 쓰면 claude·codex·openai 어디서 턴이 돌든 같은 훅이
 * 돌아야 한다 — README 가 사용자에게 그렇게 약속한다("그 *같은* 설정이 anthropic·codex·
 * openai 어디서 턴이 돌든 똑같이 동작한다").
 *
 * ★그런데 그걸 지키는 검사가 없었다. 어느 한 어댑터에 훅 호출을 빠뜨려도 **아무것도 안
 *  운다** — 그 어댑터를 쓰는 사용자만 조용히 훅이 안 도는 상태가 된다. 같은 부류를 오늘만
 *  두 번 봤다(서브에이전트 도구 이름이 네 곳에서 갈림 · 세션 도구를 codex 소비처 4곳 중
 *  3곳에 빠뜨림). **어댑터가 셋이면 배선은 셋 다 확인해야 한다.**
 *
 * ★이름 목록을 만들지 않는다([[hand-maintained-lists]]). 검사하는 건 **대칭**이다:
 *  ①세 어댑터가 부르는 훅 함수 **집합이 서로 같다** — 새 도구 훅이 생겨도 목록 수정 0.
 *  ②턴·서브에이전트 훅은 **어댑터 밖**(공통층)에 있다 — 어댑터로 내려가면 그 순간 3중
 *   구현이 되고 갈라진다.
 *  ③hook-runner 가 내보낸 훅 함수는 **전부 어딘가에서 소비된다** — 선언만 있고 아무도 안
 *   부르는 훅은 "있다고 문서에 적힌 죽은 기능"이다.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ADAPTERS = [
  "claude-agent-sdk.ts",
  "openai-codex-oauth.ts",
  "openai-agents-sdk.ts",
] as const;

const hooksIn = (src: string): Set<string> =>
  new Set(src.match(/run[A-Za-z]+Hooks/g) ?? []);

/** import 줄·주석을 뺀 **실제 호출**만 — import 만 있고 안 부르면 파리티가 아니다. */
const calledIn = (src: string): Set<string> => {
  const out = new Set<string>();
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t.startsWith("import") || t.startsWith("//") || t.startsWith("*")) continue;
    for (const m of line.match(/run[A-Za-z]+Hooks\s*\(/g) ?? []) {
      out.add(m.replace(/\s*\($/, ""));
    }
  }
  return out;
};

export const check: RegressionCheck = {
  name: "hook-adapter-parity",
  guards:
    "어느 한 어댑터에만 훅 호출이 빠져 그 모델로 돌 때만 훅이 조용히 안 돌던 것 + 죽은 훅",
  run: async (): Promise<Assertion[]> => {
    const runner = await readFile(
      path.join(REPO, "src/core/entry/hook-runner.ts"),
      "utf8",
    );
    const exported = new Set(
      (runner.match(/export const (run[A-Za-z]+Hooks)/g) ?? []).map((m) =>
        m.replace("export const ", ""),
      ),
    );

    const perAdapter = new Map<string, Set<string>>();
    for (const a of ADAPTERS) {
      const src = await readFile(
        path.join(REPO, "src/core/llm-runtime/adapters", a),
        "utf8",
      );
      perAdapter.set(a, calledIn(src));
    }
    const sets = [...perAdapter.values()].map((s) => [...s].sort().join(","));
    const symmetric = sets.every((s) => s === sets[0]) && (sets[0] ?? "") !== "";

    // ②턴·서브에이전트 훅은 어댑터 밖. 어댑터가 부르지 **않는** 것들이 그 대상이다.
    const inAdapters = new Set(sets[0] === undefined ? [] : sets[0].split(","));
    const shouldBeShared = [...exported].filter((h) => !inAdapters.has(h));
    // ③전부 소비되는가 — src 전역에서 호출 여부를 센다(hook-runner 자신 제외).
    const unconsumed: string[] = [];
    const walk = async (dir: string, acc: string[]): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          // ★**basename 으로 거른다** — 종전엔 전체 경로에 `/node_modules|dist/` 를 대서,
          //  레포가 이름에 `dist` 가 든 디렉터리 아래 있으면(예: 릴리스 §7 이 쓰던
          //  `/tmp/tiguclaw-dist-check.XXXX`) **트리 전체가 스킵**돼 «소비처 0» 이라는
          //  거짓 빨강이 났다(2026-09-01 실측: 클린룸 2건 빨강, 경로만 바꾸니 초록).
          if (!/^(node_modules|dist)$/.test(e.name)) await walk(p, acc);
        } else if (e.name.endsWith(".ts") && !p.endsWith("hook-runner.ts")) {
          acc.push(await readFile(p, "utf8"));
        }
      }
    };
    const files: string[] = [];
    await walk(path.join(REPO, "src"), files);
    const allCalls = new Set<string>();
    for (const f of files) for (const h of calledIn(f)) allCalls.add(h);
    for (const h of exported) if (!allCalls.has(h)) unconsumed.push(h);

    return [
      assert(
        "★세 어댑터가 부르는 훅 집합이 같다(하나만 빠져도 그 모델에서만 훅이 죽는다)",
        symmetric,
        [...perAdapter]
          .map(([a, s]) => `${a.replace(".ts", "")}={${[...s].sort().join(" ")}}`)
          .join(" · "),
      ),
      assert(
        "턴·서브에이전트 훅은 어댑터 밖 공통층에 있다(3중 구현 0)",
        shouldBeShared.length > 0 &&
          shouldBeShared.every((h) => allCalls.has(h)),
        `공통층: ${shouldBeShared.join(", ") || "(없음)"}`,
      ),
      assert(
        "★선언된 훅이 전부 소비된다(문서에만 있는 죽은 훅 0)",
        unconsumed.length === 0,
        unconsumed.length === 0
          ? `${exported.size}종 전부 소비`
          : `★소비처 없음: ${unconsumed.join(", ")}`,
      ),
    ];
  },
};
