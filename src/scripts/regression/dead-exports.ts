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
 *  - 정의는 `src/`·`plugins/` 의 `.ts` 를 본다.
 *  - 다른 **코드 파일**(src·plugins·packages·bin 의 ts/js/mjs, 주석 제거) 어디에도 이름이 안 나오고,
 *  - **자기 파일 안에서도** 선언 1회뿐인 것(자기 파일에서 쓰이면 죽은 코드가 아니라
 *    export 만 불필요한 것 — 별개 문제라 여기서 안 잡는다).
 *
 * ★사각을 막았다 (2026-10-16 효율 감사 — 이 검사가 초록인 채로 죽은 export 7건이 살아 있었다):
 *  - 정의를 `src/` 만 봐서 **`plugins/` 의 export 는 검사 대상이 아니었다**(`getSchedulerInstance` 등).
 *  - 이름이 **주석·문서(md)** 에 나와도 «쓰임» 이었다(`dedupeBySource` 는 주석 6곳에만 남아 있었다).
 *  - 다른 파일이 **같은 이름을 따로 선언**해도 «쓰임» 이었다(`isBuiltRuntime` — self-update 에 동명 비공개 함수).
 *  안 쓰는 지역·import 는 **TS 파일에 한해** 컴파일러(`noUnusedLocals`, `tsconfig.check.json`)가 맡는다 — 여기선 export 만 본다.
 *  `bin/daemon.mjs`·대시보드 클래식 스크립트(js/*.js)의 안 쓰는 지역은 그물 밖이다(효율 감사 §9 가 사람 눈으로 본다).
 *  알려진 미탐: 다른 파일의 **문자열·정규식 리터럴** 안 언급도 «쓰임» 으로 센다(주석만 뗀다).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { stripComments } from "./_wiring.js";
import { fileURLToPath } from "node:url";

const walkTs = (dir: string, out: string[]): void => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
};

/** 코드 파일만(문서·설정의 언급은 쓰임이 아니다) — 주석을 뗀 본문. `node_modules`·`dist` 는 안 본다. */
const readCode = (dir: string, out: Map<string, string>): void => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) readCode(p, out);
      else if (/\.(ts|js|mjs|cjs)$/.test(p)) out.set(p, stripComments(readFileSync(p, "utf8")));
    } catch {
      /* 읽기 실패 파일은 건너뛴다(판정에 불리하게=오탐 쪽으로 가지 않음). */
    }
  }
};

const EXPORT_RE = /^export (?:const|function|async function|class) ([A-Za-z_$][\w$]*)/gm;

/** 레포 루트(cwd 무관 — 다른 검사들과 동형으로 import.meta.url 기준). */
const repoRoot = (): string => fileURLToPath(new URL("../../../", import.meta.url));

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
  const defs: string[] = [];
  for (const d of ["src", "plugins"]) walkTs(join(repoRoot(), d), defs);
  const code = new Map<string, string>();
  for (const d of ["src", "plugins", "packages", "bin"]) {
    try {
      readCode(join(repoRoot(), d), code);
    } catch {
      /* 없으면 무시 */
    }
  }
  const dead: string[] = [];
  for (const f of defs) {
    if (f.includes("/node_modules/")) continue;
    const own = code.get(f) ?? stripComments(readFileSync(f, "utf8"));
    for (const m of own.matchAll(EXPORT_RE)) {
      const name = m[1] ?? "";
      if (name === "") continue;
      const re = new RegExp(`\\b${name}\\b`);
      // 같은 이름을 **스스로 선언**한 파일의 언급은 그 파일 자기 것이다(가져다 쓴 게 아니다). 선언은 **줄머리**에서만 센다
      //  (문자열·정규식 안의 글자는 선언이 아니다). 단 import·속성 접근으로 **가져오는** 꼴이 있으면 선언해도 소비자다 —
      //  `const X = (await import("…")).X` · `import { X as Y }` 뒤 `export const X = Y` (적대 검토 10-16 오탐 실측).
      const declares = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var|(?:async\\s+)?function|class)\\s+${name}\\b`, "m");
      const imports = new RegExp(`import\\s*(?:type\\s+)?\\{[^}]*\\b${name}\\b|\\.${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*(?:await\\s+)?import\\(`);
      let used = false;
      for (const [g, other] of code) {
        if (g !== f && re.test(other) && (!declares.test(other) || imports.test(other))) {
          used = true;
          break;
        }
      }
      if (used) continue;
      const selfHits = (own.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
      if (selfHits <= 1) dead.push(`${f.slice(repoRoot().length)}:${name}`);
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
