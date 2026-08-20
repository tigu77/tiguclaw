/**
 * `doctor` 가 **설치가 깨진 상태에서도 말을 하는가** (2026-08-20)
 *
 * 잡는 회귀: `doctor.ts` 가 `store/sessions.js` 를 **정적 import** 했고 그건
 * `better-sqlite3` 를 정적 import 한다 — 네이티브가 안 열리면 **모듈 로드 단계에서 throw**
 * 해서 `main()` 이 시작조차 못 했다. 즉 **진단 도구가 가장 필요한 순간에 침묵**했다:
 * 사내 npm 설정(`ignore-scripts=true`)으로 네이티브가 안 깔린 머신에서 데몬은 부팅마다
 * 죽는데(실측 6회 연속), `doctor` 를 쳐도 원시 dlopen 에러 한 줄뿐이라 사용자가 로그를
 * 손으로 보내야 했다(SANTO, 2026-08-19).
 *
 * 그리고 전역 `tiguclaw` 명령 — "특정 머신에서 명령이 안 먹힌다" 는 신고가 있었는데
 * `doctor` 는 그 축을 **아예 안 봤다**(PATH·전역 명령 언급 0회).
 *
 * 등급: **동작 검사** — 판정 함수를 실행한다 + `doctor.ts` 가 store 를 정적으로 끌지
 * 않는지는 소스로 본다(그건 import 그래프라 실행으로 재려면 프로세스를 띄워야 한다).
 */
import { readFile } from "node:fs/promises";
import {
  judgeGlobalCommand,
  probeNativeModule,
  resolveGlobalCommand,
} from "../doctor-install.js";
import { describeNativeLoadFailure } from "../../store/sessions.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "doctor-survives-broken-install",
  guards:
    "네이티브 모듈이 깨진 머신에서 doctor 가 모듈 로드 단계에 같이 죽어 한 줄도 못 찍던 것 + 전역 tiguclaw 명령을 아예 안 보던 것 (2026-08-20)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ★doctor 가 store 를 **정적으로** 끌지 않는다 ─────────────────────────────
    //  이게 이 회귀의 본체다. 정적 import 하나만 되살아나도 깨진 머신에서 doctor 는 다시
    //  침묵한다 — 그리고 그 침묵은 우리 쪽 로그에 안 남으므로 아무도 모른다.
    const src = await readFile(new URL("../doctor.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const staticStoreImports = [...code.matchAll(/^import\s[^;]*?from\s+"\.\.\/store\/[^"]+"/gm)]
      .map((m) => m[0].replace(/\s+/g, " "))
      // `import type` 은 런타임에 사라지므로 무해하다.
      .filter((l) => !/^import type /.test(l));
    out.push(
      assert(
        "★doctor 가 store 를 정적 import 하지 않는다(네이티브 깨지면 로드 단계에서 같이 죽는다)",
        staticStoreImports.length === 0,
        staticStoreImports.length === 0 ? "0건(동적)" : staticStoreImports.join(" | "),
      ),
      assert(
        "네이티브 확인이 store 사용보다 **먼저** 온다",
        code.indexOf("probeNativeModule") > 0 &&
          code.indexOf("probeNativeModule") < code.indexOf('await import("../store/sessions.js")'),
        `probe@${code.indexOf("probeNativeModule")} < store@${code.indexOf('await import("../store/sessions.js")')}`,
      ),
      assert(
        "네이티브가 죽었으면 **거기서 멈춘다**(같은 에러를 아래 섹션이 반복하지 않게)",
        /if \(!native\.ok\) \{[\s\S]{0,400}?return;/.test(code),
        /if \(!native\.ok\)/.test(code) ? "조기 종료 있음" : "★없음",
      ),
    );

    // ── 네이티브 프로브가 **실제로 연다** ────────────────────────────────────────
    //  import 성공만 보면 안 된다 — 바인딩은 첫 인스턴스를 만들 때 열린다.
    const probe = await probeNativeModule();
    out.push(
      assert("정상 설치에선 네이티브 프로브가 통과한다", probe.ok, JSON.stringify(probe).slice(0, 90)),
    );

    // ★**import 는 되는데 바인딩이 안 열리는** 실제 실패 모양 — 이걸 통과시키면
    //  "설치는 성공했는데 못 쓰는" 상태를 정상이라 보고하게 된다(그 머신에서 데몬은
    //  부팅마다 죽는다). 생성자에서 던지는 가짜 모듈로 재현한다.
    const bindingBroken = await probeNativeModule(async () => ({
      default: class {
        constructor() {
          throw new Error("Could not locate the bindings file. Tried: /x/better_sqlite3.node");
        }
        close(): void {}
      },
    }));
    out.push(
      assert(
        "★import 성공만으로 통과시키지 않는다 — 바인딩을 실제로 연다",
        !bindingBroken.ok,
        bindingBroken.ok ? "★통과시킴(=못 쓰는 설치를 정상이라 보고)" : "적발",
      ),
      assert(
        "그 실패 원문을 그대로 실어 안내가 붙을 수 있게 한다",
        !bindingBroken.ok && bindingBroken.message.includes("bindings file"),
        bindingBroken.ok ? "-" : bindingBroken.message.slice(0, 60),
      ),
    );

    // ── 네이티브 실패 문구가 **조치**를 담는가 ───────────────────────────────────
    const hint = describeNativeLoadFailure(
      "Could not locate the bindings file. Tried: /x/better_sqlite3.node",
    );
    out.push(
      assert(
        "★네이티브 실패 안내가 '무엇을 하라' 를 담는다(증상만 말하지 않는다)",
        hint !== null && hint.includes("tiguclaw update"),
        (hint ?? "(안내 없음)").slice(0, 70),
      ),
      assert(
        "관계없는 에러엔 그 안내를 안 붙인다(진단이 소음이 되지 않게)",
        describeNativeLoadFailure("SQLITE_CANTOPEN: unable to open database file") === null,
        "null 이어야",
      ),
    );

    // ── 전역 명령 판정 ──────────────────────────────────────────────────────────
    out.push(
      assert(
        "명령을 못 찾으면 대안까지 준다(그 전엔 node bin/… 으로 쓸 수 있다)",
        (() => {
          const v = judgeGlobalCommand(null, "/opt/tiguclaw");
          return v.kind === "missing" && v.fix.includes("bin/tiguclaw.mjs");
        })(),
        JSON.stringify(judgeGlobalCommand(null, "/opt/tiguclaw")).slice(0, 90),
      ),
      assert(
        "이 설치를 가리키면 정상",
        judgeGlobalCommand("/opt/tiguclaw/node_modules/.bin/tiguclaw", "/opt/tiguclaw").kind === "ok",
        "ok 여야",
      ),
      assert(
        "★다른 설치를 가리키면 그걸 말한다 — '명령 없음' 보다 나쁜 조용한 오답이다",
        judgeGlobalCommand("/usr/local/bin/tiguclaw", "/opt/tiguclaw").kind === "elsewhere",
        judgeGlobalCommand("/usr/local/bin/tiguclaw", "/opt/tiguclaw").kind,
      ),
      assert(
        "경로 대소문자·구분자 차이를 흡수한다(윈도우)",
        judgeGlobalCommand("C:\\Apps\\Tiguclaw\\bin\\tiguclaw.cmd", "C:/apps/tiguclaw").kind === "ok",
        judgeGlobalCommand("C:\\Apps\\Tiguclaw\\bin\\tiguclaw.cmd", "C:/apps/tiguclaw").kind,
      ),
    );

    // 조회 함수는 환경 의존이라 **결과를 단정하지 않는다** — 던지지만 않으면 된다.
    let threw = false;
    try {
      resolveGlobalCommand();
    } catch {
      threw = true;
    }
    out.push(assert("전역 명령 조회가 없는 환경에서도 안 던진다", !threw, threw ? "throw" : "안전"));

    return out;
  },
};
