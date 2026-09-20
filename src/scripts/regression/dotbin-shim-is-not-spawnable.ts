/**
 * 회귀: **`node_modules/.bin/<도구>` 를 직접 spawn 하지 않는다** (2026-09-20).
 *
 * ★★**맥에선 원리적으로 안 보이는 결함이다.** POSIX 에서 `.bin/tsx` 는 실행 비트가 붙은
 *  셸 스크립트라 그냥 돈다. Windows 에서는 같은 자리에 **확장자 없는 셸 스크립트**가 놓여
 *  있고(실행 가능한 것은 `tsx.cmd`·`tsx.ps1` 이다), `existsSync` 는 **`true`** 를 주는데
 *  `spawnSync` 는 **`ENOENT`** 를 준다. 「있는데 못 쓴다」가 되므로 «부재라 통과» 로도
 *  안 떨어지고 그냥 **빨강**이 된다.
 *
 * ★실측(집 Windows 검증대에서 직접, 고치기 전에):
 * ```
 *   .bin/tsx -e            → status=null  ENOENT      ← 현행
 *   .bin/tsx.cmd -e shell  → status=1     (다른 실패)
 *   node --import tsx -e   → status=0     "__OK__2"   ← 이것만 된다
 *   .bin/tsc --version           → ENOENT
 *   node <typescript/bin/tsc> …  → "Version 5.9.3"
 * ```
 *
 * ★피해: 이 하나가 스위트 **빨강 8건**을 만들었다. 그중 일곱은 «프로브가 실제로 돌았다»
 *  가 실패하는 모양이었는데 **사유가 공란**이라 로그만 보고는 원인을 알 수 없었다 —
 *  그물이 「미검사」를 알리면서 **이유를 못 실은** 것이다. 그래서 여덟 건이 «설명 안 되는
 *  실패» 더미에 한동안 섞여 있었다.
 *
 * ★★**왜 검사인가**: 나는 이 부류를 **여덟 곳에서 각자 고르게** 뒀고, 여덟 곳이 같이
 *  틀렸다. 맥에서 몇 번을 돌려도 초록이라 **볼 방법이 없었다.** 전수를 사람의 기억이
 *  아니라 여기서 한다 — `file-url-not-pathname` 과 같은 자리다.
 *
 * ★등급: **소스 검사**다(실행하지 않는다). 재는 것이 «표현의 유무» 라 이 축에서는 그게
 *  정확한 도구다 — 그 관용구가 다시 들어오면 그 자체가 결함이다.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 검사 대상 — 폴더에서 **유도**한다(손 목록 금지). */
const ROOTS = ["src", "plugins", "packages", "bin", "_workspace"];

const walk = (dir: string, out: string[] = []): string[] => {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith("rt-")) continue;
      walk(full, out);
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".mts") || e.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
};

// ★★**«조립» 이 아니라 «실행» 을 잡는다.** 처음엔 `.bin` 이 보이면 다 잡았는데, 그러면
//  `doctor-survives-broken-install` 의 **픽스처 문자열**(순수 판정 함수에 넣는 가짜 경로)
//  까지 걸린다 — 그건 결함이 아니다. 막아야 하는 것 하나와 **막으면 안 되는 것 하나**를
//  둘 다 골라야 검사가 거짓말을 안 한다.
// ★규칙: 심 경로를 **변수에 담고**, 그 변수를 `spawn*`·`exec*` 의 **첫 인자**로 쓰는 경우만.
//  그게 이 결함의 정확한 모양이다(실행되지 않는 문자열은 Windows 에서도 무해하다).
const ASSIGN = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*(?:["'`]\.bin["'`]|node_modules[/\\]+\.bin)/;
const runsIt = (text: string, name: string): boolean =>
  new RegExp(`(?:spawn|spawnSync|exec|execSync|execFile|execFileAsync|execFileSync)\\(\\s*${name}\\b`).test(text);

export const check: RegressionCheck = {
  name: "dotbin-shim-is-not-spawnable",
  guards:
    // ★문장에 금지 관용구를 그대로 적으면 이 검사가 자기 `guards` 를 첫 위반으로 잡는다
    //  (`file-url-not-pathname` 에서 실제로 그랬다). 자기 파일을 예외로 빼는 대신 문장을 바꾼다.
    "패키지 심(shim) 폴더의 확장자 없는 도구를 직접 spawn 해 Windows 에서 ENOENT 가 나던 것 — " +
    "맥에선 같은 파일이 그냥 돌아서 **원리적으로 안 보이고**, 실측에서 스위트 빨강 8건의 뿌리였다 " +
    "(그중 일곱은 사유가 공란이라 로그만으로는 원인이 안 보였다)",
  run: (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const files = ROOTS.flatMap((r) => walk(path.join(repoRoot, r)));

    out.push(
      assert(
        "★스캐너의 눈이 살아 있다 — 파일이 실제로 모인다(0이면 아래는 공짜 초록)",
        files.length > 200,
        `${String(files.length)}개 파일 · 루트 ${ROOTS.join("·")}`,
      ),
    );

    const bad: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const [i, line] of text.split("\n").entries()) {
        // ★**그 패턴을 «설명하는 글» 은 세지 않는다** — 주석이 인용하는 것은 정상이다.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
        const m = ASSIGN.exec(code);
        if (m !== null && runsIt(text, m[1])) {
          bad.push(`${path.relative(repoRoot, f)}:${String(i + 1)} (${m[1]})`);
        }
      }
    }
    out.push(
      assert(
        "★★심 폴더의 도구를 **변수에 담아 실행하지 않는다** — Windows 에서 ENOENT 다",
        bad.length === 0,
        bad.length === 0
          ? `검사한 파일 ${String(files.length)}개 · 위반 0 (node 로 JS 엔트리를 돌린다)`
          : `★위반 ${String(bad.length)}곳: ${bad.slice(0, 8).join(" · ")}`,
      ),
    );

    // ★반대 방향 — 정상 용법까지 잡으면 그것도 결함이다.
    const legit = [
      "const realConnect = inst.connect.bind(inst);",
      'const cmd = "/opt/tiguclaw/node_modules/.bin/tiguclaw";   // 픽스처 — 실행 안 한다',
      'const t = path.join(REPO, "node_modules", "typescript", "bin", "tsc");',
    ];
    const legitText = `${legit.join("\n")}\nspawnSync(process.execPath, [t]);`;
    const legitCaught = legit.filter((l) => {
      const m = ASSIGN.exec(l);
      return m !== null && runsIt(legitText, m[1]);
    });
    out.push(
      assert(
        "★반대 방향 — `.bind()` · **실행 안 하는 픽스처 경로** · JS 엔트리는 **안 잡는다**",
        legitCaught.length === 0,
        legitCaught.length === 0
          ? "`.bind()` · 실행 안 하는 픽스처 경로 · node 로 도는 JS 엔트리 — 셋 다 안 잡는다"
          : `★오탐 ${String(legitCaught.length)}건: ${legitCaught.join(" · ")}`,
      ),
    );

    return Promise.resolve(out);
  },
};
