/**
 * 회귀: **`import.meta.url` 로 파일 경로를 만들 때 `.pathname` 을 쓰지 않는다** (2026-09-19).
 *
 * ★★**맥에선 원리적으로 안 보이는 결함이다.** `new URL("…", import.meta.url).pathname` 은
 *  POSIX 에서 `/Users/…` 라 그대로 통하지만, Windows 에서는 **`/C:/Users/…`** 를 준다.
 *  그걸 `readdir`/`readFile`/`spawn` 에 넣으면 앞의 `/` 때문에 **상대 경로로 취급**돼
 *  **`C:\C:\Users\…`** 가 된다.
 *
 * ★실측(2026-09-19, 집 Windows 검증대): 스위트 **81건 실패** 중 가장 큰 덩어리가 이 하나의
 *  뿌리였다 — `agent-tier-ladder`·`plugin-manifest-kind`·`plugin-off-stays-off`·
 *  `turn-reason-not-borrowed`·`i18n-user-extensible`. ★그중 하나는 던지지도 않고
 *  **«agents:없음» 으로 조용히 빈손**이었다(더 나쁜 얼굴 — 검사가 아무것도 안 보고 통과한다).
 *
 * ★★**왜 검사가 필요한가**: 나는 이 부류를 **한 곳만 고쳤다**(`data-safety` 의 ESM 지정자).
 *  형제 11곳이 남아 있었고, 맥에서 몇 번을 돌려도 초록이라 **볼 방법이 없었다.**
 *  [[feedback_scope_of_a_fix]] 의 «계약변경 → 호출부 전수» 를 안 한 것이고, 그 전수를
 *  사람의 기억이 아니라 **여기서** 한다.
 *
 * ★등급: **소스 검사**다(실행하지 않는다). 다만 재는 것이 «표현의 유무» 라 이 축에서는
 *  그게 정확한 도구다 — `.pathname` 이 다시 들어오면 그 자체가 결함이다.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 레포 루트 — ★이 파일 자신이 그 관용구를 지킨다(`.pathname` 금지). */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 검사 대상 — 배포되는 코드와 개발 스크립트 전부. 폴더에서 **유도**한다(손 목록 금지). */
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
    // ★`rt-*` 는 적대 검토가 만든 **트리 사본**이다 — 원본을 고치면 같이 사라지므로 센다면
    //  같은 결함을 두 번 세게 된다. `node_modules`·`dist` 는 우리 코드가 아니다.
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith("rt-")) continue;
      walk(full, out);
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".mts") || e.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
};

export const check: RegressionCheck = {
  name: "file-url-not-pathname",
  guards:
    // ★문장을 이렇게 쓴 이유: 금지 관용구를 **붙여서** 적으면 이 검사가 자기 `guards` 를
    //  첫 위반으로 잡는다(실제로 그랬다). 자기 파일을 예외로 빼는 것은 **제외 목록**이라
    //  더 나쁘다 — 검사는 예외 없이 자기에게도 적용돼야 한다.
    "모듈 URL 의 `.pathname` 을 파일 API 에 넣어 Windows 에서 `C:\\C:\\…` 가 되던 것 — " +
    "맥에선 POSIX 라 그대로 통해서 **원리적으로 안 보이고**, 실측에서 스위트 81건 실패의 가장 큰 뿌리였다 " +
    "(하나는 던지지도 않고 «없음» 으로 조용히 빈손이었다)",
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

    // ★`import.meta.url` 이 얽힌 `.pathname` 만 센다. 다른 URL(http 등)의 `.pathname` 은
    //  정상 용법이라 잡으면 안 된다 — 막아야 할 것 하나와 **막으면 안 되는 것 하나**.
    const bad: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (!text.includes("import.meta.url")) continue;
      for (const [i, line] of text.split("\n").entries()) {
        // ★**그 패턴을 «설명하는 글» 은 세지 않는다** — 주석·문서가 금지 관용구를 인용하는
        //  것은 정상이고, 안 거르면 이 검사 파일 자신이 첫 위반이 된다(실제로 그랬다).
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
        if (/new URL\([^)]*import\.meta\.url\)\s*\.pathname/.test(code)) {
          bad.push(`${path.relative(repoRoot, f)}:${String(i + 1)}`);
        }
      }
    }
    out.push(
      assert(
        "★★`import.meta.url` 경로에 **`.pathname` 을 쓰지 않는다** — Windows 에서 `C:\\C:\\…` 가 된다",
        bad.length === 0,
        bad.length === 0
          ? `검사한 파일 ${String(files.length)}개 · 위반 0 (fileURLToPath 를 쓴다)`
          : `★위반 ${String(bad.length)}곳: ${bad.slice(0, 8).join(" · ")}`,
      ),
    );

    // ── ★★같은 판단의 **반대 방향** — 파일 경로를 ESM 지정자 자리에 넣지 않는다 ──────
    //  ①과 이것은 한 가지 계약의 양면이다: **파일 API 엔 경로, ESM 엔 URL.** 섞으면
    //  Windows 에서만 깨진다 — `C:\…` 의 `C:` 를 Node 가 **스킴**으로 읽어
    //  `ERR_UNSUPPORTED_ESM_URL_SCHEME` 을 던진다. POSIX 절대경로는 그냥 통한다.
    //  ★실측(2026-09-20): 이 부류를 2026-09-19 에 `data-safety` **한 곳만** 고쳤고,
    //   형제 **19곳**이 남아 빨강 여섯을 만들고 있었다. `.bin` 기동 결함에 가려
    //   사유가 공란이었다가, 그걸 걷어내니 그제서야 드러났다 — **뿌리가 둘 겹쳐 있었다.**
    const rawSpec: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const [i, line] of text.split("\n").entries()) {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
        // ★★**«지정자 자리» 만 잡는다.** 처음엔 `JSON.stringify(path.join(…))` 이 보이면
        //  다 잡았는데, `loadPlugins(<디렉터리>)` 처럼 **파일 경로를 넘기는 자리**까지 걸려
        //  맥 회귀 4건이 즉시 빨개졌다 — 내가 그 치환을 실제로 했고 바로 드러났다.
        //  «파일 API 엔 경로, ESM 엔 URL» 이 계약이므로, 검사도 그 구분을 해야 한다.
        if (/(?:\bimport\(|\bfrom\s)\$\{JSON\.stringify\(path\.(?:join|resolve)\(/.test(code)) {
          rawSpec.push(`${path.relative(repoRoot, f)}:${String(i + 1)}`);
        }
      }
    }
    out.push(
      assert(
        "★★ESM 지정자 자리에 **파일 경로를 넣지 않는다** — Windows 에선 `C:` 가 스킴이다",
        rawSpec.length === 0,
        rawSpec.length === 0
          ? `검사한 파일 ${String(files.length)}개 · 위반 0 (pathToFileURL 을 쓴다)`
          : `★위반 ${String(rawSpec.length)}곳: ${rawSpec.slice(0, 8).join(" · ")}`,
      ),
    );

    // ★반대 방향 — 이 검사가 **정상 용법까지** 잡으면 그것도 결함이다.
    const re = /new URL\([^)]*import\.meta\.url\)\s*\.pathname/;
    const legit = [
      'const u = new URL("https://x.test/a/b").pathname;',
      "const p = fileURLToPath(new URL(\"./x.ts\", import.meta.url));",
      "const here = path.dirname(fileURLToPath(import.meta.url));",
    ];
    // ★새 축의 «막으면 안 되는 것» — `pathToFileURL` 을 거친 지정자는 정상이다.
    const legitSpec = [
      "JSON.stringify(pathToFileURL(path.join(repo, rel)).href)",
      'const p = path.join(REPO, "src/store/sessions.ts");   // 파일 API 용 — 지정자 아님',
      // ★막으면 안 되는 것 — **경로 자리**로 넘기는 것은 정상이다(실제로 내가 여기서 틀렸다).
      'const names = await loadPlugins(${JSON.stringify(path.join(REPO, "plugins"))});',
    ];
    const specRe2 = /(?:\bimport\(|\bfrom\s)\$\{JSON\.stringify\(path\.(?:join|resolve)\(/;
    out.push(
      assert(
        "★반대 방향 — 다른 URL 의 `.pathname` · `fileURLToPath` · `pathToFileURL` 지정자는 **안 잡는다**",
        legit.every((l) => !re.test(l)) && legitSpec.every((l) => !specRe2.test(l)),
        [...legit, ...legitSpec].map((l) => `${l.slice(0, 30)}…`).join(" · "),
      ),
    );

    return Promise.resolve(out);
  },
};
