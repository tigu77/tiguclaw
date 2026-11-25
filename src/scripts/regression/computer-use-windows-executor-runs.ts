/**
 * 회귀: **Windows 실행부가 «컴파일이라도 되는가»** (2026-09-17, 회사돌쇠 실기 제안).
 *
 * ★배경 — 순수부 회귀 **91건이 전부 초록인데 실행부가 아예 안 돌았다.** `Add-Type` 에
 *  `-UsingNamespace System.Runtime.InteropServices` 를 줬는데 그건 생성 C# 에 **이미 들어
 *  있어서**, 중복 `using` 으로 컴파일이 깨졌다. 그리고 그 실패가 `idleSeconds()===null` →
 *  «사람이 쓰는 중» 으로 흘러 **첫 클릭 전에** 막혔다.
 *
 * ★★**검증 공백의 모양**: 검사는 «무엇을 쏠지»(순수부)만 재고, «쏘는 쪽이 살아는 있나» 는
 *  아무도 안 봤다. 그 사이가 이 파일이다.
 *
 * ★**제품이 만드는 바로 그 스크립트**를 돌린다 — 검사용으로 다시 쓴 C# 은 이 부류를 못 잡는다
 *  (그 사본엔 중복 `using` 이 없을 테니까). `selfCheck()` 가 그래서 제품 쪽에 산다.
 * ★**입력은 0이다**: 이벤트 배열을 비워 주면 구조체·P/Invoke·함수 정의가 전부 컴파일되고
 *  루프는 0번 돈다. 회귀가 사용자 화면을 건드리면 안 된다(principle-check Q7).
 *
 * ★등급: **동작 게이트**(실제로 돌린다). 단 **Windows 에서만** — 다른 OS 에선 대상이 없다.
 *  조용히 통과시키지 않고 «대상 아님» 을 한 줄로 말한다(`sync-gates-check-rc` 와 같은 규율).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, loadPluginModule, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

interface WinModule {
  selfCheck: () => Promise<
    | {
        ok: true;
        idleSeconds: number | null;
        textSurvives: boolean;
        dryFired: number;
        dryStopped: boolean;
      }
    | { ok: false; where: "idle" | "input" | "dry"; detail: string }
  >;
  cleanPowerShellError: (raw: string) => string | null;
  scriptError: (stdout: string) => string | null;
  antivirusBlocked: (detail: string) => boolean;
  capture: (
    target: never,
    outPath: string,
  ) => Promise<
    | { ok: true; bytes: number; deliveredPx: { w: number; h: number } | null }
    | { ok: false; reason: string; detail: string }
  >;
  CAPTURE_CS: string;
  captureExeName: (source: string) => string;
  cscArgs: (sourcePath: string, outPath: string) => string[];
  blockedOr: (detail: string, vanished: boolean) => string;
  spawnRefused: (detail: string) => boolean;
}

export const check: RegressionCheck = {
  name: "computer-use-windows-executor-runs",
  guards:
    "Windows 조작 실행부가 컴파일조차 안 되는데 순수부 회귀가 전부 초록이라 아무도 모르던 것 · " +
    "PowerShell 오류가 CLIXML 껍데기에 가려 «왜» 가 사라지던 것 · " +
    "오류 문구의 ASCII 밖 글자가 코드페이지↔UTF-8 어긋남으로 통째로 U+FFFD 가 되던 것 · " +
    "캡처가 그림 실측 크기를 안 내서 «화면 id» 가 영영 발급되지 않고 조작 도구 전체가 불능이던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { selfCheck, cleanPowerShellError, scriptError, capture, antivirusBlocked, CAPTURE_CS, captureExeName, cscArgs, blockedOr, spawnRefused } =
      await loadPluginModule<WinModule>(
      "../../../plugins/computer-use/src/win.ts",
    );

    // ── ① CLIXML 벗기기는 **어디서든** 잰다(순수) ─────────────────────────────
    //  ★이게 없으면 실패해도 «왜» 를 못 본다 — 실제로 300자 자르기가 서문만 남겨 원인을
    //   가렸다. 잘린 것이 아니라 **잘못된 조각**을 보여준 것이다.
    const clixml =
      '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      "<S S=\"Error\">Add-Type : (10,14) : error CS0246: 'using' 중복 선언_x000D__x000A_</S></Objs>";
    const cleaned = cleanPowerShellError(clixml);
    out.push(
      assert(
        "★CLIXML 껍데기를 벗기고 **실제 오류 줄**을 준다(앞에서 자르면 서문만 남는다)",
        cleaned !== null && cleaned.includes("CS0246") && !cleaned.includes("Objs Version"),
        String(cleaned).slice(0, 90),
      ),
    );
    out.push(
      assert(
        "CLIXML 이 아니면 그대로 준다 · 빈 입력은 «없음»(지어내지 않는다)",
        cleanPowerShellError("Add-Type : 그냥 오류") === "Add-Type : 그냥 오류" &&
          cleanPowerShellError("   ") === null,
        `${String(cleanPowerShellError("Add-Type : 그냥 오류"))} / ${String(cleanPowerShellError("   "))}`,
      ),
    );

    // ── ①-b 스크립트가 적은 오류를 **한 줄도 버리지 않는다**(순수) ───────────
    //  ★실기 2차에서 `detail` 이 `System.Management.Automation.PSCustomObject` 하나였다.
    //   그 모양이 나오는 길이 둘 있었다: 문자열이 아니면 버리고, JSON 이 안 읽히면 버렸다.
    //   («왜» 를 잃는 실패 = 실패가 두 번인 것이다.)
    out.push(
      assert(
        "★오류가 **문자열이 아니어도** 값을 보여준다 · 예외 형을 같이 준다",
        (scriptError('{"error":{"k":1},"type":"System.Exception"}') ?? "").includes('{"k":1}') &&
          (scriptError('{"error":{"k":1},"type":"System.Exception"}') ?? "").includes(
            "System.Exception",
          ),
        String(scriptError('{"error":{"k":1},"type":"System.Exception"}')),
      ),
    );
    out.push(
      assert(
        "★**JSON 이 깨져도 줄을 통째로** 준다 — 못 읽는 것이 «오류가 없다» 는 뜻은 아니다",
        (scriptError('{"error":"따옴표 \\" 가 깨뜨린 줄') ?? "").includes("따옴표"),
        String(scriptError('{"error":"따옴표 \\" 가 깨뜨린 줄')),
      ),
    );
    out.push(
      assert(
        "오류가 없으면 «없음» 이다(정상 산출을 실패로 읽지 않는다)",
        scriptError('{"sent":3}') === null && scriptError("그냥 글") === null,
        `${String(scriptError('{"sent":3}'))} / ${String(scriptError("그냥 글"))}`,
      ),
    );

    // ── ①-c CLIXML 에서 **조각 말고 문장**을 고른다 (2026-09-18, 집 Windows 실기) ──
    //  ★같은 결함의 **세 번째 얼굴**이다. 9/17 에 «앞에서 자르면 서문만 남는다» 를
    //   «가장 긴 줄» 로 고쳤는데, 백신이 막은 사고에서 **`+ CategoryInfo : ParserError…`**
    //   를 골랐다. 진짜 문장은 바로 윗줄이었고, 그래서 «파싱 오류» 로 읽혀 스크립트를
    //   세 번 뜯어봤다. 길이가 아니라 **모양**으로 골라야 한다.
    // ★★**실기에서 받은 stderr 원문 그대로**다(집 Windows, 2026-09-18, 백신 차단).
    //  지어낸 표본이 **두 번** 나를 속였다 — 짧게 만들면 「가장 긴 줄」도 정답을 고르고,
    //  영어로 만들면 **본문이 깨지는 것**이 안 보인다. 실제로는 셋이 겹쳐 있다:
    //   ① `+ CategoryInfo`(81자)가 진짜 문장(68자)보다 **길다**
    //   ② 그 진짜 문장이 **한국어라 CP949 로 깨져** 온다
    //   ③ 이 오류는 **우리 스크립트가 시작되기 전에** PowerShell 이 내므로, 스크립트 안의
    //      UTF-8 강제가 **안 닿는다** — 남는 ASCII 신호는 `FullyQualifiedErrorId` 뿐이다
    const amsi = "#< CLIXML\n<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><S S=\"Error\">\ufffd\ufffd\u0121 \ufffd\ufffd:1 \ufffd\ufffd\ufffd\ufffd:1_x000D__x000A_</S><S S=\"Error\">+ try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding ..._x000D__x000A_</S><S S=\"Error\">+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~_x000D__x000A_</S><S S=\"Error\">\ufffd\ufffd \ufffd\ufffd\u0169\ufffd\ufffd\u01ae\ufffd\ufffd \ufffd\u01fc\ufffd \ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd \ufffd\u05be\uef2d \ufffd\ufffd\ufffd\u0337\ufffd\ufffd\ufffd \ufffd\ufffd\ufffd \ufffd\ufffd\ufffd\ufffd\u01ae\ufffd\ufffd\ufffd\uefe1 \ufffd\ufffd\ufffd\ufffd \ufffd\ufffd\ufffd\u0735\u01fe\ufffd\ufffd\ufffd\ufffd\u03f4\ufffd._x000D__x000A_</S><S S=\"Error\">    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException_x000D__x000A_</S><S S=\"Error\">    + FullyQualifiedErrorId : ScriptContainedMaliciousContent_x000D__x000A_</S><S S=\"Error\"> _x000D__x000A_</S></Objs>";
    const picked = cleanPowerShellError(amsi) ?? "";
    out.push(
      assert(
        "★★부속 줄(`+ …`)을 **모양으로** 걷어낸다 — 이름 열거는 새 모양(`+ try {`)을 놓친다",
        !picked.startsWith("+") && !picked.includes("CategoryInfo"),
        picked.slice(0, 120),
      ),
    );
    out.push(
      assert(
        "★**본문이 깨졌으면 그렇다고 말하고, ASCII 인 `FullyQualifiedErrorId` 를 같이 준다**",
        picked.includes("ScriptContainedMaliciousContent") &&
          (picked.includes("깨져") || !/\uFFFD/.test(picked)),
        picked.slice(0, 120),
      ),
    );
    out.push(
      assert(
        "★**백신이 막은 것**을 알아본다 — «파싱 오류» 로 읽히면 엉뚱한 데를 고친다",
        antivirusBlocked("+ FullyQualifiedErrorId : ScriptContainedMaliciousContent") &&
          antivirusBlocked("This script contains malicious content") &&
          !antivirusBlocked("알 수 없는 키 이름: 없는키"),
        // ★**관측한 값을 적는다** — 기대값("true 여야")을 적으면 빨간불을 봐도 무엇이
        //  관측됐는지 모른다(`suite-selfcheck` 가 상한으로 지키는 그 규율).
        `errId=${String(antivirusBlocked("+ FullyQualifiedErrorId : ScriptContainedMaliciousContent"))} · ` +
          `문장=${String(antivirusBlocked("This script contains malicious content"))} · ` +
          `평범한오류=${String(antivirusBlocked("알 수 없는 키 이름: 없는키"))}`,
      ),
    );

    // ── ①-e 캡처는 **컴파일된 프로그램**이다 (2026-09-28) — Defender 가 PowerShell 화면 캡처 스크립트를
    //  `HackTool:PowerShell/EmpireGetScreenshot` 로 막아 같은 .NET 호출을 C# 로 옮겼다. 이음매를 잰다:
    //  TS 가 넘기는 환경변수(`winCaptureEnv`)를 C# 이 **전부** 읽고, TS 가 읽는 출력 키(`screens`·`w`·`h`·`dpi`)를 C# 이 낸다.
    type EnvModule = { winCaptureEnv: (t: unknown, out: string, o?: { longEdge?: number }) => Record<string, string> };
    const envMod = await loadPluginModule<EnvModule>("../../../plugins/computer-use/src/observe.ts");
    const envKeys = new Set([
      ...Object.keys(envMod.winCaptureEnv({ kind: "screen" }, "o.jpg")),
      ...Object.keys(envMod.winCaptureEnv({ kind: "display", index: 2 }, "o.jpg")),
      ...Object.keys(envMod.winCaptureEnv({ kind: "region", x: 1, y: 2, width: 3, height: 4 }, "o.jpg")),
      ...Object.keys(envMod.winCaptureEnv({ kind: "probe" }, "o.jpg", { longEdge: 0 })),
    ]);
    const unread = [...envKeys].filter((k) => !CAPTURE_CS.includes(`"${k}"`));
    const modes = ["display", "region", "probe"].filter((m) => !CAPTURE_CS.includes(`mode == "${m}"`));
    const outKeys = ["screens", "w", "h", "dpi", "error"].filter((k) => !CAPTURE_CS.includes(`\\"${k}\\"`));
    out.push(
      assert(
        "★캡처 프로그램이 TS 가 넘기는 환경변수·모드를 전부 읽고, TS 가 읽는 출력 키를 낸다(이음매)",
        envKeys.size >= 8 && unread.length === 0 && modes.length === 0 && outKeys.length === 0,
        JSON.stringify({ envKeys: [...envKeys], unread, modes, outKeys }),
      ),
    );
    out.push(
      assert(
        "★캡처 프로그램 이름에 소스 해시가 들어간다 — 소스가 바뀌면 옛 exe 를 계속 쓰지 않고 새로 컴파일된다",
        captureExeName(CAPTURE_CS) === captureExeName(CAPTURE_CS) && captureExeName(CAPTURE_CS) !== captureExeName(CAPTURE_CS + " ") &&
          /^tiguclaw-capture-[0-9a-f]{12}\.exe$/.test(captureExeName(CAPTURE_CS)),
        captureExeName(CAPTURE_CS),
      ),
    );
    const args = cscArgs("C:\\t\\a.cs", "C:\\t\\b.exe");
    out.push(
      assert(
        "컴파일 인자: 실행 파일 · System.Drawing·Windows.Forms 참조 · 소스는 마지막",
        args.includes("/target:exe") && args.includes("/out:C:\\t\\b.exe") && args.includes("/r:System.Drawing.dll") && args.includes("/r:System.Windows.Forms.dll") && args[args.length - 1] === "C:\\t\\a.cs",
        args.join(" "),
      ),
    );

    // ── ①-d 백신에 막혔을 때 **사용자에게 알리고 허용을 안내하라** 고 말한다 (2026-09-28 윈도우 돌쇠 실측) ──
    //  ★종전 문구는 사유는 맞았지만 «화면 관측을 쓰지 않는 쪽으로 판단해 주세요» 로 끝나, 비서가 관측 없이 진행하다
    //   «직접 확인해 달라» 로 넘기고 멈췄다 — 같은 날 3회 모두. «Defender 가 막고 있다» 는 사용자에게 한 번도 안 갔다.
    //  ★로그도 `권한(failed)` 뿐이라 원인을 Defender 탐지 기록을 원격으로 뒤져서야 알았다.
    type ObserveModule = {
      preflightMessage: (p: { ok: false; reason: "timeout" | "failed"; detail?: string }, platform: string) => string | null;
      preflightFailureKind: (p: { ok: false; reason: "timeout" | "failed"; detail?: string }, platform: string) => string;
    };
    const obs = await loadPluginModule<ObserveModule>("../../../plugins/computer-use/src/observe.ts");
    const avProbe = { ok: false as const, reason: "failed" as const, detail: "+ FullyQualifiedErrorId : ScriptContainedMaliciousContent" };
    const avMsg = obs.preflightMessage(avProbe, "win32") ?? "";
    out.push(
      assert(
        "★★백신 차단 안내는 **사용자에게 알리라** 고 지시하고, **어디서 허용하는지** 단계로 준다 — 포기 출구(«쓰지 않는 쪽으로 판단») 는 없다",
        /사용자에게 바로 알리/.test(avMsg) && avMsg.includes("보호 기록") && avMsg.includes("허용") && !avMsg.includes("쓰지 않는 쪽으로"),
        avMsg.slice(0, 200),
      ),
    );
    const kinds = {
      av: obs.preflightFailureKind(avProbe, "win32"),
      noDesktop: obs.preflightFailureKind({ ok: false, reason: "failed", detail: "no-desktop" }, "win32"),
      timeout: obs.preflightFailureKind({ ok: false, reason: "timeout", detail: "" }, "win32"),
      macPerm: obs.preflightFailureKind({ ok: false, reason: "failed", detail: "could not create image from display" }, "darwin"),
      other: obs.preflightFailureKind({ ok: false, reason: "failed", detail: "알 수 없는 키 이름: 없는키" }, "win32"),
    };
    out.push(
      assert(
        "★로그에 남는 관측 실패 사유가 원인을 가른다(백신 차단 · 세션 없음 · 시한 · mac 권한 · 그 밖은 원문 조각)",
        kinds.av.startsWith("백신 차단") && kinds.noDesktop === "데스크톱 세션 없음" && kinds.timeout === "시한 초과" &&
          kinds.macPerm === "화면 기록 권한 없음" && kinds.other.includes("없는키") && !kinds.other.startsWith("백신"),
        JSON.stringify(kinds),
      ),
    );

    // ── ①-f **컴파일된 캡처 프로그램**이 막혀도 백신 안내가 나간다 (2026-09-29 적대 검토 P3) ──
    //  기본 Defender 는 이제 안 막지만 다른 백신·관리형 EDR·ASR 은 새 exe 를 격리하거나 실행을 거부한다. 그 실패는
    //  AMSI 문구가 아니라 CS0016·파일 사라짐·spawn 거부로 와서, 종전엔 «디스플레이 번호를 확인하라» 로 떨어졌다.
    const blockedDetails = [
      blockedOr("compile: error CS0016: Could not write to output file — the file contains a virus or potentially unwanted software", false),
      blockedOr("compile: ENOENT: no such file or directory, rename 'x.tmp.exe'", true), // 방금 만든 파일이 사라짐
      blockedOr("spawn C:\\Users\\u\\AppData\\Local\\tiguclaw\\tiguclaw-capture-a.exe UNKNOWN", spawnRefused("spawn C:\\Users\\u\\AppData\\Local\\tiguclaw\\tiguclaw-capture-a.exe UNKNOWN")),
      blockedOr("spawn C:\\x\\tiguclaw-capture-a.exe EPERM", spawnRefused("spawn C:\\x\\tiguclaw-capture-a.exe EPERM")),
    ];
    const notBlocked = [
      blockedOr("compile: error CS1002: ; expected", false), // 우리 소스 결함은 백신이 아니다
      blockedOr("no-desktop", spawnRefused("no-desktop")),
    ];
    const blockedMsg = obs.preflightMessage({ ok: false, reason: "failed", detail: blockedDetails[2]! }, "win32") ?? "";
    out.push(
      assert(
        "★캡처 프로그램 격리·실행 거부(CS0016 virus · 사라짐 · spawn UNKNOWN/EPERM)는 **백신 차단**으로 — 컴파일 오류·세션 없음은 아니다",
        blockedDetails.every((d) => antivirusBlocked(d)) &&
          notBlocked.every((d) => !antivirusBlocked(d)) &&
          /사용자에게 바로 알리/.test(blockedMsg) && blockedMsg.includes("tiguclaw-capture") && !blockedMsg.includes("디스플레이 번호") &&
          obs.preflightFailureKind({ ok: false, reason: "failed", detail: blockedDetails[0]! }, "win32").startsWith("백신 차단"),
        JSON.stringify({ blocked: blockedDetails.map((d) => antivirusBlocked(d)), notBlocked: notBlocked.map((d) => antivirusBlocked(d)) }),
      ),
    );
    {
      const { readSourceSync } = await import("./_wiring.js");
      const winSrc = readSourceSync("plugins/computer-use/src/win.ts");
      const wired = {
        // ★2026-11-24: 컴파일 경로가 종류(spec)를 받는다 — 대상 이름도 그 spec 에서(캡처 문구 바이트 동일은 W4(e) 가 동작으로 잰다).
        // 컴파일 실패 + 산출물 없음 = 백신은 **캡처만**(종전 판정) — 종류별 판정은 W4(d) 가 동작으로 잰다.
        compile: /if \(!built\.ok\) return \{ \.\.\.built, detail: blockedOr\(built\.detail, spec\.missingOutputIsBlock && !existsSync\(tmp\), spec\.what\) \};/.test(winSrc),
        rename: /detail: blockedOr\(msg, \/ENOENT\/\.test\(msg\), spec\.what\)/.test(winSrc),
        run: /const r = await runChild\(exe\.exe, \[\], env\);[\s\S]{0,120}blockedOr\(r\.detail, spawnRefused\(r\.detail\) \|\| !existsSync\(exe\.exe\)\)/.test(winSrc),
      };
      out.push(
        assert(
          "★[배선] 표식은 **일어난 자리**에서 단다 — 컴파일 실패(파일 사라짐 포함)와 캡처 프로그램 실행 실패 둘 다",
          wired.compile && wired.rename && wired.run,
          JSON.stringify(wired),
        ),
      );
    }
    {
      // 원문 끝 마침표와 우리 문장의 마침표가 겹쳐 «1..2..» 로 보였다(2026-09-29 회사 PC 실측).
      const rangeMsg = obs.preflightMessage({ ok: false, reason: "failed", detail: "Invalid display specified. Only 2 display(s), valid values are 1..2." }, "win32") ?? "";
      out.push(assert("실패 원문 끝 마침표가 안내 문장의 마침표와 겹치지 않는다", rangeMsg.includes("1..2. 대상") && !rangeMsg.includes("2.. 대상"), rangeMsg.slice(0, 120)));
    }
    const cscProbe = { ok: false as const, reason: "failed" as const, detail: "csc-missing: .NET Framework 4 컴파일러(csc.exe)를 찾지 못했습니다" };
    const cscMsg = obs.preflightMessage(cscProbe, "win32") ?? "";
    out.push(
      assert(
        "컴파일러(csc.exe)가 없으면 **무엇을 켜면 되는지**(.NET Framework 4.x)를 말하고, 내부 토큰·디스플레이 번호 유도는 없다",
        cscMsg.includes(".NET Framework 4") && cscMsg.includes("기능 켜기") && !cscMsg.includes("csc-missing") && !cscMsg.includes("디스플레이 번호") &&
          obs.preflightFailureKind(cscProbe, "win32").includes("컴파일러 없음"),
        cscMsg.slice(0, 160),
      ),
    );

    // ★★**조작 스크립트의 시한은 흘리는 이벤트로 정한다 — 제품 발사와 자가 점검이 같은 자리에서**(2026-10-23).
    //  자가 점검만 고정 8초였을 때, 이벤트 수백 개의 빈 연습이 제품 `post` 라면 받았을 시한보다 짧은 시한에 죽었다(집 Windows 전체 회귀
    //  «dry 에서 실패: 8000ms 초과», 기준·최종 양쪽). 실행부는 Windows 에서만 돌지만 **자식에게 넘기는 옵션**은 어느 OS 에서든 볼 수 있다 —
    //  별도 프로세스에서 `execFile` 을 가짜로 바꿔(입력 0) 제품 `post`·`selfCheck` 가 실제로 넘긴 시한·`TIGUCLAW_DRY`·이벤트를 받는다.
    //  ★기준 시한은 이벤트를 안 받는 유휴 스크립트가 받은 값이다(상수를 여기 다시 적지 않는다). 부모 환경엔 `TIGUCLAW_DRY=1` 을 켜 둔다.
    {
      const { postTimeoutMs } = await loadPluginModule<{ postTimeoutMs: (events: never, baseMs: number) => number }>("../../../plugins/computer-use/src/control.ts");
      const child = await spawnWithin(60_000, "win.ts 자식 옵션", ["--import", "tsx", fileURLToPath(new URL("./_win-exec-options-child.ts", import.meta.url))], { env: { ...process.env } });
      const line = child.out.split(/\r?\n/).find((l) => l.startsWith("WIN_EXEC "));
      type Run = { timeout: number; dry: string; events?: string };
      const got = line === undefined ? null : (JSON.parse(line.slice(9)) as { postRuns: Run[]; checkRuns: Run[] });
      const base = got?.checkRuns.find((r) => r.events === undefined)?.timeout;
      const ruled = (r: Run): boolean => base !== undefined && r.events !== undefined && r.timeout === postTimeoutMs(JSON.parse(r.events) as never, base);
      const control = got?.checkRuns.filter((r) => r.events !== undefined) ?? [];
      const dry = control.filter((r) => r.dry === "1");
      const longest = dry.reduce((m, r) => Math.max(m, (JSON.parse(r.events!) as unknown[]).length), 0);
      out.push(
        assert(
          "★★조작 스크립트의 시한은 흘리는 이벤트로 정한다 — 제품 `post`(5초 `wait` 열)와 `selfCheck` 의 빈 배열·빈 연습·탐침이 전부 `postTimeoutMs(그 이벤트)` 를 **자식에게 실제로** 넘긴다(빈 연습만 고정 시한이면 제품은 되는 열이 점검에서 죽는다)",
          got !== null && got.postRuns.length === 1 && ruled(got.postRuns[0]!) && control.length === 3 && control.every(ruled) &&
            longest > 100 && dry.some((r) => r.timeout > base!),
          got === null ? { stderr: child.err.slice(-400), timedOut: child.timedOut } : { base, post: got.postRuns.map((r) => r.timeout), check: control.map((r) => ({ timeout: r.timeout, n: (JSON.parse(r.events!) as unknown[]).length })) },
        ),
      );
      out.push(
        assert(
          "★★부모 환경에 `TIGUCLAW_DRY=1` 이 켜져 있어도 실제 조작은 `0`, 빈 연습·탐침은 `1`, 입력 0 컴파일 점검은 `0` 으로 넘어간다",
          got !== null && got.postRuns[0]?.dry === "0" && control.map((r) => r.dry).join() === "0,1,1",
          got === null ? "자식 실패" : { post: got.postRuns.map((r) => r.dry), check: control.map((r) => r.dry) },
        ),
      );
      const src = await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../plugins/computer-use/src/win.ts"), "utf8");
      out.push(
        assert(
          "실행부 루프의 입력 사이 최소 간격은 12ms 그대로다 · 누른 뒤만 `$CLICK_HOLD`(⑤ r4 — 맥에선 시간으로 못 재므로 원문으로)",
          /"\s*Start-Sleep -Milliseconds \$\(if\(\$e\.t -eq 'mousedown'\)\{\$CLICK_HOLD\}else\{12\}\)",/.test(src),
          "Start-Sleep -Milliseconds $(if($e.t -eq 'mousedown'){$CLICK_HOLD}else{12})",
        ),
      );
      // ── W5 (2026-11-24, ⑤ Windows) — 멈춤 요청 파일·빈 연습이 자식 env 로 **실제로** 넘어간다(부모 env 의 값은 안 샌다) ──
      type StopRun = Run & { stopFile?: string };
      const sr = (got as unknown as { stopRuns?: StopRun[] } | null)?.stopRuns ?? [];
      const allControl = [...(got?.postRuns ?? []), ...control] as StopRun[];
      out.push(
        assert(
          "★★W5 Windows `post`: 본 발사의 멈춤 요청 파일이 자식 env `TIGUCLAW_STOP_FILE` 로 그대로 · `dry:true` 는 `TIGUCLAW_DRY=1` · 해제 꼴·종전 발사·자가 점검은 빈 문자열을 **명시**(부모 env 값이 새지 않는다)",
          sr.length === 3 && sr[0]?.stopFile === "S:\\멈춤-요청" && sr[0]?.dry === "0" && sr[1]?.dry === "1" && sr[1]?.stopFile === "" &&
            sr[2]?.stopFile === "" && sr[2]?.dry === "0" && allControl.length === 4 && allControl.every((r) => r.stopFile === ""),
          { stopRuns: sr.map((r) => ({ stopFile: r.stopFile, dry: r.dry })), others: allControl.map((r) => r.stopFile) },
        ),
      );
      // ── 실행 정책 상속 (2026-11-24) — 자식 PowerShell 은 그 기계의 실행 정책을 따른다(`-ExecutionPolicy` 를 넘기지 않는다) ──
      type PolicyView = { frontRuns?: Run[]; argvs?: string[][]; refusal?: { calls: number; result: { ok: boolean; detail?: string } } };
      const pv = (got as unknown as PolicyView | null) ?? {};
      const argvs = pv.argvs ?? [];
      const HEAD = ["-NoProfile", "-NonInteractive", "-EncodedCommand"];
      // 본문은 마지막 한 인자 — 머리를 **토큰 단위로** 대조한다(두 스위치가 한 인자로 합쳐져도 잡는다).
      const headOk = (a: string[]): boolean => a.length === HEAD.length + 1 && HEAD.every((h, i) => a[i] === h) && /^[A-Za-z0-9+/]+=*$/.test(a[HEAD.length] ?? "");
      const expected = got === null ? -1 : got.postRuns.length + got.checkRuns.length + sr.length + (pv.frontRuns?.length ?? 0) + 1 + (pv.refusal?.calls ?? 0); // + controlInvocation 1 · 거절 구간
      out.push(
        assert(
          "★★Windows 조작·유휴 조회·자가 점검·전면창 조회·`controlInvocation` 이 자식 PowerShell 에 넘기는 인자는 `-NoProfile`·`-NonInteractive`·`-EncodedCommand`·<본문> 넷뿐 — 실행 정책(`-ExecutionPolicy`)을 넘기지 않아 그 기계의 정책을 상속한다",
          got !== null && (pv.frontRuns?.length ?? 0) === 1 && argvs.length === expected && argvs.length >= 10 && argvs.every(headOk),
          { expected, heads: argvs.map((a) => a.slice(0, -1)), front: pv.frontRuns?.length },
        ),
      );
      const rf = pv.refusal;
      out.push(
        assert(
          "★★정책 거절(종료 1 · CLIXML `PSSecurityException`)이면 본 발사는 자식 **한 번**으로 끝나 실패를 돌려준다 — 다른 방식으로 다시 띄우지 않고, 거절 사유 원문이 실린다",
          rf !== undefined && rf.calls === 1 && rf.result.ok === false && (rf.result.detail ?? "").includes("running scripts is disabled"),
          rf ?? "기록 없음",
        ),
      );
    }

    // ── W4 (2026-11-24, ⑤ Windows) — 표시 도우미 기동·컴파일 경로(가짜 csc·spawn·fs — 디스크 쓰기·삭제 0) ─────────
    {
      const child = await spawnWithin(60_000, "win.ts 도우미 기동", ["--import", "tsx", fileURLToPath(new URL("./_win-indicator-build-child.ts", import.meta.url))], { env: { ...process.env } });
      const line = child.out.split(/\r?\n/).find((l) => l.startsWith("WIN_IND "));
      type Ind = {
        race: { compiling: number; spawns: number; gone: string[] };
        control: { spawns: number; gone: string[]; exe: string; stdin: unknown; windowsHide: unknown; dry: unknown; label: unknown };
        pairs: { compiles: Array<{ target?: string; out: string; srcIsCapture: boolean; srcIsIndicator: boolean }>; renamed: Array<[string, string]>; removedBy: Record<string, string[]>; spawns: number };
        indicatorFail: { plain: string[]; virus: string[] };
        capture: { missing: { ok: boolean; detail?: string }; virus: { ok: boolean; detail?: string }; plain: { ok: boolean; detail?: string } };
        indicatorMissing: { gone: string[]; spawns: number };
        backoff: { steps: Record<string, number>; gone: string[]; spawnsOk: number; selfCheck: boolean; first: number; lastGone: string };
        backoffRecover: { compiles: number; spawns: number; afterReset: number; gone: string[] };
        captureNoBackoff: { capFirst: number; capSecond: number };
      };
      const g = line === undefined ? null : (JSON.parse(line.slice(8)) as Ind);
      const diag = g === null ? { stderr: child.err.slice(-600), timedOut: child.timedOut } : null;
      out.push(
        assert(
          "★★W4(a) 컴파일 중 `stop()` → 컴파일이 성공해도 도우미를 **띄우지 않는다**(onGone 0) · 대조군(stop 없음)은 1회 띄운다",
          g !== null && g.race.compiling === 1 && g.race.spawns === 0 && g.race.gone.length === 0 && g.control.spawns === 1 && g.control.gone.length === 0,
          diag ?? { race: g!.race, control: g!.control.spawns },
        ),
      );
      out.push(
        assert(
          "W4(b) 도우미 기동 인자: exe `tiguclaw-indicator-<해시>.exe` · stdin 파이프(고아 종료용) · `windowsHide:false` · env `TIGUCLAW_DRY=0`·문구",
          g !== null && /^tiguclaw-indicator-[0-9a-f]{12}\.exe$/.test(g.control.exe) && g.control.stdin === "pipe" && g.control.windowsHide === false &&
            g.control.dry === "0" && g.control.label === "표시 문구",
          diag ?? g!.control,
        ),
      );
      const cap = g?.pairs.compiles.find((c) => c.srcIsCapture);
      const ind = g?.pairs.compiles.find((c) => c.srcIsIndicator);
      out.push(
        assert(
          "★★W4(c) 두 종류 동시: 컴파일 2회(같은 종류 겹친 요청은 1회) · 소스↔인자↔산출이 쌍으로(캡처=/target:exe·capture-, 도우미=/target:winexe·indicator-) · 옛 exe 정리는 **같은 종류만**",
          g !== null && g.pairs.compiles.length === 2 && cap?.target === "/target:exe" && /^capture-/.test(cap.out) &&
            ind?.target === "/target:winexe" && /^indicator-/.test(ind.out) &&
            g.pairs.renamed.some(([a, b]) => /^capture-/.test(a) && /^tiguclaw-capture-[0-9a-f]{12}\.exe$/.test(b)) &&
            g.pairs.renamed.some(([a, b]) => /^indicator-/.test(a) && /^tiguclaw-indicator-[0-9a-f]{12}\.exe$/.test(b)) &&
            (g.pairs.removedBy["capture"] ?? []).join() === "tiguclaw-capture-aaaaaaaaaaaa.exe" &&
            (g.pairs.removedBy["indicator"] ?? []).join() === "tiguclaw-indicator-bbbbbbbbbbbb.exe" && g.pairs.spawns === 2,
          diag ?? g!.pairs,
        ),
      );
      const failOk = (gone: string[] | undefined): boolean =>
        gone !== undefined && gone.length === 1 && gone[0]!.includes("표시 도우미 컴파일 실패") && !gone[0]!.includes("화면 캡처");
      out.push(
        assert(
          "★★W4(d) 도우미 컴파일 실패 → onGone 1회 · «표시 도우미» 단계(캡처 문구 아님) · **일반 컴파일 오류(CS1002)는 백신 차단으로 오보하지 않는다**(원문 그대로) · 백신 모양(CS0016 virus)만 «blocked: 표시 도우미를 백신…»",
          g !== null && failOk(g.indicatorFail.plain) && failOk(g.indicatorFail.virus) &&
            !g.indicatorFail.plain[0]!.includes("blocked:") && g.indicatorFail.plain[0]!.includes("CS1002") &&
            g.indicatorFail.virus[0]!.includes("blocked: 표시 도우미를 백신"),
          diag ?? g!.indicatorFail,
        ),
      );
      out.push(
        assert(
          "W4(f) 도우미 컴파일러 없음 → onGone 1회 «표시 도우미 컴파일 실패: csc-missing … 표시 도우미를 만들 수 없습니다» · 띄움 0 · 캡처 문구 아님",
          g !== null && g.indicatorMissing.gone.length === 1 && g.indicatorMissing.spawns === 0 &&
            g.indicatorMissing.gone[0]!.includes("표시 도우미 컴파일 실패: csc-missing") && g.indicatorMissing.gone[0]!.includes("표시 도우미를 만들 수 없습니다") &&
            !g.indicatorMissing.gone[0]!.includes("화면 캡처"),
          diag ?? g!.indicatorMissing,
        ),
      );
      const st = g?.backoff.steps ?? {};
      out.push(
        assert(
          "★★W4(g) 표시 도우미 반복 실패(인계 2-3): 간격 1분·2분·…·상한 30분의 **직전엔 컴파일 0 · 도달하면 1** · 시스템 시계를 되돌려도 간격이 늘지 않음(단조 시계) · 간격 중엔 **직전** 실패 원문 + 앞머리 «이번엔 컴파일하지 않음» 안내(긴 오류에서도 300자 안) · 진단은 간격 무시 · 성공한 컴파일 뒤 한 번 띄움",
          g !== null && g.backoff.first === 60_000 && st.c1 === 1 && st.at59 === 1 && st.at60 === 2 && st.at119 === 2 && st.at120 === 3 && st.before6 === 6 && st.cap29 === 6 && st.cap30 === 7 &&
            st.diag === 8 && g.backoff.selfCheck === true && st.okCompile === 11 && st.afterOk === 11 && g.backoff.spawnsOk === 1 &&
            g.backoff.gone.every((x) => x.includes("표시 도우미 컴파일 실패")) &&
            g.backoff.gone.some((x) => /^표시 도우미 컴파일 실패: \(직전 실패 6회 — 이번엔 컴파일하지 않음, \d+초 뒤 다시\) compile: x\.cs\(1,1\): error CS1006: 실패-6$/.test(x)) &&
            g.backoff.gone.some((x) => /^표시 도우미 컴파일 실패: \(직전 실패 2회 — 이번엔 컴파일하지 않음, \d+초 뒤 다시\) compile: x\.cs\(1,1\): error CS1002: 실패-2 긴 오류/.test(x)),
          diag ?? g!.backoff,
        ),
      );
      out.push(
        assert(
          "★W4(g) 복구하면 연속 실패 수가 지워진다 — 진단 성공 직후(다른 호출 없이) exe 가 없어져 다시 실패하면 간격은 다시 1분(정각에 재컴파일) · exe 등장으로도 같다 · 간격 중 exe 가 생기면 바로 씀 · **캡처는 간격 없음**(실패 직후 다시 부르면 바로 재컴파일)",
          g !== null && st.reAfterOk === 9 && st.oneMinAgain === 10 && g.backoffRecover.compiles === 1 && g.backoffRecover.spawns === 1 && g.backoffRecover.afterReset === 3 &&
            g.captureNoBackoff.capFirst === 1 && g.captureNoBackoff.capSecond === 2,
          diag ?? { steps: st, recover: g!.backoffRecover, capture: g!.captureNoBackoff },
        ),
      );
      const missing = g?.capture.missing.detail ?? "";
      const pm = (obs.preflightMessage as (p: unknown, platform: string) => string | null)({ ok: false, reason: "failed", detail: missing }, "win32") ?? "";
      const pk = (obs.preflightFailureKind as (p: unknown, platform: string) => string)({ ok: false, reason: "failed", detail: missing }, "win32");
      out.push(
        assert(
          "★★W4(e) 캡처 제품 사슬: 컴파일러 없음의 **실제** detail 이 종전 전문 그대로 → 판독기가 .NET Framework 4 안내·«컴파일러 없음» · 백신 모양 컴파일 실패도 종전 «blocked: 화면 캡처 프로그램을 …» 그대로",
          g !== null && g.capture.missing.ok === false &&
            missing === "csc-missing: .NET Framework 4 컴파일러(csc.exe)를 찾지 못했습니다 — 화면 캡처 프로그램을 만들 수 없습니다" &&
            pm.includes(".NET Framework 4") && pk.includes("컴파일러 없음") &&
            (g.capture.virus.detail ?? "").startsWith("blocked: 화면 캡처 프로그램을 백신·보안 정책이 격리하거나 막았습니다 (") &&
            // 캡처는 종전 판정 그대로 — 산출물 없는 컴파일 실패도 «blocked»(도우미만 정밀하게 — W4(d)).
            (g.capture.plain.detail ?? "").startsWith("blocked: 화면 캡처 프로그램을 백신·보안 정책이 격리하거나 막았습니다 (compile:"),
          diag ?? { missing, pm: pm.slice(0, 80), pk, virus: g!.capture.virus.detail?.slice(0, 80), plain: g!.capture.plain.detail?.slice(0, 80) },
        ),
      );
    }

    // ── W6·W8 (2026-11-24, ⑤ Windows) — 실행부·도우미 원문과 순수부(맥에선 PowerShell·C# 를 못 돌린다) ─────────
    {
      const winMod = (await loadPluginModule<Record<string, unknown>>("../../../plugins/computer-use/src/win.ts")) as {
        CONTROL_SCRIPT?: string;
        INDICATOR_CS: string;
        staleExe: (name: string, prefix: string, keep: string) => boolean;
        controlEnv: (events: unknown[], dry: boolean, stopFile?: string) => Record<string, string>;
      };
      const src = await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../plugins/computer-use/src/win.ts"), "utf8");
      const ctl = src.slice(src.indexOf("const CONTROL_SCRIPT = ["), src.indexOf('].join("\\n");', src.indexOf("const CONTROL_SCRIPT = [")));
      const markLine = ctl.split("\n").find((l) => l.includes("$e.t -eq 'mark'")) ?? "";
      const waitLine = ctl.split("\n").find((l) => l.includes("$e.t -eq 'wait'")) ?? "";
      const sendLine = ctl.split("\n").find((l) => l.includes("function Send($i)")) ?? "";
      const waitFn = ctl.slice(ctl.indexOf("function WaitOrStop($ms)"), ctl.indexOf("\"$CUR = -1"));
      const shape = {
        readsStopFile: /\$STOPF = \[string\]\$env:TIGUCLAW_STOP_FILE/.test(ctl) && /function StopAsked\(\)\{ return \(\(\$STOPF -ne ''\) -and \[IO\.File\]::Exists\(\$STOPF\)\) \}/.test(ctl),
        markStopsBeforeStep: markLine.indexOf("if(StopAsked)") >= 0 && markLine.indexOf("if(StopAsked)") < markLine.indexOf("Emit(") && markLine.includes('\\"why\\":\\"user-esc\\"'),
        waitInterruptible: waitLine.includes("if(WaitOrStop ([int]$e.ms))") && waitLine.includes('\\"why\\":\\"user-esc\\"') && /while\(\$sw\.ElapsedMilliseconds -lt \$ms\)\{/.test(waitFn) && waitFn.includes("if(StopAsked){ return $true }"),
        triedBeforeDry: sendLine.indexOf("$script:TRIED = $script:TRIED + 1") >= 0 && sendLine.indexOf("$script:TRIED") < sendLine.indexOf("if($DRY){ return }"),
        finalHasTried: /\\"tried\\":' \+ \$TRIED/.test(ctl),
        noKeyRead: !/GetAsyncKeyState|GetKeyState|GetKeyboardState/.test(ctl),
      };
      out.push(assert("★W6 Windows 실행부 원문: 멈춤 파일을 읽고 · `mark` 는 진행 줄 **앞**에서 멈춤 확인 · `wait` 는 기한 루프 안에서 확인 · `$TRIED` 는 빈 연습 return **앞** · 최종 줄에 tried · 실행부는 키를 안 읽는다", Object.values(shape).every(Boolean), shape));
      // 실행부가 내는 멈춤 줄을 공통 판독기가 그대로 읽는다(그 문자열 모양 그대로 — `$CUR`·`$e.i` 자리에 숫자).
      const { stepsOutcome } = await loadPluginModule<{ stepsOutcome: (so: string, n: number, ok: boolean) => { status: string[]; stoppedAt?: { i: number; why: string } } }>("../../../plugins/computer-use/src/control.ts");
      const emitted = markLine.match(/'\{\\"stopped\\":' \+ \[int\]\$e\.i \+ '(,\\"why\\":\\"user-esc\\",\\"saw\\":\\"\\"\})'/)?.[1]?.replace(/\\"/g, '"') ?? "";
      const oc = stepsOutcome(`{"step":0}\n{"stopped":1${emitted}\n`, 3, true);
      out.push(assert("W6 Windows 멈춤 줄 → 공통 판독: 멈춘 단계 1 · why user-esc · 그 단계부터 «미실행»", emitted !== "" && oc.stoppedAt?.i === 1 && oc.stoppedAt.why === "user-esc" && oc.status.join() === "완료,미실행,미실행", { emitted, oc }));
      const cs = winMod.INDICATOR_CS;
      const keyCalls = [...cs.matchAll(/GetAsyncKeyState\(([^)]*)\)/g)].map((m) => m[1]);
      const ishape = {
        escOnly: keyCalls.length === 2 && keyCalls.includes("int vKey") && keyCalls.includes("VK_ESCAPE") && /const int VK_ESCAPE = 0x1B;/.test(cs),
        noCollect: !/SetWindowsHookEx|RegisterRawInputDevices|GetKeyboardState|GetKeyState\(|RegisterHotKey/.test(cs),
        noFocus: !/SetForegroundWindow|\.Activate\(|\.Focus\(|\.TopMost|BringToFront/.test(cs),
        // ⑤ r4: 기본 = LAYERED·NOACTIVATE·TOOLWINDOW·TOPMOST, 클릭 통과(TRANSPARENT)는 중지 단추(Label)가 아닌 창만.
        exStyle: /cp\.ExStyle \|= 0x00080000 \| 0x08000000 \| 0x00000080 \| 0x00000008;/.test(cs) && /if \(kind != Kind\.Label\) cp\.ExStyle \|= 0x00000020;/.test(cs),
        noActivate: /protected override bool ShowWithoutActivation \{ get \{ return true; \} \}/.test(cs) && !/=>/.test(cs),
        noDialog: /SetUnhandledExceptionMode\(UnhandledExceptionMode\.ThrowException\)/.test(cs) && /catch \(Exception ex\) \{ Fail\(ex\); \}/.test(cs),
        dryFirst: cs.indexOf('Emit("{\\"ready\\":1,\\"dry\\":1,\\"glow\\":" + GlowProbe() + "}")') >= 0 && cs.indexOf('Emit("{\\"ready\\":1,\\"dry\\":1,\\"glow\\":" + GlowProbe() + "}")') < cs.indexOf("new Overlay(") && cs.indexOf('Emit("{\\"ready\\":1,\\"dry\\":1,\\"glow\\":" + GlowProbe() + "}")') < cs.indexOf("ShowGlow(s.Bounds)") && cs.indexOf('Emit("{\\"ready\\":1,\\"dry\\":1,\\"glow\\":" + GlowProbe() + "}")') < cs.indexOf("GetAsyncKeyState(VK_ESCAPE)"),
        orphanExit: /while \(Console\.In\.Read\(\) >= 0\) \{\}/.test(cs) && /Environment\.Exit\(0\);/.test(cs),
        noInterp: !/\$"/.test(cs),
      };
      out.push(assert("★★W7 도우미 원문: 묻는 키는 Esc 하나 · 훅·원시 입력·키보드 상태·핫키 없음 · 포커스 가져오기 없음 · 비활성·클릭 통과·툴창·맨위 확장 스타일 · C# 5(식 본문·보간 없음) · 예외 대화상자 없음 · 빈 연습이 창·키보다 먼저 · stdin EOF 종료", Object.values(ishape).every(Boolean), ishape));
      // ── W10 (⑤ r4) 원격 표시·중지 단추·단추 자리 응답·미끄러짐 — Windows 는 이 기계에서 못 돌리므로 원문으로 ──
      const glideBlock = ctl.slice(ctl.indexOf("elseif($e.t -eq 'glide'){"), ctl.indexOf("elseif($e.t -eq 'guard'){"));
      const tick = cs.slice(cs.indexOf("if (pillShown && movePath != \"\") {"), cs.indexOf("Point p = Cursor.Position;"));
      const r4 = {
        // 화면 공유 도구가 캡처로 화면을 보내므로 캡처 제외를 걸면 원격에 안 보인다.
        noCaptureExclusion: !/SetWindowDisplayAffinity|WDA_EXCLUDEFROMCAPTURE|0x11\)/.test(cs),
        buttonStops: /tag\.Clicked = delegate \(\) \{ Emit\("\{\\"stop\\":1\}"\); \};/.test(cs) && /if \(kind == Kind\.Label && Clicked != null\) Clicked\(\);/.test(cs),
        clickNoActivate: /if \(m\.Msg == WM_MOUSEACTIVATE\) \{ m\.Result = new IntPtr\(MA_NOACTIVATE\); return; \}/.test(cs) && /WM_MOUSEACTIVATE = 0x0021, MA_NOACTIVATE = 3/.test(cs),
        neverPassThrough: !/SetWindowLong|GetWindowLong/.test(cs) && (cs.match(/0x00000020/g) ?? []).length === 1,
        // 준비 줄 = 단추를 띄운 **뒤**, 실제 사각형과 함께(못 읽으면 내리고 null) · 자리 파일 없음(출력 줄로만).
        readyAfterShow: cs.indexOf("tag.Show();") >= 0 && cs.indexOf("tag.Show();") < cs.indexOf('Emit("{\\"ready\\":1,\\"pill\\":" + PillJson(tag, ref pillShown) + "}");') &&
          !/TIGUCLAW_INDICATOR_PILL|WritePill|WriteNone/.test(cs),
        pillJsonHidesOnUnknown: /if \(shown && GetWindowRect\(tag\.Handle, out wr\)\) return/.test(cs) && /if \(shown\) \{ tag\.Hide\(\); shown = false; \}\s*return "null";/.test(cs),
        // 비킴: ';' 로 끝난 새 요청만 · 옮김 실패면 위·아래 표식을 되돌림(옛 사각형을 응답) · 응답은 실제 사각형 + 요청 그대로.
        moveAnswered: /if \(mv != lastMove && mv\.EndsWith\(";"\)\) \{/.test(tick) &&
          /if \(!SetWindowPos\(tag\.Handle, HWND_TOPMOST, pillX, y, 0, 0, SWP_NOSIZE \| SWP_NOACTIVATE\)\) atTop = !atTop;/.test(tick) &&
          /Emit\("\{\\"pill\\":" \+ PillJson\(tag, ref pillShown\) \+ ",\\"req\\":\\"" \+ Esc\(mv\) \+ "\\"\}"\);/.test(tick),
        flash: /Control\.MouseButtons != MouseButtons\.None/.test(cs) && /halo\.SetFlash\(/.test(cs),
        envMove: /TIGUCLAW_INDICATOR_MOVE: o\.moveFile \}/.test(src) && !/TIGUCLAW_INDICATOR_PILL/.test(src),
        // 끝남 확인: 컴파일 중 멈춤·컴파일 실패는 바로 끝남 · 띄웠으면 그 자식의 close.
        closedContract: /if \(inner === null\) markClosed\(\);/.test(src) && /void inner\.closed\.then\(markClosed\);/.test(src) && /if \(stopped\) \{\s*markClosed\(\);/.test(src),
        // 실행부는 단추를 모른다 · glide 는 보간 좌표를 실제로 `Mouse` 로 보내고(발사 한 줄이 빠지면 빨강) 도중·끝 멈춤을 본다.
        execUnawareOfPill: !/PILL|ClearOfPill|PillRect|MOVEF|STEP_PRESSED/.test(ctl),
        glideFires: /Mouse \(\[int\]\[Math\]::Round\(\$c0\.X \+ \$gdx \* \$gs\)\) \(\[int\]\[Math\]::Round\(\$c0\.Y \+ \$gdy \* \$gs\)\) 0 0/.test(glideBlock) && /\[System\.Windows\.Forms\.Cursor\]::Position/.test(glideBlock),
        glideStops: /if\(StopAsked\)\{ \$gstop = \$true; break \}/.test(glideBlock) && /if\(\(-not \$gstop\) -and \(StopAsked\)\)\{ \$gstop = \$true \}/.test(glideBlock),
        // 0.1초 후보: 길이는 Stopwatch 경과 시간(박자 수 아님) · ease-out 3차(목표 직전 감속) · 시간 상한·최소·거리비 상수가 박혀 있다.
        glideTimedEaseOut: glideBlock.includes("$gu = [Math]::Min(1.0, $gsw.Elapsed.TotalMilliseconds / $gT); $gs = 1 - (1 - $gu) * (1 - $gu) * (1 - $gu)") &&
          glideBlock.includes("$gsw = [Diagnostics.Stopwatch]::StartNew()") && /while\(\$gu -lt 1\)\{/.test(glideBlock) &&
          // 거리 → 시간: 0 거리는 반복 없음 · 양수 거리는 최소 + 거리비, 상한으로 자름(이 대입이 위 나눗셈의 $gT 다).
          glideBlock.includes("$gd = [Math]::Sqrt($gdx * $gdx + $gdy * $gdy)") &&
          glideBlock.includes("$gT = 0.0; if($gd -gt 0){ $gT = [Math]::Min([double]$GLIDE_MAX, $GLIDE_MIN + $gd * $GLIDE_PER_PX) }") &&
          glideBlock.includes("$gu = 0.0; if($gT -le 0){ $gu = 1.0 }") &&
          src.includes("`$GLIDE_MAX = ${String(GLIDE_MAX_MS)}; $GLIDE_MIN = ${String(GLIDE_MIN_MS)}; $GLIDE_PER_PX = ${String(GLIDE_MS_PER_PX)}; $GLIDE_TICK = ${String(GLIDE_TICK_MS)};"),
        dryHasGlide: /\{ t: "glide", x: 0, y: 0 \},\n  \{ t: "mousemove", x: 0, y: 0 \},/.test(src.slice(src.indexOf("const DRY_EVENTS"))),
      };
      // ── W11 (⑤ 외형 확정) 가장자리 주황 빛 — 맥과 같은 `GLOW` 값 · 픽셀 알파 띠 창 · 빛 실패가 단추를 끌어내리지 않는다 ──
      const { GLOW } = await loadPluginModule<{ GLOW: { width: number; alpha: number; falloff: number; rgb: readonly number[] } }>("../../../plugins/computer-use/src/indicator.ts");
      // ★주석은 코드가 아니다 — 주석 처리된 옛 줄이 판정에 걸리지 않게 C# 주석을 뺀 원문으로 본다(R3; 이 원문의 문자열 안엔 `//`·`/*` 가 없다).
      //  ★한 번에 왼쪽부터 — 줄 주석 안의 `/*` 는 블록 주석을 열지 않는다(`// /*` … `// */` 사이 실행 코드를 지우면 안 된다, R4).
      const code = cs.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
      const fn = (head: string): string => { const i = code.indexOf(head); const j = code.indexOf("\n  }\n", i); return i < 0 || j < 0 ? "" : code.slice(i, j); };
      const showGlow = fn("static void ShowGlow(Rectangle s) {");
      const strip = fn("static int[] GlowStrip(Rectangle s, Rectangle r, double k, int band) {");
      const parts = fn("static Rectangle[] GlowParts(Rectangle s, int band) {");
      const probeFn = fn("static string GlowProbe() {");
      const scaleFn = fn("static double ScaleOf(Rectangle s) {");
      const setPx = code.slice(code.indexOf("public void SetPixels(Rectangle r, int[] px) {"), code.indexOf("protected override void OnPaint("));
      const glow = {
        sameValues: code.includes(`const double GLOW_W = ${String(GLOW.width)}, GLOW_A = ${String(GLOW.alpha)}, GLOW_P = ${String(GLOW.falloff)};`) &&
          code.includes(`const int GLOW_R = ${String(GLOW.rgb[0])}, GLOW_G = ${String(GLOW.rgb[1])}, GLOW_B = ${String(GLOW.rgb[2])};`) &&
          src.includes("const double GLOW_W = ${String(GLOW.width)}, GLOW_A = ${String(GLOW.alpha)}, GLOW_P = ${String(GLOW.falloff)};"),
        formula: code.includes("double t = Math.Floor(d / k);") && code.includes("if (t >= GLOW_W) return 0;") && code.includes("double a = GLOW_A * Math.Pow(1 - t / GLOW_W, GLOW_P);") &&
          code.includes("return ((int)Math.Round(a * 255) << 24) | ((int)Math.Round(GLOW_R * a) << 16) | ((int)Math.Round(GLOW_G * a) << 8) | (int)Math.Round(GLOW_B * a);"),
        // 화면마다 · 실제 모니터 배율(GetDpiForMonitor, 96 = 1배)로 — 못 읽을 때만 1
        perScreen: code.includes("try { foreach (Screen s in Screen.AllScreens) ShowGlow(s.Bounds); } catch (Exception) {}") &&
          showGlow.includes("double k = ScaleOf(s);") && showGlow.includes("int band = GlowBand(s, k);") &&
          // 그 화면 **가운데 점**의 모니터 핸들로 DPI 를 읽는다(보조 화면이 다른 배율이면 그 배율)
          scaleFn.includes("IntPtr m = MonitorFromPoint(new POINT(s.X + s.Width / 2, s.Y + s.Height / 2), 2);") &&
          scaleFn.includes("GetDpiForMonitor(m, 0, out dx, out dy) == 0 && dx > 0) return dx / 96.0;"),
        // 띠 넷이 겹치지 않는다(위·아래 전체 폭 · 좌우는 그 사이) · 거리는 화면 네 변까지의 최솟값
        fourBands: parts.includes("new Rectangle(s.X, s.Y, s.Width, band), new Rectangle(s.X, s.Bottom - band, s.Width, band),") &&
          parts.includes("new Rectangle(s.X, s.Y + band, band, s.Height - 2 * band), new Rectangle(s.Right - band, s.Y + band, band, s.Height - 2 * band) };") &&
          strip.includes("int d = Math.Min(Math.Min(sx, sy), Math.Min(s.Width - 1 - sx, s.Height - 1 - sy));"),
        // 빛 실패는 그 띠만 — 픽셀 준비·창 생성·표시·픽셀 올리기가 **전부** 띠의 try 안 · 화면 목록·배율도 Run 에서 감싼다 · Fail 없음
        failLocal: /foreach \(Rectangle r in GlowParts\(s, band\)\) \{\s*Overlay o = null;\s*try \{\s*int\[\] px = GlowStrip\(s, r, k, band\);\s*o = new Overlay\(r, Overlay\.Kind\.Glow, Color\.Empty, ""\);\s*o\.Show\(\);\s*o\.SetPixels\(r, px\);\s*\} catch \(Exception\) \{ if \(o != null\) \{ try \{ o\.Close\(\); \} catch \{\} \} \}/.test(showGlow) &&
          !showGlow.includes("Fail(") && code.indexOf("ShowGlow(s.Bounds)") < code.indexOf("tag.Show();"),
        // 픽셀 알파: 받은 배열을 그대로 DIB 에 복사 · 위아래 뒤집지 않은 32비트 · 미리 곱한 알파(AC_SRC_ALPHA=1) · ULW_ALPHA(2) · 색 키는 빛 창에 안 건다
        // 픽셀을 쓴 그 DIB(bits ↔ bmp)를 ULW 원본 DC(mem)에 **선택한 뒤** 넘긴다 — 선택이 빠지면 복사는 되고 화면엔 안 간다
        dibToUlw: ((o: number[]) => o.every((v) => v >= 0) && o.every((v, i) => i === 0 || o[i - 1]! < v))([
          setPx.indexOf("IntPtr mem = CreateCompatibleDC(screen);"),
          setPx.indexOf("IntPtr bmp = CreateDIBSection(screen, ref bi, 0, out bits, IntPtr.Zero, 0);"),
          setPx.indexOf("Marshal.Copy(px, 0, bits, px.Length);"),
          setPx.indexOf("old = SelectObject(mem, bmp);"),
          setPx.indexOf("UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref bf, 2)"),
        ]),
        perPixelAlpha: setPx.includes("bi.biHeight = -r.Height; bi.biPlanes = 1; bi.biBitCount = 32;") && setPx.includes("Marshal.Copy(px, 0, bits, px.Length);") &&
          setPx.includes("bf.SourceConstantAlpha = 255; bf.AlphaFormat = 1;") && setPx.includes("UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref bf, 2)") &&
          /if \(kind != Kind\.Glow\) \{\s*BackColor = kind == Kind\.Label \? tint : Key;\s*TransparencyKey = Key;\s*\}/.test(code),
        // 빈 연습 표본은 화면 경로와 **같은 함수**(GlowBand·GlowParts·GlowStrip)를 지난다 — W(vi) 가 Windows 에서 그 값을 판정한다
        probeSamePath: probeFn.includes("int band = GlowBand(s, ks[i]);") && probeFn.includes("Rectangle[] parts = GlowParts(s, band);") && probeFn.includes("strips[j] = GlowStrip(s, parts[j], ks[i], band);"),
        noOldBorder: !/Kind\.Border|new Pen\(tint, 4\)|DrawRectangle\(/.test(code),
        // 단추·고리 디자인은 그대로(같은 주황 tint · 고리 3→7 · 단추 글자)
        pillHaloKept: code.includes("Color tint = Color.FromArgb(255, 140, 0);") && code.includes("using (Pen pen = new Pen(tint, flash ? 7 : 3)) e.Graphics.DrawEllipse(pen, 4, 4, Width - 8, Height - 8);") &&
          code.includes("new Overlay(new Rectangle(pillX, topY, lw, lh), Overlay.Kind.Label, tint, label);"),
      };
      out.push(assert("★W11 (⑤ 외형) Windows 도우미 원문: 가장자리 빛 = 맥과 같은 GLOW 값·식(모니터 배율로 나눈 거리 내림) · 화면마다 겹치지 않는 띠 넷 · 띠 배열을 그대로 픽셀 알파 창에(미리 곱한 BGRA·ULW_ALPHA, 색 키 없음) · 빛 준비~표시 실패는 그 띠만(단추 전에 끝남) · 빈 연습 표본이 같은 띠 함수를 지남 · 옛 4px 테두리 없음 · 단추·고리 그대로", Object.values(glow).every(Boolean), glow));
      out.push(assert("★W10 (⑤ r4) Windows 원문: 캡처 제외 없음(원격에 보임) · 단추 클릭 = `{\"stop\":1}` · 클릭해도 비활성 · 단추 통과 모드 없음 · 준비 줄은 띄운 뒤 실제 사각형과 · 사각형 모름이면 내림 · 비킴 응답은 실제 사각형 + 요청 · 눌림 번쩍임 · 끝남 확인 계약 · 실행부는 단추를 모름 · glide 는 보간 좌표를 쏘고 도중·끝 멈춤 · 자가점검 표본에 glide", Object.values(r4).every(Boolean), r4));
      const keep = "tiguclaw-indicator-111111111111.exe";
      const st = {
        oldSame: winMod.staleExe("tiguclaw-indicator-222222222222.exe", "indicator", keep),
        current: winMod.staleExe(keep, "indicator", keep),
        otherKind: winMod.staleExe("tiguclaw-capture-222222222222.exe", "indicator", keep),
        tmp: winMod.staleExe("indicator-1234.tmp.exe", "indicator", keep),
        capOld: winMod.staleExe("tiguclaw-capture-222222222222.exe", "capture", "tiguclaw-capture-111111111111.exe"),
      };
      const env0 = winMod.controlEnv([], false);
      out.push(
        assert(
          "W8 순수부: `staleExe` 는 같은 종류 옛 해시만(현재·다른 종류·임시 거짓) · `cscArgs` 기본 /target:exe(종전) · `controlEnv` 는 멈춤 파일·빈 연습을 언제나 명시",
          st.oldSame && !st.current && !st.otherKind && !st.tmp && st.capOld &&
            cscArgs("a.cs", "b.exe").join(" ") === "/nologo /target:exe /optimize+ /out:b.exe /r:System.Drawing.dll /r:System.Windows.Forms.dll a.cs" &&
            env0.TIGUCLAW_STOP_FILE === "" && env0.TIGUCLAW_DRY === "0" && winMod.controlEnv([], true, "F").TIGUCLAW_STOP_FILE === "F",
          { st, env0 },
        ),
      );
    }

    // ── ② 실행부는 **Windows 에서만** 돌린다 ──────────────────────────────────
    if (process.platform !== "win32") {
      out.push(
        assert(
          "Windows 가 아님 — 실행부 스모크는 **대상이 없다**(맥·리눅스엔 `SendInput` 이 없다)",
          true,
          `platform=${process.platform} · 이 축은 Windows 기계에서만 의미가 있다`,
        ),
      );
      return out;
    }

    const r = await selfCheck();
    out.push(
      assert(
        "★**제품이 만드는 스크립트가 실제로 돈다** — 컴파일 + **대표 이벤트 빈 연습**(입력 0)",
        r.ok,
        r.ok ? `유휴 ${String(r.idleSeconds)}초` : `${r.where} 에서 실패: ${r.detail.slice(0, 160)}`,
      ),
    );
    out.push(
      assert(
        "★유휴 시간을 **숫자로** 읽는다 — 못 읽으면 조작이 «모른다» 로 전부 막힌다",
        r.ok && typeof r.idleSeconds === "number",
        r.ok ? `idle=${String(r.idleSeconds)}` : "실행부 실패로 판정 불가",
      ),
    );
    // ── ③ **한글이 살아서 돌아오는가** (2026-09-18, 회사돌쇠 3차 P1) ─────────
    //  ★Windows PowerShell 은 stdout 을 **그 기계의 코드 페이지**로 낸다(한국어면 CP949).
    //   Node 는 UTF-8 로 읽는다. 실기에서 오류 하나가 «U+FFFD 82개 · 한글 0자» 로 왔다 —
    //   되돌릴 수 없는 손실이라 하류에서 복구가 안 된다. **한국어만의 문제가 아니다**:
    //   ASCII 밖 글자는 어느 언어든 같은 길로 사라진다. 그래서 우리 문구를 찾지 않고
    //   **보낸 글자가 그대로 돌아오는지**를 잰다(한글·악센트·한자·이모지를 한 번에).
    // ★★**빈 연습이면 «쏜 횟수» 가 0이어야 한다** (2026-09-19, 아스트라 §4).
    //  종전 `sent` 는 루프 **밖에서 «받은 항목 수»** 를 세어, **한 번도 안 쐈는데 같은 수**가
    //  나왔다. 이름이 «보냈다» 라 읽는 쪽을 속였고, 실기에서 «`{ok:true,sent:1}` 인데 0자» 가
    //  나왔을 때 그 수가 **아무것도 보장하지 않는다**는 것이 드러났다.
    //  ★이 검사는 그 이름이 **뜻대로 도는지**를 잰다 — 빈 연습에서 0이 아니면 거짓말이다.
    out.push(
      assert(
        "★★**빈 연습에서 «쏜 횟수» 가 0이다** — 이름이 뜻대로 돌지 않으면 그게 다음 오진이다",
        r.ok && r.dryFired === 0,
        r.ok ? `dryFired=${String(r.dryFired)} (이벤트 13개를 흘렸지만 발사 0이어야 한다)` : "실행부 실패로 판정 불가",
      ),
    );
    // ★★**가드가 «빈 연습에서 실제로 멈추는가»** (2026-09-19, 정태님이 «윈도우도 됐나» 로
    //  물어 드러났다). `mark`·`wait`·`guard` 를 **맥에만** 넣었고 Windows 루프엔 `else` 가
    //  없어 **조용히 건너뛰었다** — 가드가 없으니 남의 창에 글자가 들어가고, `mark` 가
    //  없으니 시한 초과 때 실행된 step 을 「미실행」으로 보고해 **두 번 누르게** 된다.
    //  그런데도 이 스위트는 전부 초록이었다. 그 침묵을 깨는 단언이다.
    out.push(
      assert(
        "★★빈 연습의 **어긋난 가드에서 실제로 멈춘다** — 「넣었다」와 「돈다」는 다르다",
        r.ok && r.dryStopped,
        r.ok ? `dryStopped=${String(r.dryStopped)}` : "실행부 실패로 판정 불가",
      ),
    );
    out.push(
      assert(
        "★**ASCII 밖 글자가 깨지지 않고 돌아온다** — «왜» 를 나르는 마지막 한 걸음",
        r.ok && r.textSurvives,
        r.ok ? `textSurvives=${String(r.textSurvives)}` : "실행부 실패로 판정 불가",
      ),
    );
    // ── ③-b Esc 멈춤 요청 파일 — **Windows 에서만**, 빈 연습(입력 0) (2026-11-24, ⑤ Windows 설계 §5 (i)~(v)) ─────────
    //  ★제품과 같은 스크립트·인자·env(`controlInvocation`)로 띄워 **흘려 읽는다** — 진행 줄을 본 뒤 파일을 만들어야
    //   «`wait` 도중 멈춤» 이 결정적이다(`post` 는 끝날 때 한 번에 읽는다).
    {
      const winX = (await loadPluginModule<Record<string, unknown>>("../../../plugins/computer-use/src/win.ts")) as {
        controlInvocation: (events: unknown[], dry: boolean, stopFile?: string) => { file: string; args: string[]; env: Record<string, string> };
        post: (events: unknown[], signal?: AbortSignal, opts?: { stopFile?: string; dry?: boolean }) => Promise<{ ok: boolean; stdout?: string; detail?: string }>;
        indicatorSelfCheck: () => Promise<{ ok: true; stdout: string } | { ok: false; detail: string }>;
      };
      const { spawn: spawnChild } = await import("node:child_process");
      const stopDir = await fs.mkdtemp(path.join(os.tmpdir(), "cu-win-stop-"));
      const last = (so: string): { tried?: number; fired?: number; stopped?: { stopped?: number; why?: string } | null } => {
        try { return JSON.parse(so.trim().split(/\r?\n/).pop() ?? "") as never; } catch { return {}; }
      };
      // ★시간은 **PowerShell 기동을 빼고** 잰다 — 줄이 도착한 시각(`at`)과 종료 시각(`closeAt`)을 돌려준다.
      const stream = (events: unknown[], stopFile: string, onLine: (l: string) => void): Promise<{ so: string; at: Map<string, number>; closeAt: number }> =>
        new Promise((resolve) => {
          const inv = winX.controlInvocation(events, true, stopFile);
          const child = spawnChild(inv.file, inv.args, { env: { ...process.env, ...inv.env }, windowsHide: true });
          let so = "";
          let buf = "";
          const at = new Map<string, number>();
          child.stdout.on("data", (c: Buffer) => {
            so += c.toString("utf8");
            buf += c.toString("utf8");
            for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
              const l = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!at.has(l)) at.set(l, Date.now());
              onLine(l);
            }
          });
          child.on("close", () => resolve({ so, at, closeAt: Date.now() }));
        });
      try {
        const KEY_A = [{ t: "keydown", key: "a" }, { t: "keyup", key: "a" }];
        const KEY_B = [{ t: "keydown", key: "b" }, { t: "keyup", key: "b" }];
        const seq = [{ t: "mark", i: 0 }, ...KEY_A, { t: "mark", i: 1 }, { t: "wait", ms: 3000 }, { t: "mark", i: 2 }, ...KEY_B, { t: "unicode", text: "가" }];
        // (i) 파일이 미리 있다 → 첫 단계 전에 멈춤 · 시도 0
        const pre = path.join(stopDir, "pre");
        await fs.writeFile(pre, "");
        const ri = await stream(seq, pre, () => {});
        const vi = last(ri.so);
        out.push(assert("★W(i) 멈춤 파일이 이미 있으면 첫 단계 **시작 전**에 멈춘다 — stopped 0 · why user-esc · 시도(tried) 0", vi.stopped?.stopped === 0 && vi.stopped.why === "user-esc" && vi.tried === 0, { last: vi }));
        // (ii) 1번째 단계 진행 줄을 본 뒤 파일 생성 → wait 도중 멈춤 · 그 단계부터 미실행 · 시도 = 앞 단계의 2.
        //  시간은 **파일을 만든 순간부터 자식 종료까지**(기동 시간 제외).
        const mid = path.join(stopDir, "mid");
        let fileAt = 0;
        const rii = await stream(seq, mid, (l) => { if (l === '{"step":1}') { fileAt = Date.now(); void fs.writeFile(mid, ""); } });
        const vii = last(rii.so);
        const stopMs = fileAt === 0 ? -1 : rii.closeAt - fileAt;
        out.push(assert("★★W(ii) `wait 3000` 도중 멈춤 파일 → 그 자리에서 끝난다 · stopped 1 · user-esc · tried 2(앞 단계만) · 파일 생성→종료 1.5초 미만", vii.stopped?.stopped === 1 && vii.stopped.why === "user-esc" && vii.tried === 2 && stopMs >= 0 && stopMs < 1500, { last: vii, stopMs }));
        // (iii) 대조군 — 파일 없음 → 끝까지 · 시도는 B 와 유니코드까지 센다 · `wait` 는 step 1 → step 2 사이 실측(최소 ms 하한)
        const riii = await stream(seq, path.join(stopDir, "none"), () => {});
        const viii = last(riii.so);
        const s1 = riii.at.get('{"step":1}');
        const s2 = riii.at.get('{"step":2}');
        const waitMs = s1 === undefined || s2 === undefined ? -1 : s2 - s1;
        // 성공해도 실측값을 남긴다 — 러너는 실패한 단언의 값만 찍고, Windows 인계 §5 ⑫ 가 이 숫자를 회신받는다.
        console.log(`W(iii) waitMs=${String(waitMs)}`);
        out.push(assert("W(iii) 대조군: 멈춤 파일이 없으면 끝까지 간다(stopped 없음) · `wait 3000` 실측(step1→step2) ≥ 2950ms(짧아지지 않았다) · 시도는 6(A 2 · B 2 · 유니코드 '가' down/up 2)", (viii.stopped ?? null) === null && viii.tried === 6 && waitMs >= 2950, { last: viii, waitMs }));
        // (iv) 제품 사슬 — post(…,{dry, stopFile}) 가 env 로 넘겨 실행부가 멈춘다
        //  (stopped 0 = 첫 `mark` 에서 멈춤 = 뒤의 `wait` 는 시작도 안 했다 — 기동 시간이 섞이는 시간 단언은 두지 않는다)
        const riv = await winX.post([{ t: "mark", i: 0 }, { t: "wait", ms: 3000 }, { t: "mark", i: 1 }, ...KEY_A], undefined, { dry: true, stopFile: pre });
        const viv = last(riv.stdout ?? "");
        out.push(assert("★★W(iv) 제품 `post(…,{dry:true, stopFile})` → 자식 env → 실행부가 첫 단계 전에 멈춘다(stopped 0 · user-esc · tried 0)", riv.ok && viv.stopped?.stopped === 0 && viv.stopped.why === "user-esc" && viv.tried === 0, { riv: riv.ok ? viv : riv.detail }));
        // (v) 도우미 — 대상 기계의 csc.exe 로 컴파일(C# 5 판정) + 빈 연습(창·키 0)
        const rv = await winX.indicatorSelfCheck();
        out.push(assert("★★W(v) 표시 도우미가 이 기계의 Framework 4 csc.exe 로 컴파일되고 빈 연습 줄 `{\"ready\":1,\"dry\":1}` 을 낸다(창·키 0)", rv.ok && /"ready":1/.test(rv.stdout) && /"dry":1/.test(rv.stdout), rv.ok ? rv.stdout.trim() : rv.detail.slice(0, 300)));
        // (vi) 가장자리 빛 — 컴파일된 도우미가 **실제 띠 경로**로 합성 화면 300×200 을 배율 1·1.5 로 만든 표본을 GLOW 식으로 따로 계산한 값과 대조
        //  (점마다 덮인 띠 수·미리 곱한 A·R·G·B 채널 ±1 · 띠 넓이 합 = 테두리 고리 넓이 — 겹침·빠짐 없음)
        const { glowAlphaAt, GLOW: G } = await loadPluginModule<{ glowAlphaAt: (d: number) => number; GLOW: { width: number; rgb: readonly number[] } }>("../../../plugins/computer-use/src/indicator.ts");
        type Probe = { k: number; band: number; area: number; px: Array<[number, number, number, number]> };
        const probe = ((): Probe[] => { try { return (JSON.parse(rv.ok ? rv.stdout.trim().split("\n").pop() ?? "" : "") as { glow?: Probe[] }).glow ?? []; } catch { return []; } })();
        const SW = 300, SH = 200;
        const bad: unknown[] = [];
        for (const k of [1, 1.5]) {
          const pr = probe.find((p) => p.k === k);
          const band = Math.min(Math.ceil(G.width * k), Math.floor(Math.min(SW, SH) / 2));
          if (pr === undefined || pr.band !== band || pr.area !== SW * SH - (SW - 2 * band) * (SH - 2 * band) || pr.px.length !== 11) { bad.push({ k, pr: pr && { band: pr.band, area: pr.area, n: pr.px.length }, band }); continue; }
          for (const [x, y, hits, v] of pr.px) {
            const d = Math.min(x, y, SW - 1 - x, SH - 1 - y);
            const a = d < band ? glowAlphaAt(d / k) : 0;
            const want = [Math.round(a * 255), Math.round(G.rgb[0]! * a), Math.round(G.rgb[1]! * a), Math.round(G.rgb[2]! * a)];
            const got = [Math.floor(v / 2 ** 24) % 256, Math.floor(v / 2 ** 16) % 256, Math.floor(v / 2 ** 8) % 256, v % 256];
            if (hits !== (d < band ? 1 : 0) || got.some((c, j) => Math.abs(c - want[j]!) > 1)) bad.push({ k, x, y, hits, got, want });
          }
        }
        out.push(assert("★W(vi) 컴파일된 도우미의 가장자리 빛(실제 띠 경로, 배율 1·1.5) = GLOW 식 — 점마다 띠 하나만 덮음·가운데는 안 덮음 · 미리 곱한 A·R·G·B ±1 · 띠 넓이 합 = 고리 넓이", probe.length === 2 && bad.length === 0, { bad, probe }));
      } finally {
        await fs.rm(stopDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // ── ④ **관측이 «조작으로 이어질 수 있는» 값을 내는가** (3차 P0) ──────────
    //  ★순수부도 초록, 실행부 스모크도 초록인데 **둘을 잇는 값**이 안 나와 조작 도구
    //   다섯이 호출조차 불가능했다. 검사가 그 층을 안 보고 있었다.
    //   이제 계약이 `deliveredPx` 를 **필수**로 요구하므로 «빠뜨리기» 는 tsc 가 막는다.
    //   여기서는 그 위 — **실제로 값이 채워져 오는가**(늘 `null` 이면 결과는 똑같다) 를 잰다.
    //  ★캡처만 한다 = **입력 0**.
    // ── ⑤ **실제 캡처는 명시적으로 켜야 한다** (2026-09-18, 아스트라 G4) ───────
    //  ★★**내가 이 파일 머리말에 «회귀가 사용자 화면을 건드리면 안 된다» 고 써놓고,
    //   그 아래에 `capture({kind:"screen"})` 을 넣었다.** 검토자의 주 화면이 **4번** 찍혔다.
    //   이미지는 즉시 지워졌지만 **찍힌 것은 찍힌 것**이다.
    //  ★검사 하나의 값보다 «남의 화면을 동의 없이 찍지 않는다» 가 위다. 그래서 **끈다** —
    //   `TIGUCLAW_REGRESSION_CAPTURE=1` 일 때만 돈다.
    //  ★그리고 «작은 영역만 찍기» 는 대안이 아니다(그것도 남의 화면이다).
    //  ★끈 것을 **조용히 통과시키지 않는다** — 안 쟀으면 안 쟀다고 말한다.
    if (process.env.TIGUCLAW_REGRESSION_CAPTURE !== "1") {
      out.push(
        assert(
          "실제 화면 캡처는 **안 잰다**(사용자 화면을 찍지 않는다) — 재려면 `TIGUCLAW_REGRESSION_CAPTURE=1`",
          true,
          "캡처 0회 · `deliveredPx` 계약은 tsc 가 필수로 막고 있다(이 검사는 «값이 실제로 채워지나» 를 볼 뿐)",
        ),
      );
      return out;
    }
    // ★«값이 있다» 가 아니라 **그림 파일에 적힌 크기와 같다** 를 본다 (2026-09-29). C# 출력의 `w`·`h` 를 바꿔
    //  넣어도 리터럴은 그대로라 소스 대조는 통과했다(적대 검토 MUT-A) — 그림 크기가 틀리면 클릭 좌표가 어긋난다.
    //  회사 PC(2560×1440 ×2 · 125%)에서 같은 대조로 7/7 일치를 먼저 확인했다.
    const jpegSize = (b: Buffer): { w: number; h: number } | null => {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const m = b[i + 1]!;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    };
    const targets: Array<[string, unknown, ((d: { w: number; h: number }) => boolean) | null]> = [
      ["screen", { kind: "screen" }, null],
      ["region-400x300", { kind: "region", x: 0, y: 0, width: 400, height: 300 }, (d) => d.w === 400 && d.h === 300],
      ["probe", { kind: "probe" }, (d) => d.w === 1 && d.h === 1],
    ];
    for (const [label, target, expect] of targets) {
      const shotPath = path.join(os.tmpdir(), `tiguclaw-regression-${String(process.pid)}-${label}.jpg`);
      try {
        const shot = await capture(target as never, shotPath);
        let file: { w: number; h: number } | null = null;
        try {
          file = jpegSize(await fs.readFile(shotPath));
        } catch {
          /* file=null */
        }
        const d = shot.ok ? shot.deliveredPx : null;
        out.push(
          assert(
            `★★캡처(${label})가 내는 크기가 **그림 파일의 실제 크기**와 같다 — 다르면 클릭 좌표가 어긋난다`,
            d !== null && file !== null && d.w === file.w && d.h === file.h && (expect === null || expect(d)),
            shot.ok ? `deliveredPx=${JSON.stringify(d)} · 파일=${JSON.stringify(file)}` : `캡처 실패: ${shot.detail.slice(0, 120)}`,
          ),
        );
      } finally {
        await fs.rm(shotPath, { force: true }).catch(() => {});
      }
    }
    return out;
  },
};
