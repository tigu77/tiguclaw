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
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  judgeGlobalCommand,
  resolveLinkedInstall,
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
    // ★정적 import 뿐 아니라 **모듈 최상위 `await import`** 도 잡는다 (2026-08-20 적대 검토).
    //  둘은 행동이 같다 — 모듈 로드 단계에서 죽어 `main()` 이 시작조차 못 한다. 종전 정규식은
    //  `^import …` 만 봐서, 최상위로 끌어올린 `const x = await import("../store/…")` 가 통과했다
    //  (원래 사고가 린트 초록인 채 그대로 재현됐다).
    const topLevelAwaitImports = code
      .split("\n")
      .filter((l) => /^(?:const|let|var)\s[^=]*=\s*await import\("\.\.\/store\//.test(l))
      .map((l) => l.trim());
    const staticStoreImports = [
      ...[...code.matchAll(/^import\s[^;]*?from\s+"\.\.\/store\/[^"]+"/gm)]
        .map((m) => m[0].replace(/\s+/g, " "))
        // `import type` 은 런타임에 사라지므로 무해하다.
        .filter((l) => !/^import type /.test(l)),
      ...topLevelAwaitImports,
    ];
    out.push(
      assert(
        "★doctor 가 store 를 **모듈 최상위**에서 끌지 않는다(정적 import·최상위 await import 둘 다)",
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
        judgeGlobalCommand("/opt/tiguclaw/node_modules/.bin/tiguclaw", "/opt/tiguclaw", { kind: "linked", root: "/opt/tiguclaw" }).kind === "ok",
        "ok 여야",
      ),
      // ★직접 관측이 간접 근거를 이긴다 (2026-08-20 재검토 F5). 종전엔 `linkedRoot` 가
      //  1순위라, 명령 경로가 **이 설치 안이라고 이미 증명됐는데도** 링크가 딴 데를 가리키면
      //  "이 설치가 아닙니다" 로 뒤집었다. 설치가 여럿일 때 실제로 갈린다 — 전역 링크는 B 인데
      //  PATH 는 A 안의 실행 파일을 먼저 잡으면, 도는 건 A 인데 doctor 가 "A 가 아니다" 라고 했다.
      //  ★사용자 지정(2026-08-19): "어떤 홈으로 설치하든 여러 개를 설치하든 문제가 생기면 안 된다."
      assert(
        "★명령이 이 설치 안이면 전역 링크가 딴 데여도 정상 — 증명된 답을 추정으로 덮지 않는다",
        judgeGlobalCommand(
          "/opt/tiguclaw/node_modules/.bin/tiguclaw",
          "/opt/tiguclaw",
          { kind: "linked", root: "/opt/other" },
        ).kind === "ok",
        JSON.stringify(
          judgeGlobalCommand("/opt/tiguclaw/node_modules/.bin/tiguclaw", "/opt/tiguclaw", { kind: "linked", root: "/opt/other" }),
        ).slice(0, 100),
      ),
      assert(
        "★다른 설치를 가리키면 그걸 말한다 — '명령 없음' 보다 나쁜 조용한 오답이다",
        judgeGlobalCommand("/usr/local/bin/tiguclaw", "/opt/tiguclaw", { kind: "linked", root: "/opt/other" }).kind ===
          "elsewhere",
        judgeGlobalCommand("/usr/local/bin/tiguclaw", "/opt/tiguclaw", { kind: "linked", root: "/opt/other" }).kind,
      ),
      // ★심링크·형제경로 (2026-08-20 적대 검토) — 첫 판은 `path.resolve` 접두 비교라
      //  **양방향으로** 틀렸다: `npm link` 심링크를 안 풀어 정상 설치를 "다른 설치" 라 했고,
      //  구분자 없는 접두라 형제 경로(`~/.tiguclaw-install` vs `~/.tiguclaw`)를 같다고 했다.
      //  ★같은 판단이 `src/cli.ts globalTiguclawIsOurs()` 에 realpath 정확 비교로 이미 있었다 —
      //   그걸 문자열 비교로 다시 구현하다 틀린 것이라, 이 검사는 그 재발을 막는다.
      assert(
        "★형제 경로를 같은 설치로 보지 않는다(~/.tiguclaw-install ≠ ~/.tiguclaw)",
        judgeGlobalCommand(
          "/Users/x/.tiguclaw-install/bin/tiguclaw",
          "/Users/x/.tiguclaw",
          { kind: "linked", root: "/Users/x/.tiguclaw-install" },
        ).kind === "elsewhere",
        judgeGlobalCommand(
          "/Users/x/.tiguclaw-install/bin/tiguclaw",
          "/Users/x/.tiguclaw",
          { kind: "linked", root: "/Users/x/.tiguclaw-install" },
        ).kind,
      ),
      assert(
        "★심링크를 풀고 비교한다(npm link 로 건 정상 설치를 '다른 설치' 라 하지 않게)",
        await (async () => {
          const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
          const os = await import("node:os");
          const pathMod = await import("node:path");
          const T = mkdtempSync(pathMod.join(os.tmpdir(), "tgc-link-"));
          try {
            mkdirSync(pathMod.join(T, "install/bin"), { recursive: true });
            mkdirSync(pathMod.join(T, "gb"), { recursive: true });
            writeFileSync(pathMod.join(T, "install/bin/tiguclaw.mjs"), "");
            symlinkSync(pathMod.join(T, "install/bin/tiguclaw.mjs"), pathMod.join(T, "gb/tiguclaw"));
            return (
              judgeGlobalCommand(pathMod.join(T, "gb/tiguclaw"), pathMod.join(T, "install")).kind === "ok"
            );
          } finally {
            rmSync(T, { recursive: true, force: true });
          }
        })(),
        "ok 여야 — 심링크 실체가 그 설치 안이다",
      ),
      assert(
        "경로 대소문자·구분자 차이를 흡수한다(윈도우)",
        judgeGlobalCommand("C:\\Apps\\Tiguclaw\\bin\\tiguclaw.cmd", "C:/apps/tiguclaw", { kind: "linked", root: "C:/Apps/Tiguclaw" }).kind === "ok",
        judgeGlobalCommand("C:\\Apps\\Tiguclaw\\bin\\tiguclaw.cmd", "C:/apps/tiguclaw", { kind: "linked", root: "C:/Apps/Tiguclaw" }).kind,
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

    // ★**지형 매트릭스** — 홈이 어디든, 몇 개를 깔든 맞아야 한다 (2026-08-20 사용자 지적).
    //  "그건 그 머신 지형이라 일반 사용자 영향 없다" 는 면피다. 설치 개수·경로 배치는
    //  사용자가 정하는 것이고 제품 판정이 거기 의존하면 안 된다. 케이스를 산문으로
    //  늘어놓지 않고 **표로** 두고 전수 확인한다 — 새 지형이 생기면 줄 하나만 는다.
    {
      const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
      const os = await import("node:os");
      const P = await import("node:path");
      const T = mkdtempSync(P.join(os.tmpdir(), "tgc-topo-"));
      try {
        const mk = (rel: string): string => {
          const d = P.join(T, rel, "bin");
          mkdirSync(d, { recursive: true });
          writeFileSync(P.join(d, "tiguclaw.mjs"), "");
          return P.join(T, rel);
        };
        const one = mk("home/tiguclaw");
        const sib = mk("home/tiguclaw-install");
        const nest = mk("home/tiguclaw/nested");
        const other = mk("opt/tiguclaw");
        mkdirSync(P.join(T, "gb"), { recursive: true });
        const link = P.join(T, "gb/tiguclaw");
        symlinkSync(P.join(one, "bin/tiguclaw.mjs"), link);
        // 심링크면 실체를, 아니면 그 경로가 속한 설치 루트를 링크 실체로 본다(테스트 헬퍼).
        const linkedOf = (cmd: string): string => {
          try {
            return P.dirname(P.dirname(P.resolve(realpathSync(cmd))));
          } catch {
            return P.dirname(P.dirname(P.resolve(cmd)));
          }
        };
        const cases: Array<[string, string | null, string, string]> = [
          ["설치 1개 · 직접 경로", P.join(one, "bin/tiguclaw.mjs"), one, "ok"],
          ["설치 1개 · npm link 심링크", link, one, "ok"],
          ["형제 설치(접두 겹침)", P.join(sib, "bin/tiguclaw.mjs"), one, "elsewhere"],
          ["형제의 반대 방향", link, sib, "elsewhere"],
          ["중첩 설치(안쪽이 대상)", P.join(nest, "bin/tiguclaw.mjs"), nest, "ok"],
          ["완전히 다른 홈", P.join(other, "bin/tiguclaw.mjs"), one, "elsewhere"],
          ["루트에 트레일링 슬래시", P.join(one, "bin/tiguclaw.mjs"), one + "/", "ok"],
          ["명령 없음", null, one, "missing"],
        ];
        for (const [name, cmd, root, want] of cases) {
          // ★`linkedRoot`(npm 이 링크한 실체)를 넘긴다 — 실제 doctor 도 그렇게 부른다.
          //  안 넘기면 판정이 `unknown`(모른다)이고 그건 **옳은 보수적 답**이다:
          //  윈도우 shim 은 원래 설치 루트 밖이라 "밖=다른 설치" 로 단정하면 전원 오경보다.
          const got = judgeGlobalCommand(cmd, root, cmd === null ? { kind: "unknown" as const } : ({ kind: "linked" as const, root: linkedOf(cmd) })).kind;
          out.push(
            assert(`지형: ${name}`, got === want, got === want ? got : `${got} (기대 ${want})`),
          );
        }
      } finally {
        rmSync(T, { recursive: true, force: true });
      }
    }

    // ── ★종료코드가 화면 판정과 같은가 — **진짜로 돌려서** 본다 (B-F2) ────────────
    //  종전엔 `fatal` 카운터와 `issues` 배열이 **두 벌의 손 관리 목록**이었고 9곳 중 4곳이
    //  어긋났다(데몬 미응답 · 채널 핸들러 미연결 · **텔레그램 allowlist 빈값=봇 완전 잠김** ·
    //  ripgrep 없음). 그 상태에서 화면은 "🔴 문제 N개" 인데 종료코드는 **0**(정상)이었다 —
    //  기계가 읽는 답과 사람이 읽는 답이 갈리면 자동화(CI·설치 스크립트·이슈 템플릿)가 속는다.
    //  ★소스로 보면 동의어로 뚫린다. 프로세스를 띄워 **결과**를 본다(임시 홈, 라이브 무접촉).
    {
      const { spawnSync } = await import("node:child_process");
      const { mkdtempSync, rmSync } = await import("node:fs");
      const os = await import("node:os");
      const P = await import("node:path");
      const REPO = P.resolve(P.dirname(new URL(import.meta.url).pathname), "../../..");
      const home = mkdtempSync(P.join(os.tmpdir(), "tgc-doc-"));
      try {
        const r = spawnSync(
          process.execPath,
          ["--import", "tsx", P.join(REPO, "src/scripts/doctor.ts")],
          {
            cwd: REPO,
            encoding: "utf8",
            timeout: 60_000,
            env: {
              ...process.env,
              TIGUCLAW_HOME: home,
              DATA_DIR: home,
              TELEGRAM_BOT_TOKEN: "",
              HTTP_BRIDGE_PORT: "39997", // 아무도 안 듣는 포트 = 데몬 미응답 유도
            },
          },
        );
        const outText = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        const sawProblem = /🔴 문제 \d+개/.test(outText);
        out.push(
          assert(
            "doctor 가 그 환경에서 문제를 보고한다(전제 확인)",
            sawProblem,
            sawProblem ? "문제 보고함" : outText.slice(-160),
          ),
          assert(
            "★문제를 보고했으면 **종료코드도 실패**다 — 화면과 기계 판정이 갈리면 안 된다",
            !sawProblem || r.status === 1,
            `exit=${String(r.status)} · 화면=${sawProblem ? "문제 있음" : "정상"}`,
          ),
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }

    // ★★**조회 함수 자체를 돌린다** — 이음매를 검사한다 (2026-09-03 변이로 발각).
    //  판정(`judgeGlobalCommand`)만 픽스처로 부르면, **조회가 «폴더 없음» 을 «모름» 으로
    //  퇴화시켜도 통과한다** — 실제로 그 변이가 살아남았다(4개 중 1개 생존).
    //  부품은 검사되는데 이음매가 안 검사되던 것([[feedback_simple_composable_no_duplication]]).
    //  ★`npm root -g` 는 `npm_config_prefix` 를 따르므로(실측) 진짜 조회를 그대로 돌린다.
    const pathM = await import("node:path");
    const prefix = mkdtempSync(pathM.join(tmpdir(), "tgc-prefix-"));
    const prevPrefix = process.env.npm_config_prefix;
    let lookupBroken: ReturnType<typeof resolveLinkedInstall>;
    let lookupLinked: ReturnType<typeof resolveLinkedInstall>;
    try {
      process.env.npm_config_prefix = prefix;
      lookupBroken = resolveLinkedInstall(); // 패키지 폴더 없음
      const gRoot = pathM.join(prefix, "lib", "node_modules", "tiguclaw");
      mkdirSync(gRoot, { recursive: true });
      lookupLinked = resolveLinkedInstall(); // 이제 있음
    } finally {
      if (prevPrefix === undefined) delete process.env.npm_config_prefix;
      else process.env.npm_config_prefix = prevPrefix;
      rmSync(prefix, { recursive: true, force: true });
    }
    out.push(
      assert(
        "★★★조회가 «폴더 없음» 을 **broken 으로** 분류한다 — unknown 으로 퇴화하면 처방이 사라진다(이음매 검사)",
        lookupBroken.kind === "broken",
        lookupBroken.kind,
      ),
      assert(
        "★조회가 폴더가 **있으면** linked 다 — 항상 broken 이면 멀쩡한 설치에 오경보를 준다",
        lookupLinked.kind === "linked",
        lookupLinked.kind,
      ),
    );

    // ★★**링크가 끊긴 경우** — 2026-09-03 사용자(동료 기계) 신고로 갈래가 생겼다.
    //  윈도우에서 `AppData\Roaming\npm\node_modules\tiguclaw` 가 통째로 사라졌는데
    //  `.cmd` shim 만 남아, `tiguclaw update` 가 날것의 `MODULE_NOT_FOUND` 스택으로 죽었다.
    //  레포는 멀쩡했고(파일 4,839B 확인) 답은 `npm link` 한 줄이었다.
    //  ★종전엔 이게 «모름» 으로 흘러 *"판정 불가"* 라고 답했다 — **고치는 법을 아는데
    //   우회로만 알려준 것**이다. 그래서 «조회 실패» 와 «폴더 없음» 을 값으로 가른다.
    const brokenWin = judgeGlobalCommand(
      "C:\\Users\\SANTO\\AppData\\Roaming\\npm\\tiguclaw.cmd",
      "C:/Users/SANTO/tiguclaw",
      { kind: "broken", expected: "C:/Users/SANTO/AppData/Roaming/npm/node_modules/tiguclaw" },
    );
    const unknownStill = judgeGlobalCommand("/usr/local/bin/tiguclaw", "/opt/tiguclaw", {
      kind: "unknown",
    });
    out.push(
      assert(
        "★★링크가 끊기면 `broken-link` 다 — «모름» 이 아니다(답을 아는 상태)",
        brokenWin.kind === "broken-link",
        brokenWin.kind,
      ),
      assert(
        "★★처방이 `npm link` 다 — 우회로만 주면 사용자는 고칠 방법을 영영 모른다",
        brokenWin.kind !== "ok" && /npm link/.test(brokenWin.fix),
        brokenWin.kind === "ok" ? "★ok 로 샘" : brokenWin.fix.slice(0, 60),
      ),
      assert(
        "★그래도 우회로는 같이 준다 — `tiguclaw doctor` 자신이 그 shim 을 지나므로 도달 경로가 그것뿐이다",
        brokenWin.kind !== "ok" && /node bin\/tiguclaw\.mjs/.test(brokenWin.fix),
        brokenWin.kind === "ok" ? "★ok 로 샘" : "우회로 있음",
      ),
      assert(
        "★★조회 자체가 실패한 경우는 **여전히 «모름»** 이다 — 둘을 뭉치면 없는 처방을 주게 된다",
        unknownStill.kind === "unknown",
        unknownStill.kind,
      ),
    );

    return out;
  },
};
