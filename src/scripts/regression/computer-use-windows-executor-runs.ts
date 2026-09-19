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

import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

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
    const { selfCheck, cleanPowerShellError, scriptError, capture, antivirusBlocked } =
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
    const shotPath = path.join(os.tmpdir(), `tiguclaw-regression-${String(process.pid)}.jpg`);
    try {
      const shot = await capture({ kind: "screen" } as never, shotPath);
      out.push(
        assert(
          "★★캡처가 **그림의 실측 크기**를 낸다 — 이게 없으면 «화면 id» 가 영영 안 나오고 조작 전부 불능",
          shot.ok && shot.deliveredPx !== null,
          shot.ok
            ? `deliveredPx=${JSON.stringify(shot.deliveredPx)} · ${String(shot.bytes)}B`
            : `캡처 실패: ${shot.detail.slice(0, 120)}`,
        ),
      );
    } finally {
      await fs.rm(shotPath, { force: true }).catch(() => {});
    }
    return out;
  },
};
