/**
 * 회귀: **죽은 값 export 0** (2026-07-29).
 *
 * 사고: `getInProcessMcpServers` 가 아무도 안 부르는데 남아 있었고, 그 안의 MCP 도구 이름
 * 목록이 진짜 목록과 갈라져 있었다(6 vs 5). 죽은 코드는 그 자체로는 무해해 보이지만
 * **틀린 채로 늙는다** — 아무도 안 부르니 아무도 안 고친다. 실제로 그 드리프트가 "MCP 도구
 * 상세를 못 보여주는" 증상의 배경이었다.
 *
 * 전수 조사(2026-07-29): 값 export 중 **어디서도 참조되지 않는 것 12건**(278줄). 대부분
 * "외부 import 보호"·"나중에 쓸지 몰라서" 로 남은 것이었고, `plugins/channels.ts`·
 * `plugins/observers.ts` 는 통합 로더로 대체된 뒤 **파일째** 살아남아 있었다. 전부 제거해
 * baseline 을 0 으로 만들었으므로, 이제 allowlist 없이 "0건" 자체를 불변식으로 지킬 수 있다
 * (allowlist 를 두면 그것이 또 하나의 손으로 관리하는 목록이 된다 — 오늘 내내 없앤 구조).
 *
 * 판정 기준(오탐 최소화):
 *  - **값 export 만**(const/function/class). type·interface 는 문서 가치가 있고 harm 0.
 *  - 다른 src 파일 / plugins / packages / skills / agents 어디에도 이름이 안 나오고,
 *  - **자기 파일 안에서도** 선언 1회뿐인 것(자기 파일에서 쓰이면 죽은 코드가 아니라
 *    export 만 불필요한 것 — 별개 문제라 여기서 안 잡는다).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const walkTs = (dir: string, out: string[]): void => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
};

const readAll = (dir: string, out: string[]): void => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) readAll(p, out);
      else if (/\.(ts|js|md|json)$/.test(p)) out.push(readFileSync(p, "utf8"));
    } catch {
      /* 읽기 실패 파일은 건너뛴다(판정에 불리하게=오탐 쪽으로 가지 않음). */
    }
  }
};

const EXPORT_RE = /^export (?:const|function|async function|class) ([A-Za-z_$][\w$]*)/gm;

/** 레포 루트(cwd 무관 — 다른 검사들과 동형으로 import.meta.url 기준). */
const repoRoot = (): string => new URL("../../../", import.meta.url).pathname;

/**
 * 이 트리에서 판정이 성립하는가.
 *
 * ★public 트리에서 false red 가 났다 (2026-07-29, 실제 CI 실패): sync 가 `src/scripts/
 *  {verify-,e2e-,probe-}*` 와 `bench/` 를 스크럽하는데, `__resetPathsCache`·
 *  `pendingThreadCount` 의 **유일한 소비자가 그 스크럽된 스크립트들**이라 배포 트리에서만
 *  죽은 것으로 보였다. dev 는 0건, public 은 2건 — 같은 코드에 다른 판정.
 *  이 게이트의 목적은 **dev 레포를 깨끗이 유지**하는 것이므로, 소비자 절반이 없는 트리에선
 *  판정하지 않는다. 단 조용히 통과하지 않고 **그 사실을 got 에 남긴다**(무음 통과 금지).
 */
const devToolingPresent = (root: string): boolean => {
  try {
    return readdirSync(join(root, "src/scripts")).some((f) => f.startsWith("verify-"));
  } catch {
    return false;
  }
};

const findDead = (): string[] => {
  const files: string[] = [];
  walkTs(join(repoRoot(), "src"), files);
  const src = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const extra: string[] = [];
  for (const d of ["plugins", "packages", "skills", "agents"]) {
    try {
      readAll(join(repoRoot(), d), extra);
    } catch {
      /* 없으면 무시 */
    }
  }
  const dead: string[] = [];
  for (const [f, code] of src) {
    for (const m of code.matchAll(EXPORT_RE)) {
      const name = m[1] ?? "";
      if (name === "") continue;
      const re = new RegExp(`\\b${name}\\b`);
      let used = false;
      for (const [g, other] of src) {
        if (g !== f && re.test(other)) {
          used = true;
          break;
        }
      }
      if (!used) for (const o of extra) if (re.test(o)) { used = true; break; }
      if (used) continue;
      const selfHits = (code.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
      if (selfHits <= 1) dead.push(`${f}:${name}`);
    }
  }
  return dead;
};

export const check: RegressionCheck = {
  name: "dead-exports",
  guards: "아무도 안 부르는 코드가 남아 틀린 채로 늙던 것(도구 목록 드리프트의 배경)",
  run: async (): Promise<Assertion[]> => {
    const root = repoRoot();
    // ★fail-loud: 소스를 아예 못 찾으면 통과가 아니라 실패다. 종전엔 cwd 가 레포 밖이면
    //  catch → 빈 배열 → "0건" 으로 **진짜 통과와 구분 불가**하게 초록이 떴다(무음 통과).
    let dead: string[];
    try {
      dead = findDead();
    } catch (e) {
      return [
        assert("소스 트리를 찾을 수 있다", false, e instanceof Error ? e.message : String(e)),
      ];
    }
    if (!devToolingPresent(root)) {
      return [
        assert(
          "판정 생략 — dev 전용 스크립트가 없는 트리(배포본)",
          true,
          "스크럽된 트리라 소비자 절반이 없다 — dev 레포에서 판정한다",
        ),
      ];
    }
    return [
      assert(
        "★죽은 값 export 0건",
        dead.length === 0,
        dead.length === 0 ? "0건" : dead.slice(0, 8).join(" / "),
      ),
    ];
  },
};
