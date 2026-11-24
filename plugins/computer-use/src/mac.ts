/**
 * **mac 실행부** — 여기만 불순하다(자식 프로세스).
 *
 * ★**의존성 0**: `screencapture` 와 `sips` 는 macOS 내장이다. 스크린샷 라이브러리를
 *  들이지 않는 이유는 «의존성-프리 데몬» 가치 때문이다 — 네이티브 빌드가 붙으면 윈도우
 *  설치에서 터진 이력이 있다([[project_windows_update_tsc_missing_prod_env]]).
 *
 * ★★**절대 매달리지 않는다.** 실측(2026-09-16): 권한 프롬프트는 **호출 프로세스를 막는다**
 *  (System Events 조회가 AppleEvent 타임아웃까지 반환 안 했다). 그리고 MCP `callTool` 천장은
 *  **11분**(`MCP_CALL_TIMEOUT_MS`)이라, 우리가 안 끊으면 턴이 11분 매달린다 — 외부 MCP
 *  8분 hang 과 같은 모양이다. 그래서 모든 자식 실행에 **짧은 자체 시한**을 건다.
 *
 * ★플랫폼 분기는 **2026-09-17 에 생겼다** — `win.ts` 가 형제로 붙었고 `index.ts` 의
 *  `backendFor()` 가 고른다. 그전까지 안 만든 이유는 구현이 하나뿐이라 «3회 반복 후 추상화»
 *  위반이었기 때문이고, 그래서 **가를 때 옮길 것이 거의 없었다**(순수부가 이미 `observe.ts`
 *  에 있어서 공유된다 — 갈린 건 자식 프로세스를 부르는 이 파일뿐이다).
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureArgs,
  FRAME_LONG_EDGE,
  FRAME_QUALITY,
  type CheckedTarget,
  type ScreenRect,
} from "./observe.js";
import {
  CLICK_HOLD_MS,
  GLIDE_MAX_MS,
  GLIDE_MIN_MS,
  GLIDE_MS_PER_PX,
  GLIDE_TICK_MS,
  keyDryEvents,
  postTimeoutMs,
  type LowEvent,
} from "./control.js";
import { GLOW, watchIndicatorChild, type IndicatorHandle, type PillRect, type StopVia } from "./indicator.js";

/** 자식 하나의 시한 — 캡처는 보통 수백 ms 다. 넘으면 권한 대화상자를 의심한다. */
const CHILD_TIMEOUT_MS = 4_000;

const run = (
  cmd: string,
  args: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: "timeout" | "failed"; detail: string }> =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      { timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err) => {
        if (err === null) return resolve({ ok: true });
        // `killed` 는 시한 초과로 우리가 끊은 것 — 권한 대화상자가 떠 있을 수 있다.
        const killed = (err as { killed?: boolean }).killed === true;
        resolve({
          ok: false,
          reason: killed ? "timeout" : "failed",
          detail: killed ? `${CHILD_TIMEOUT_MS}ms 초과` : err.message.slice(0, 200),
        });
      },
    );
  });

/**
 * **권한 프리플라이트** — 1×1 픽셀을 찍어 본다.
 *
 * ★판정은 **종료 코드·시간 초과**로만 한다. «검은 화면이면 실패» 같은 픽셀 판정은
 *  요청서가 명시적으로 기각한 가정이라 안 쓴다 — 못 가리는 경우는 **못 가린다고 말한다**
 *  (`observationMeta` 의 «확인된 제한»).
 */
export const preflight = async (): Promise<
  | { ok: true; screens?: readonly ScreenRect[] }
  | { ok: false; reason: "timeout" | "failed"; detail: string }
> => {
  // ★**호출마다 고유해야 한다** (2026-09-16 아스트라 P2). `process.pid` 만으로는 **같은
  //  프로세스의 동시 호출이 같은 파일을 쓴다** — 매니저와 서브가 동시에 관측하면 먼저 끝난
  //  쪽의 `finally` 삭제가 다른 쪽 `stat` 을 앞질러 «산출물 없음» 으로 만든다. 캡처는
  //  성공했는데 실패로 보고되는 것이라 더 나쁘다.
  const probe = path.join(
    os.tmpdir(),
    `tiguclaw-screen-probe-${process.pid}-${randomUUID()}.png`,
  );
  try {
    const r = await run("/usr/sbin/screencapture", ["-x", "-R0,0,1,1", probe]);
    if (!r.ok) return r;
    // 파일이 실제로 생겼나 — 종료 코드 0 인데 산출물이 없는 경우를 가른다.
    try {
      const st = await fs.stat(probe);
      if (st.size === 0) return { ok: false, reason: "failed", detail: "빈 파일" };
    } catch {
      return { ok: false, reason: "failed", detail: "산출물 없음" };
    }
    // ★**화면 배치를 같이 준다** (2026-09-17). Windows 탐침이 이미 그러고 있고, 그래야
    //  «화면 밖 영역 거절»(§14-7)과 **기하 조립**(§14-3)이 맥에서도 성립한다.
    //  ★§6-C 가 *"배치를 알 수단이 없다"* 고 적었던 것은 `system_profiler` 만 본 결론이고,
    //   CoreGraphics 를 osascript 로 부르면 원점·크기·배율이 전부 나온다(§15-7 정정).
    const screens = await displays();
    return screens === null ? { ok: true } : { ok: true, screens };
  } finally {
    await fs.rm(probe, { force: true }).catch(() => {});
  }
};

/**
 * 실제 캡처 — 찍고, 줄이고 JPEG 으로 바꾸고, 바이트를 돌려준다.
 *
 * ★크기를 묶는 이유: 레티나 전체 화면 PNG 는 **3.8MB**(실측 3456×2234)다. 모델에 싣는
 *  payload 를 **결정적으로** 묶어야 2026-09-15 에 고친 «이미지가 요청에 쌓인다» 가
 *  되살아나지 않는다. `sips` 도 macOS 내장이라 의존성이 안 는다.
 *
 * ★**한 번의 `sips` 로 줄이기와 포맷 변환을 같이 한다.** 따로 하면 JPEG 을 다시
 *  인코딩해 손실이 두 번 쌓인다.
 * ★변환이 **실패해도 치명적이지 않다** — 원본 PNG 라도 있으면 관측은 성립한다.
 *  그때는 `longEdge: -1` 로 «못 줄였다» 를 위로 알린다.
 */
/** 그림의 픽셀 크기 — `sips` 한 번. 못 읽으면 `undefined`(기하를 못 내는 것뿐, 관측은 성립). */
const pixelSize = async (
  file: string,
): Promise<{ deliveredPx: { w: number; h: number } } | undefined> => {
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", file],
      { timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err, so) => resolve(err === null ? String(so) : null),
    );
  });
  if (out === null) return undefined;
  const w = /pixelWidth:\s*(\d+)/.exec(out)?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(out)?.[1];
  return w !== undefined && h !== undefined
    ? { deliveredPx: { w: Number(w), h: Number(h) } }
    : undefined;
};

export const capture = async (
  // ★★**검증을 통과한 대상만 받는다** (2026-09-17, 회사돌쇠 재검토). 종전엔 `CaptureTarget`
  //  이라 이 함수를 **직접 부르면** 화면 밖 좌표가 그대로 성공했다 — 검사가 도구 핸들러에만
  //  있었기 때문이다. 인터페이스(`ObserveBackend`)만 좁히는 것으로는 안 막힌다: 넓은 인자를
  //  받는 함수는 좁은 계약에 그냥 들어맞는다(반공변). **선언 자체**가 좁아야 한다.
  target: CheckedTarget,
  outPath: string,
): Promise<
  | {
      ok: true;
      bytes: number;
      longEdge: number;
      path: string;
      deliveredPx: { w: number; h: number } | null;
    }
  | { ok: false; reason: "timeout" | "failed"; detail: string }
> => {
  // `screencapture` 는 확장자로 포맷을 정한다 — 원본은 PNG 로 받고 아래에서 바꾼다.
  const rawPath = `${outPath}.raw.png`;
  const shot = await run("/usr/sbin/screencapture", captureArgs(target, rawPath));
  if (!shot.ok) {
    await fs.rm(rawPath, { force: true }).catch(() => {});
    return shot;
  }
  const converted = await run("/usr/bin/sips", [
    "-Z",
    String(FRAME_LONG_EDGE),
    "-s",
    "format",
    "jpeg",
    "-s",
    "formatOptions",
    String(FRAME_QUALITY),
    rawPath,
    "--out",
    outPath,
  ]);
  const finalPath = converted.ok ? outPath : rawPath;
  if (converted.ok) await fs.rm(rawPath, { force: true }).catch(() => {});
  try {
    const st = await fs.stat(finalPath);
    if (st.size === 0) return { ok: false, reason: "failed", detail: "빈 파일" };
    return {
      ok: true,
      bytes: st.size,
      longEdge: converted.ok ? FRAME_LONG_EDGE : -1,
      path: finalPath,
      // ★**유도하지 않고 잰다** — `sips -Z` 는 반올림하므로 계산으로 맞추면 1px 씩 어긋나고,
      //  그 어긋남에 배율이 곱해져 화면에서 2px 오차가 된다(§14-3 의 «기하» 가 이 값이다).
      deliveredPx: (await pixelSize(finalPath))?.deliveredPx ?? null,
    };
  } catch {
    return { ok: false, reason: "failed", detail: "산출물 없음" };
  }
};

/**
 * **화면 배치** — 원점·크기(포인트)와 배율. 못 읽으면 `null`(«모른다» 로 다룬다).
 *
 * ★`CGDisplayBounds` 는 **포인트**, `CGDisplayMode` 의 픽셀 폭은 **픽셀**이다. 둘의 비가
 *  배율이고, 실측(이 기계) `1728×1117pt` / `3456×2234px` → 2 로 설계의 실측치와 맞는다.
 */
export const displays = async (): Promise<ScreenRect[] | null> => {
  const r = await jxa(
    [
      "ObjC.import('CoreGraphics');",
      "var ids = Ref(), cnt = Ref();",
      "$.CGGetActiveDisplayList(16, ids, cnt);",
      "var n = cnt[0], out = [];",
      // ★주 화면을 **먼저** 놓는다 — 도구가 «1 = 주 화면» 이라고 약속한다(`screencapture -D`).
      "var main = $.CGMainDisplayID();",
      "var seen = [main];",
      "for (var i = 0; i < n; i++) { var d = ids[i]; if (seen.indexOf(d) < 0) seen.push(d); }",
      "for (var j = 0; j < seen.length; j++) {",
      "  var b = $.CGDisplayBounds(seen[j]);",
      "  var m = $.CGDisplayCopyDisplayMode(seen[j]);",
      "  var pw = Number($.CGDisplayModeGetPixelWidth(m));",
      "  out.push({x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height,",
      "            scale: b.size.width > 0 ? pw / b.size.width : 1});",
      "}",
      "JSON.stringify(out)",
    ].join("\n"),
  );
  if (!r.ok) return null;
  try {
    const v = JSON.parse(r.out) as ScreenRect[];
    return Array.isArray(v) && v.length > 0 ? v : null;
  } catch {
    return null;
  }
};

// ─── 2단계: 조작 (2026-09-17, 설계 §15) ──────────────────────────────────────

/**
 * ★**여기부터는 `osascript -l JavaScript`(JXA)다** — `screencapture` 처럼 macOS 내장이고,
 *  ObjC 브리지로 **CoreGraphics 를 직접** 부른다. 즉 조작도 **의존성 0** 이다.
 *
 * ★★내가 설계에 *"mac 은 의존성 0 으로 입력에 닿을 수 없다"* 고 적었던 것은 **틀렸다**
 *  (§15-3 정정). `System Events` 가 매달린 것은 **다른 앱에 AppleEvent 를 보내는** 경로라
 *  구조가 다른데, 둘을 한 덩이로 묶어 읽었다.
 *
 * ★★★**실패가 조용하다**(2026-09-17 실측). 손쉬운 사용 권한이 없으면 `CGEventPost` 는
 *  **오류 없이 무시된다** — 커서를 40px 옮기라고 쏘고 위치를 다시 읽었더니 그대로였고,
 *  종료 코드는 0이었다. 그래서 «오류가 안 났다» 를 «했다» 로 읽으면 안 된다. 관측에서
 *  닫은 «화면 밖이 성공으로 나간다» 와 **정확히 같은 부류**다.
 *  → 그래서 조작 전에 `controlPreflight()` 로 **권한을 먼저 읽는다**(프롬프트 없음).
 */
const jxa = (
  script: string,
  env: Record<string, string> = {},
  timeoutMs: number = CHILD_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<
  | { ok: true; out: string }
  // ★`out` 은 **실패해도 싣는다** (2026-09-19, 계약 3) — 죽은 자식이 어디까지 갔는지는
  //  여기에만 남아 있고, 종전엔 그것을 버려서 시한 초과에 `"4000ms 초과"` 만 남았다.
  //  ★부분일 수 있다(줄 중간에서 잘린다). 읽는 쪽은 **완전한 줄만** 쓴다.
  | { ok: false; reason: "timeout" | "failed"; detail: string; out: string }
> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, reason: "failed", detail: "조작 취소 — 입력 전", out: "" });
    // abort 옵션은 callback을 close보다 먼저 호출할 수 있다. kill만 요청하고 기존 callback(종료)을 기다린다.
    const cancel = () => { child.kill("SIGKILL"); };
    const child = execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: timeoutMs, killSignal: "SIGKILL", env: { ...process.env, ...env } },
      (err, so, se) => {
        signal?.removeEventListener("abort", cancel);
        if (signal?.aborted) return resolve({ ok: false, reason: "failed", detail: "조작 취소 — 잔여 입력 중단(이미 보낸 입력은 되돌리지 않음)", out: String(so) });
        if (err === null) return resolve({ ok: true, out: String(so).trim() });
        const killed = (err as { killed?: boolean }).killed === true;
        const why = String(se).trim() !== "" ? String(se).trim() : err.message;
        resolve({
          ok: false,
          reason: killed ? "timeout" : "failed",
          detail: killed ? `${timeoutMs}ms 초과` : why.slice(0, 300),
          out: String(so),
        });
      },
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });

/**
 * **조작 권한 프리플라이트** — `AXIsProcessTrusted()`. 읽기 전용이고 **프롬프트를 안 띄운다.**
 *
 * ★관측의 프리플라이트와 같은 자리다: 시도했다가 조용히 실패하느니 **먼저 읽고 말한다.**
 */
export const controlPreflight = async (): Promise<
  { ok: true } | { ok: false; reason: "no-permission" | "timeout" | "failed"; detail: string }
> => {
  const r = await jxa(
    "ObjC.import('ApplicationServices'); JSON.stringify({t: $.AXIsProcessTrusted()})",
  );
  if (!r.ok) return r;
  try {
    const v = JSON.parse(r.out) as { t?: boolean };
    return v.t === true ? { ok: true } : { ok: false, reason: "no-permission", detail: "AXIsProcessTrusted=false" };
  } catch {
    return { ok: false, reason: "failed", detail: `판정 불가: ${r.out.slice(0, 80)}` };
  }
};

/**
 * **사람이 마지막으로 하드웨어를 만진 뒤 경과 초** (§3-4).
 *
 * ★소스를 **HID 시스템 상태**(1)로 준다 — 실측(§15-7)에서 세션 결합 상태(0)와 3.7초
 *  갈렸다. 즉 **HID 는 합성 입력(우리 것)을 안 센다.** 그래서 비서가 자기 입력에 자기가
 *  막히지 않는다. ★못 읽으면 `null` 을 주고, 순수부가 그걸 «쓰는 중» 으로 읽는다.
 */
export const idleSeconds = async (): Promise<number | null> => {
  const r = await jxa(
    "ObjC.import('CoreGraphics'); JSON.stringify({s: $.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF)})",
  );
  if (!r.ok) return null;
  try {
    const v = JSON.parse(r.out) as { s?: number };
    return typeof v.s === "number" && Number.isFinite(v.s) ? v.s : null;
  } catch {
    return null;
  }
};

/**
 * **이벤트를 순서대로 쏜다.**
 *
 * ★스크립트는 **고정 리터럴**이고 이벤트 목록은 `$env` 로 간다 — `win.ts` 와 같은 이유다
 *  (문자열을 끼워 넣으면 입력 텍스트가 코드가 될 수 있고, 여기 들어오는 것은 모델이 쓴
 *  임의의 글자다).
 * ★**수식키 플래그를 실행부가 누적한다** — `cmd` 를 누른 상태에서 `c` 를 눌러야 «복사» 로
 *  해석된다. 순수부는 이름 순서만 정하고(§15 의 «무엇을 쏠지»), 그것을 OS 의 플래그로
 *  옮기는 일은 여기다.
 * ★**한 글자는 유니코드로 쏜다** — 키코드 표에 없는 글자(한글 등)도 그대로 들어간다.
 *  표는 **단축키를 위해서만** 있다(유니코드 주입은 단축키로 해석되지 않는다).
 */
export const POST_SCRIPT = [
  "ObjC.import('CoreGraphics');",
  "ObjC.import('AppKit');",  // NSPasteboard
  // ★★**세션 탭(1)으로 쏜다 — HID 탭(0)이 아니다** (2026-09-17 실기에서 잡혔다).
  //  HID 탭으로 쏘면 **우리 입력이 HID 유휴 시계를 리셋한다** — 그래서 클릭 직후 이어지는
  //  입력이 §3-4 의 사용자 가드에 `user-active` 로 막혔다. **비서가 자기 입력에 자기가
  //  막히는** 그 모양이고, 설계가 Windows 위험으로 적어둔 것이 맥에서 먼저 났다.
  //  실측: 탭0 → 유휴 10.13초가 **0.29초로 리셋** · 탭1 → 1.50초가 1.80초로 **계속 증가**,
  //  그리고 **커서는 똑같이 움직인다.**
  //  ★그래서 «HID 소스는 합성 입력을 안 센다»(§15-7)는 절반만 맞았다 — **어디로 쏘느냐에
  //   달려 있다.** 소스를 고른 것만으로는 부족하고, 쏘는 자리도 같이 골라야 한다.
  "var SESSION_TAP = 1;",
  "var evs = JSON.parse($.NSProcessInfo.processInfo.environment.objectForKey('TIGUCLAW_EVENTS').js);",
  // ★★**«쐈다» 는 실행부 **안에서만** 셀 수 있다** (2026-09-19). 종전엔 루프 **밖에서**
  //  `evs.length` 를 돌려주고 TS 가 그 값을 `fired` 로 이름만 바꿔 읽었다 — 그건 «받은
  //  항목 수» 이지 쏜 횟수가 아니다. 빈 연습에서 한 번도 안 쏴도 같은 수가 나온다.
  //  ★Windows 는 `Send()` 한 자리에서 이미 그렇게 세고 있었고(`win.ts`), **맥만 남아
  //   있었다** — 같은 이름이 두 플랫폼에서 다른 뜻이면 이름이 읽는 쪽을 속인다.
  //  ★여기가 **유일한 발사구**다: `CGEventPost` 를 직접 부르는 자리를 남기지 않는다
  //   (남기면 그 하나가 장부 밖에서 쏜다).
  "var DRYV = $.NSProcessInfo.processInfo.environment.objectForKey('TIGUCLAW_DRY');",
  "var DRY = (DRYV && !DRYV.isNil()) ? (String(DRYV.js) === '1') : false;",
  "var FIRED = 0;",
  // ★**«시도» 는 빈 연습에서도 센다** (2026-11-24, ⑤ Esc). `FIRED` 는 빈 연습에서 늘 0 이라 «멈춘 뒤 입력을
  //  시도하지 않았다» 를 못 보인다. `TRIED`·`UNI` 는 빈 연습 조기 반환 **앞**에서 센다(실 입력·클립보드는 그대로 0).
  "var TRIED = 0; var UNI = 0;",
  "function post(ev){ TRIED = TRIED + 1; if (DRY) { return; } FIRED = FIRED + 1; $.CGEventPost(SESSION_TAP, ev); }",
  // ★**멈춤 요청 파일** (2026-11-24, ⑤ Esc) — 부모가 사용자 Esc 를 받으면 이 파일을 만든다. 실행부는 **키를 읽지
  //  않는다**(감지는 표시 도우미 하나, 결정은 부모 한 곳). 단계 경계(`mark`)와 `wait` 도중에만 본다 — 단계 **안**
  //  (붙여넣기 V down/up·드래그 보간)에서 멈추면 키·버튼·클립보드가 남는다. 빈 연습도 같은 코드가 진짜 파일을 본다.
  "var STOPV = $.NSProcessInfo.processInfo.environment.objectForKey('TIGUCLAW_STOP_FILE');",
  "var STOPF = (STOPV && !STOPV.isNil()) ? String(STOPV.js) : '';",
  "var FM = $.NSFileManager.defaultManager;",
  "function stopAsked(){ return STOPF !== '' && FM.fileExistsAtPath($(STOPF)); }",
  // ★**진행을 흘린다**(계약 3). 최종식만으로는 중간 출력이 안 되므로 **파일 핸들에 직접**
  //  쓴다. 실측(2026-09-19): 세 줄을 쓰고 SIGKILL 하면 **3/3 이 도착한다** — 죽은 자식이
  //  어디까지 갔는지를 말할 수 있는 유일한 길이다.
  "ObjC.import('Foundation');",
  "var OUT = $.NSFileHandle.fileHandleWithStandardOutput;",
  "function emit(o){ OUT.writeData($(JSON.stringify(o) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)); }",
  // ★★**기다림은 «최소 s 초» 를 단조시계로 지킨다 — `delay(s)` 한 번에 맡기지 않는다** (2026-10-23).
  //  launchd 데몬의 자식(개발 인스턴스·서비스 설치본)에선 `delay(s)` 가 **약 8.6배** 늘어났다:
  //  `delay(0.012)` 실측 103ms · `delay(0.001)` 6.8ms · `delay(0.05)` 197ms · `delay(1)` 1.52초.
  //  그래서 키 112개 빈 연습이 11초가 돼 자기 시한(`postTimeoutMs`)에 죽었고, 사용자가 준
  //  `wait` 도 1.5배 길어졌다(쓴 시간이 거짓이 된다). Foundation sleep·QoS·NSActivity 로는 안 풀렸다
  //  (원인 정책은 미확정 — 타이머 지연 허용 가설).
  //  ★그래서 기한을 정하고 그때까지 **짧게 자며** 시계를 본다 — `delay(0)` 회전이 아니라 잔다.
  //   실측(같은 데몬 자식): 12ms 간격 112회 11.6초 → 1.75초(깨움 261회) · `wait` 1초 → 1.001초.
  //  ★간격은 **최소값**이다(앱이 이벤트를 소화할 틈) — 줄이거나 없애는 게 아니라 늘어나지 않게 한다.
  "var PI = $.NSProcessInfo.processInfo;",
  "function pause(s){ var until = PI.systemUptime + s; while (PI.systemUptime < until) { delay(0.001); } }",
  // `wait` 원소 전용 — 멈춤 요청이 오면 **그 자리에서** 끝내고 참을 돌려준다(입력이 없는 구간이라 끊어도 남는 것이 없다).
  //  ★날 `delay(` 는 `pause` 몸통 한 곳뿐이다(회귀가 센다) — 여기는 `pause` 를 짧게 되풀이한다.
  "function waitOrStop(s){ var end = PI.systemUptime + s; while (PI.systemUptime < end) { if (stopAsked()) { return true; } pause(0.001); } return false; }",
  "var T0 = PI.systemUptime;",
  // ★**전면 창 — 자식 «안» 에서 본다**(계약 1). 실측 0.10ms/회. 따로 띄우면 64ms 라
  //  «매 step 마다» 가 아예 불가능해진다.
  //  ★★맥은 **앱 단위**다(`localizedName:pid`). 같은 앱의 **다른 창**으로 옮겨간 것은 못
  //   본다 — Windows 는 HWND 라 창 단위다. **확인된 제한**이고, 숨기지 않고 적는다.
  "var WS = $.NSWorkspace.sharedWorkspace;",
  "function frontNow(){ try { var a = WS.frontmostApplication; if (!a || a.isNil()) { return null; } return ObjC.unwrap(a.localizedName) + ':' + a.processIdentifier; } catch (e) { return null; } }",
  "var CUR = -1; var STOP = null;",
  // 미끄러짐 박자 — `control.ts` 의 상수 하나(두 실행부 공유). 사용자 값이 아니라 코드 상수라 스크립트에 박는다.
  `var GLIDE_MAX = ${String(GLIDE_MAX_MS)}; var GLIDE_MIN = ${String(GLIDE_MIN_MS)}; var GLIDE_PER_PX = ${String(GLIDE_MS_PER_PX)}; var GLIDE_TICK = ${String(GLIDE_TICK_MS / 1000)}; var CLICK_HOLD = ${String(CLICK_HOLD_MS / 1000)};`,
  // 맥 가상 키코드 — **번역표**이지 정책 목록이 아니다(OS 가 정한 값이라 유도할 수 없다).
  "var K = {a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,y:16,t:17,",
  "'1':18,'2':19,'3':20,'4':21,'6':22,'5':23,'=':24,'9':25,'7':26,'-':27,'8':28,'0':29,']':30,",
  "o:31,u:32,'[':33,i:34,p:35,enter:36,'return':36,l:37,j:38,k:40,';':41,',':43,'/':44,n:45,m:46,",
  // ★★**`delete` 는 backspace 가 아니다** (2026-09-18, 아스트라 N-P1). 종전엔 둘 다 51 이라
  //  «같은 이름이 플랫폼마다 다른 뜻» 이었다 — Windows 는 `0x2E`(뒤 글자 삭제)인데 맥은
  //  앞 글자를 지웠다. 맥의 앞으로 삭제는 **117**이다.
  // ★그리고 도구 설명이 광고하던 **탐색키 넷(home·end·pageup·pagedown)이 맥에 없었다** —
  //  «지원한다» 고 적어놓고 던지고 있었다. 표준 키코드가 있는데 안 적은 것뿐이다.
  //  ★공통 이름은 **양쪽에 다 있거나, 어느 쪽에도 없어야** 한다.
  "'.':47,tab:48,space:49,backspace:51,'delete':117,esc:53,escape:53,",
  "home:115,end:119,pageup:116,pagedown:121,",
  // 기능키(Events.h kVK_F1~F20) · CapsLock · 숫자패드(kVK_ANSI_Keypad*) — 2026-10-18. 맥에 없는 키(Insert·PrintScreen…)는 표에 없다(`PLATFORM_ONLY_KEY_NAMES`).
  "f1:122,f2:120,f3:99,f4:118,f5:96,f6:97,f7:98,f8:100,f9:101,f10:109,f11:103,f12:111,f13:105,f14:107,f15:113,f16:106,f17:64,f18:79,f19:80,f20:90,",
  "capslock:57,num0:82,num1:83,num2:84,num3:85,num4:86,num5:87,num6:88,num7:89,num8:91,num9:92,",
  "numdecimal:65,nummultiply:67,numadd:69,numdivide:75,numenter:76,numsubtract:78,",
  "left:123,right:124,down:125,up:126};",
  "var MODK = {cmd:55, shift:56, alt:58, ctrl:59};",
  "var MODF = {cmd:0x100000, shift:0x20000, alt:0x80000, ctrl:0x40000};",
  "var down = {};",  // 지금 눌려 있는 수식키
  "function flags(){ var f=0; for (var m in down) if (down[m]) f |= MODF[m]; return f; }",
  "function key(name, isDown){",
  "  if (MODK[name] !== undefined) {",
  "    down[name] = isDown;",
  "    var me = $.CGEventCreateKeyboardEvent($(), MODK[name], isDown);",
  "    $.CGEventSetFlags(me, flags());",
  "    post(me); return;",
  "  }",
  // 맥엔 Windows 키가 없다 — **주 수식키는 `cmd` 이고 그건 이미 따로 있다.** 조용히
  // cmd 로 바꾸면 «win 이 먹혔다» 는 거짓말이 되므로 이름을 대고 던진다.
  "  if (String(name) === 'win') throw new Error('맥에는 Windows 키가 없습니다 — 주 수식키는 cmd 입니다');",
  "  var code = K[String(name).toLowerCase()];",
  "  if (code === undefined) {",
  // ★표에 없으면 **유니코드로 쏜다.** 한 글자면 그대로 들어가고, 여러 글자면 이름을 모르는
  //  것이므로 던진다 — 조용히 아무것도 안 하는 것보다 낫다.
  "    if (String(name).length !== 1) throw new Error('알 수 없는 키 이름: ' + name);",
  // ★★**수식키를 눌러둔 채로는 유니코드로 새지 않는다** (2026-09-17, Windows 실기가 드러낸
  //  같은 부류). 유니코드 주입은 **수식키를 안 탄다** — `cmd+ㅁ` 이 «단축키» 가 아니라
  //  «글자 ㅁ 삽입» 이 되고, 그래도 성공을 반환한다. 조용히 딴 일을 하느니 던진다.
  "    var heldNames = []; for (var hm in down) if (down[hm]) heldNames.push(hm);",
  "    if (heldNames.length > 0) throw new Error('이 배치에서 «' + name + '» 는 키로 누를 수 없습니다 — 수식키(' + heldNames.join('+') + ')와 함께 쓸 수 없습니다. 글자를 넣는 것이 목적이면 steps 의 type 원소를 쓰세요.');",
  "    if (!isDown) return;",
  "    uni(String(name)); return;",
  "  }",
  "  var ev = $.CGEventCreateKeyboardEvent($(), code, isDown);",
  "  $.CGEventSetFlags(ev, flags());",
  "  post(ev);",
  "}",
  // ★★**맥 타이핑은 «클립보드 + cmd+V» 다** (2026-09-17 실기로 확정).
  //
  //  ★처음엔 `CGEventKeyboardSetUnicodeString` 으로 **코드포인트를 직접 주입**하려 했다.
  //   설계 §15-7 은 그것이 양 OS 에 다 있어서 «공통» 이 성립한다고 적었는데, **맥에서
  //   틀렸다**: JXA 가 `const UniChar *` 버퍼를 못 넘긴다. 네 가지를 다 재봤다 —
  //     `NSData.bytes`        → 브리지가 거절 (`Ref has incompatible type`)
  //     코드 유닛 배열·NSString·생 문자열 → **던지지는 않는데** 실제로는 깨진 글자 한 개가
  //                                        들어간다(18자를 보내고 사각형 1개를 받았다).
  //   ★«던지지 않는다» 와 «맞게 들어간다» 는 다르다 — 그림으로 확인하기 전까진 전자를
  //    후자로 읽고 있었다.
  //
  //  ★그래서 **NSPasteboard** 로 간다. 객체 API 라 버퍼 문제가 없고, 한글·공백·영문·숫자가
  //   그대로 들어가는 것을 실기로 확인했다. Windows 는 `KEYEVENTF_UNICODE` 가 P/Invoke 로
  //   진짜 마셜링을 하므로 그쪽은 직접 주입 그대로다 — **여기서 두 플랫폼이 갈린다.**
  //
  //  ★★**클립보드는 남의 물건이다.** 쓰기 전에 저장하고 끝나면 되돌린다. 그래도 완벽하진
  //   않다: 되돌리기 전에 사용자가 복사하면 그걸 덮는다(전역 상태라 피할 수 없다). 그래서
  //   **문자열만** 저장·복원하고, 그 창을 짧게 유지한다.
  "function uni(text){",
  "  UNI = UNI + 1;",
  // ★빈 연습에선 **여기서 곧장 돌아온다** — 클립보드는 남의 물건이고, 「입력 0」은
  //  «안 쐈다» 만이 아니라 «아무것도 안 건드렸다» 여야 한다. 발사구(`post`)가 이미
  //  막고 있지만 붙여넣기 경로는 **쏘기 전에** 남의 상태를 바꾼다.
  "  if (DRY) { return; }",
  "  var pb = $.NSPasteboard.generalPasteboard;",
  "  var prev = pb.stringForType($.NSPasteboardTypeString);",
  "  var prevStr = prev.isNil() ? null : ObjC.unwrap(prev);",
  "  pb.clearContents;",
  "  pb.setStringForType($(text), $.NSPasteboardTypeString);",
  // ★되돌리기는 finally — 쏘다 던져도 사용자 클립보드에 비서가 친 글(비밀번호일 수 있다)을 남기지 않는다.
  "  try {",
  "    pause(0.05);",
  "    var d = $.CGEventCreateKeyboardEvent($(), 9, true);",   // v
  "    $.CGEventSetFlags(d, 0x100000 | flags());",
  "    post(d); pause(0.03);",
  "    var u = $.CGEventCreateKeyboardEvent($(), 9, false);",
  "    $.CGEventSetFlags(u, 0x100000 | flags());",
  "    post(u); pause(0.25);",
  "  } finally {",
  "    pb.clearContents;",
  "    if (prevStr !== null) pb.setStringForType($(prevStr), $.NSPasteboardTypeString);",
  "  }",
  "}",
  "var BTN = {left:{d:1,u:2,b:0,drag:6}, right:{d:3,u:4,b:1,drag:7}, middle:{d:25,u:26,b:2,drag:27}};",
  "for (var i = 0; i < evs.length; i++) {",
  "  var e = evs[i];",
  // ★입력이 아닌 원소는 **간격(`pause(0.012)`)을 안 태운다** — 64개 열이면 0.77초가 그냥 샌다.
  // 단계 경계 — 멈춤 요청이면 이 단계는 **시작 전**이다(«미실행» 이 정확하다).
  "  if (e.t === 'mark') { if (stopAsked()) { STOP = {stopped: e.i, why: 'user-esc', saw: ''}; break; } CUR = e.i; emit({step: e.i}); continue; }",
  // `wait` 도중 멈춤 — 그 `wait` 단계는 다 못 기다렸으므로 그 단계부터 «미실행» 이다(끊긴 대기를 «완료» 로 보고하지 않는다).
  "  if (e.t === 'wait') { if (waitOrStop(e.ms / 1000)) { STOP = {stopped: CUR, why: 'user-esc', saw: ''}; break; } continue; }",
  // ★**미끄러짐** (2026-11-24, ⑤ r4 → 0.1초 후보) — 실제 커서를 지금 자리에서 목표까지 옮긴다(눌린 것 없음). 길이는 **경과 시간**으로
  //  정한다(`control.ts` GLIDE_*) · 곡선은 ease-out 3차(목표 직전 감속). 도중·끝 멈춤 요청 = 이 단계 «미실행»(포인터만 움직였다).
  "  if (e.t === 'glide') {",
  // 빈 연습만: `from` 이 있으면 시작점을 그것으로 고정한다(커서를 안 읽는다) — 회귀가 사람의 커서와 무관하게 정확한 거리를 주고,
  //  목표는 실제 조작과 같은 절대좌표 분기를 지난다.
  "    var c0 = (DRY && e.from) ? e.from : $.CGEventGetLocation($.CGEventCreate($()));",
  "    var gdx = e.x - c0.x; var gdy = e.y - c0.y; var gd = Math.sqrt(gdx * gdx + gdy * gdy);",
  "    var gT = gd > 0 ? Math.min(GLIDE_MAX, GLIDE_MIN + gd * GLIDE_PER_PX) : 0; var gu = gT > 0 ? 0 : 1; var gstop = false; var g0 = PI.systemUptime;",
  "    while (gu < 1) {",
  "      if (stopAsked()) { gstop = true; break; }",
  "      pause(GLIDE_TICK);",
  "      gu = Math.min(1, (PI.systemUptime - g0) * 1000 / gT); var gs = 1 - (1 - gu) * (1 - gu) * (1 - gu);",
  "      post($.CGEventCreateMouseEvent($(), 5, {x: c0.x + gdx * gs, y: c0.y + gdy * gs}, 0));",
  "    }",
  "    if (!gstop && stopAsked()) { gstop = true; }",
  // 빈 연습만: 실행부가 **실제로 쓴** 거리·정한 목표 시간(T)·걸린 시간(같은 단조시계) — 회귀가 다른 실행 간 시간 차에 기대지 않게.
  "    if (DRY) { emit({glide: {d: gd, T: gT, ms: Math.round((PI.systemUptime - g0) * 1000)}}); }",
  "    if (gstop) { STOP = {stopped: CUR, why: 'user-esc', saw: ''}; break; }",
  "    continue;",
  "  }",
  "  if (e.t === 'guard') {",
  "    var f = frontNow();",
  // ★**모르면 멈춘다** — «같다» 로 읽으면 가드가 조용히 사라진다(§15-27 계약 1).
  "    if (f === null) { STOP = {stopped: CUR, why: 'front-unknown', saw: '(못 읽음)'}; break; }",
  "    if (f !== e.front) { STOP = {stopped: CUR, why: 'front-changed', saw: f}; break; }",
  "    continue;",
  "  }",
  "  if (e.t === 'mousemove') { post($.CGEventCreateMouseEvent($(), 5, {x:e.x, y:e.y}, 0)); }",
  "  else if (e.t === 'mousedown' || e.t === 'mouseup') {",
  "    var b = BTN[e.button];",
  // ★좌표가 없으면 **지금 커서 자리**에서 뗀다 — 정리(releasePlan)가 그 경우다. 여기서
  //  (0,0) 을 쓰면 드래그 중 취소가 «구석으로 끌어다 놓기» 가 된다.
  "    var px = (e.x === undefined || e.x === null) ? $.CGEventGetLocation($.CGEventCreate($())).x : e.x;",
  "    var py = (e.y === undefined || e.y === null) ? $.CGEventGetLocation($.CGEventCreate($())).y : e.y;",
  "    var me = $.CGEventCreateMouseEvent($(), e.t === 'mousedown' ? b.d : b.u, {x:px, y:py}, b.b);",
  // 더블클릭은 **클릭 카운트**로 전해야 한다 — 같은 자리 두 번이 자동으로 더블이 아니다.
  "    $.CGEventSetIntegerValueField(me, 1 /* kCGMouseEventClickState */, e.count || 1);",
  "    $.CGEventSetFlags(me, flags());",
  "    post(me);",
  "  }",
  // ★**누른 채 이동은 별도 타입**이다(LeftMouseDragged=6 · Right=7 · Other=27). 누른 채
  //  `mouseMoved` 를 쏘면 앱이 드래그로 안 읽어서 **창이 안 끌린다.**
  "  else if (e.t === 'mousedrag') {",
  "    var db = BTN[e.button];",
  "    var de = $.CGEventCreateMouseEvent($(), db.drag, {x:e.x, y:e.y}, db.b);",
  "    $.CGEventSetFlags(de, flags());",
  "    post(de);",
  "  }",
  "  else if (e.t === 'scroll') {",
  "    var se = $.CGEventCreateScrollWheelEvent($(), 0 /* pixel */, 2, e.dy, e.dx);",
  "    post(se);",
  "  }",
  "  else if (e.t === 'unicode') { uni(e.text); }",
  "  else if (e.t === 'keydown') { key(e.key, true); }",
  "  else if (e.t === 'keyup') { key(e.key, false); }",
  // ★★**모르는 원소는 던진다 — 조용히 건너뛰지 않는다** (2026-09-19). 이 `else` 가 없으면
  //  한쪽 플랫폼에만 넣은 원소가 **다른 쪽에서 소리 없이 사라진다** — 실제로 `mark`·`wait`·
  //  `guard` 를 맥에만 넣었고, Windows 에서는 가드가 없는 채로 돌 뻔했다. 조용한 스킵이
  //  «한쪽만 고친 수정» 을 **안 보이게** 만드는 기제다.
  "  else { throw new Error('알 수 없는 입력 원소: ' + String(e.t)); }",
  // 앱이 이벤트를 소화할 **최소** 틈 — 너무 빠르면 흘린다. ★누른 뒤엔 `CLICK_HOLD`(표시 도우미가 «눌림» 을 보고 고리를 번쩍인다 — ⑤ r4).
  "  pause(e.t === 'mousedown' ? CLICK_HOLD : 0.012);",
  "}",
  "if (STOP) { emit(STOP); }",
  "JSON.stringify({items: evs.length, fired: FIRED, tried: TRIED, uni: UNI, stopped: STOP, ms: Math.round((PI.systemUptime - T0) * 1000)})",
].join("\n");

export const post = async (
  events: readonly LowEvent[],
  signal?: AbortSignal,
  /**
   * `stopFile` = 사용자 Esc 의 멈춤 요청 파일(있으면 실행부가 단계 경계·`wait` 도중에 본다) ·
   * `dry` = 빈 연습(입력·클립보드 0) — `dryPost`·`selfCheck` 가 **이 함수를 지나** env 전달까지 같이 검사되게 한다.
   */
  opts?: { stopFile?: string; dry?: boolean },
): Promise<
  | {
      ok: true;
      /**
       * **실제로 `CGEventPost` 를 부른 횟수** — «앱이 받았다» 가 아니다(판정은 재관측뿐).
       *
       * ★**항목 수와 다르다.** 한 이벤트가 여러 번 쏘는 자리가 있다(유니코드 한 덩이는
       *  붙여넣기라 cmd+V 의 down·up 둘이다) — `win.ts` 가 `KEYEVENTF_UNICODE` 를 글자마다
       *  부르는 것과 같은 성질이다. 그러니 이 수로 «몇 글자 들어갔나» 를 세면 안 된다.
       */
      fired: number;
      /** 자식이 흘린 진행 줄 — `stepsOutcome` 이 읽는다(계약 3). */
      stdout: string;
    }
  | { ok: false; reason: "timeout" | "failed"; detail: string; stdout: string }
> => {
  if (events.length === 0) return { ok: true, fired: 0, stdout: "" };
  // ★`TIGUCLAW_DRY` 를 **명시적으로 끈다** — `win.ts` 와 같은 이유다. 자식은 `process.env`
  //  를 물려받으므로 어디선가 그 이름이 켜져 있으면 **진짜 조작이 조용히 아무것도 안 한다.**
  //  ★`TIGUCLAW_STOP_FILE` 도 **명시적으로** 넣는다(없으면 빈 문자열) — 같은 이유다.
  const r = await jxa(POST_SCRIPT, {
    TIGUCLAW_EVENTS: JSON.stringify(events),
    TIGUCLAW_DRY: opts?.dry === true ? "1" : "0",
    TIGUCLAW_STOP_FILE: opts?.stopFile ?? "",
  }, postTimeoutMs(events, CHILD_TIMEOUT_MS), signal);
  if (!r.ok) return { ...r, stdout: r.out };
  try {
    // ★**마지막 줄이 최종 산출**이다 — 앞의 줄들은 진행(`mark`)이다.
    const v = JSON.parse(r.out.trim().split("\n").pop() ?? "") as { fired?: number };
    return {
      ok: true,
      fired: typeof v.fired === "number" ? v.fired : events.length,
      stdout: r.out,
    };
  } catch {
    return { ok: false, reason: "failed", detail: `산출 판정 불가: ${r.out.slice(0, 80)}`, stdout: r.out };
  }
};

/**
 * 빈 연습이 통과시킬 **대표 이벤트** — 실행부가 밟는 분기를 한 번씩 지난다.
 * ★`win.ts` 의 `DRY_EVENTS` 와 **같은 목록**이다. 두 플랫폼이 같은 계약을 진다면 그것을
 *  재는 표본도 같아야 한다 — 표본이 갈리면 «양쪽 다 초록» 이 서로 다른 뜻이 된다.
 */
export const DRY_EVENTS: readonly LowEvent[] = [
  // ★미끄러짐(⑤ r4)도 밟는다 — 커서 조회·보간·발사 시도가 빈 연습에서 실제로 돈다(독립 검토 R1 검사 부족 7).
  { t: "glide", x: 0, y: 0 },
  { t: "mousemove", x: 0, y: 0 },
  { t: "mousedown", x: 0, y: 0, button: "left", count: 1 },
  { t: "mousedrag", x: 1, y: 1, button: "left" },
  { t: "mouseup", button: "left", count: 1 },
  { t: "scroll", x: 0, y: 0, dx: 0, dy: 120 },
  { t: "scroll", x: 0, y: 0, dx: -120, dy: -120 },
  { t: "keydown", key: "cmd" },
  { t: "keydown", key: "a" },
  { t: "keyup", key: "a" },
  { t: "keyup", key: "cmd" },
  { t: "keydown", key: "enter" },
  { t: "keyup", key: "enter" },
  { t: "unicode", text: "가A\n" },
  // ★**배관 원소도 밟는다** (2026-09-19). 이것이 없으면 빈 연습이 `mark`·`wait`·`guard` 를
  //  **한 번도 안 지나간다** — 실제로 그 셋을 맥에만 넣고 Windows 에는 안 넣었는데, 스모크가
  //  전부 초록이었다(모르는 원소를 조용히 건너뛰었기 때문이다).
  { t: "mark", i: 0 },
  { t: "wait", ms: 1 },
  // ★**일부러 어긋나는 값**을 준다 — 가드가 «멈춘다» 를 빈 연습에서 확인하는 유일한 길이다.
  //  실제 전면 창이 무엇이든 이 값과 같을 수 없다.
  // 모든 이름 있는 키(이 플랫폼) — 표가 이름을 다 푸는지(2026-10-18). 가드보다 **앞**이어야 지나간다.
  ...keyDryEvents("darwin"),
  { t: "guard", front: "(없는 창)::tiguclaw-dry" },
];

/**
 * **실행부 자가 점검** — 입력을 **하나도 내지 않고** 스크립트가 도는지만 본다.
 *
 * ★`win.ts` 의 `selfCheck` 와 같은 자리다. 맥에만 없었던 이유는 «맥은 실기로 자주 돌려봤다»
 *  는 것이었는데, 그건 **검사가 아니라 습관**이다 — 2026-09-19 에 맥의 `fired` 가 루프
 *  밖에서 항목 수를 세고 있던 것을 아무 검사도 못 잡은 게 그 증거다.
 * ★**제품이 만드는 바로 그 스크립트**(`POST_SCRIPT`)를 돌린다 — 검사용 사본은 이 부류를
 *  못 잡는다(§15-15 의 교훈).
 */
export const selfCheck = async (): Promise<
  | { ok: true; dryFired: number; dryStopped: boolean; dryMs: number }
  | { ok: false; where: "dry"; detail: string }
> => {
  const dry = await dryPost(DRY_EVENTS);
  if (!dry.ok) return { ok: false, where: "dry", detail: dry.detail };
  // ★빈 연습이면 **한 번도 안 쏴야** 한다 — 그 숫자가 이름의 뜻을 지킨다.
  // ★**가드가 실제로 멈췄나** — 일부러 어긋나는 `front` 를 줬으므로 반드시 멈춰야 한다.
  return { ok: true, dryFired: dry.fired, dryStopped: dry.stopped, dryMs: dry.ms };
};

/**
 * **빈 연습 한 번** — 제품 스크립트(`POST_SCRIPT`)에 이벤트를 흘리고 최종 줄을 읽는다(입력·클립보드 0).
 * ★`ms` = 루프가 실제로 쓴 시간(자식 안 단조시계 · 기동 제외). 최소 간격·`wait` 길이·시한 예산을 회귀가 이 값으로 잰다.
 *  못 읽으면 -1(판정 불가로 읽게 한다).
 */
export const dryPost = async (
  events: readonly LowEvent[],
  opts?: { stopFile?: string },
): Promise<
  | {
      ok: true;
      fired: number;
      stopped: boolean;
      ms: number;
      /** 시도한 발사 수·붙여넣기 진입 수(빈 연습에서도 센다) — «멈춘 뒤 시도 0» 의 증거. 못 읽으면 -1. */
      tried: number;
      uni: number;
      /** 멈춘 단계와 사유(있으면). */
      stoppedAt?: { i: number; why: string };
    }
  | { ok: false; detail: string }
> => {
  // ★빈 열은 `post` 가 자식을 안 띄우고 돌려준다 — 그때 셋 다 **확실히 0** 이다(판독 불가 -1 과 가른다).
  if (events.length === 0) return { ok: true, fired: 0, stopped: false, ms: 0, tried: 0, uni: 0 };
  // ★**제품 `post` 를 지난다** (2026-11-24) — 종전엔 따로 `jxa` 를 불러, `post` 가 env 를 잘못 넘겨도 빈 연습은 초록이었다.
  const dry = await post(events, undefined, { ...opts, dry: true });
  if (!dry.ok) return { ok: false, detail: dry.detail };
  try {
    // ★최종 산출은 **마지막 줄**이다 — 앞은 진행(`mark`)과 멈춤(`stopped`)이다.
    const v = JSON.parse(dry.stdout.trim().split("\n").pop() ?? "") as {
      fired?: number;
      tried?: number;
      uni?: number;
      stopped?: { stopped?: unknown; why?: unknown } | null;
      ms?: number;
    };
    const st = v.stopped;
    return {
      ok: true,
      fired: typeof v.fired === "number" ? v.fired : -1,
      stopped: st !== null && st !== undefined,
      ms: typeof v.ms === "number" ? v.ms : -1,
      tried: typeof v.tried === "number" ? v.tried : -1,
      uni: typeof v.uni === "number" ? v.uni : -1,
      ...(st !== null && st !== undefined && typeof st.stopped === "number"
        ? { stoppedAt: { i: st.stopped, why: String(st.why) } }
        : {}),
    };
  } catch {
    return { ok: true, fired: -1, stopped: false, ms: -1, tried: -1, uni: -1 };
  }
};

/**
 * **지금 전면 창** — 열 안의 가드가 비교할 기준값(계약 1).
 *
 * ★형식은 `앱이름:pid` 다. **앱 단위**라 같은 앱의 다른 창으로 옮겨간 것은 못 본다 —
 *  Windows 는 HWND 라 창 단위다. **확인된 제한**이고, `look` 응답이 그렇게 말한다.
 * ★못 읽으면 `null`. 그러면 `planSteps` 가 가드를 **안 넣는다**(기준이 없는데 막으면
 *  조작이 통째로 불능이 된다, §15-27 계약 1).
 */
export const frontWindow = async (): Promise<string | null> => {
  const r = await jxa(
    "ObjC.import('AppKit'); var a = $.NSWorkspace.sharedWorkspace.frontmostApplication; " +
      "JSON.stringify(a && !a.isNil() ? {f: ObjC.unwrap(a.localizedName) + ':' + a.processIdentifier} : {})",
  );
  if (!r.ok) return null;
  try {
    const v = JSON.parse(r.out) as { f?: string };
    return typeof v.f === "string" && v.f !== "" ? v.f : null;
  } catch {
    return null;
  }
};

// ─── 제어 표시 도우미 (2026-11-24, ⑤ — 설계 `docs/decisions/2026-11-24-computer-use-indicator-esc.md` §3·§11) ────────

/**
 * **제어 표시 도우미** — 리스를 쥔 동안만 사는 `osascript` 자식 하나.
 *
 * ★하는 일 넷: ①화면마다 가장자리 주황 빛(`GLOW_JS` — 가운데는 투명) ②주 화면 위쪽 **중지 단추**(«티구클로 조작 중 · 눌러서 중지») ③**실제 커서** 둘레 고리
 *  (가짜 포인터 없음 · 버튼이 눌린 동안 채워 번쩍임 — 클릭 자리) ④멈춤 감지 — 단추 클릭이면 `{"stop":1}`, HID 키 상태
 *  (`CGEventSourceKeyState(1, 53)`)의 위→아래 엣지면 `{"esc":1}`. **감지는 여기 하나**이고 결정은 부모(`onUserStop`)가 한다.
 * ★**원격 화면에도 보인다** (⑤ r4, 설계 §11-1). 창의 `sharingType` 을 `ReadOnly(1)` 로 둔다 — 종전 `None(0)` 은 화면 공유·원격
 *  접속이 쓰는 캡처에서 창을 빼서, 원격으로 보는 사람에게 표시가 전혀 안 보였다(11-24 원격 시험). 같은 플래그가 우리 `look` 캡처에도
 *  걸리므로 «원격엔 보이고 우리 캡처엔 안 보이게» 는 이 플래그로 못 가른다 — 그래서 우리 그림에도 찍히고, `look` 응답이 그렇게 말한다.
 * ★Esc 는 **하드웨어(HID) 키보드만** 본다 — 원격 접속 도구의 키는 세션 층으로 들어와 이 상태표에 안 남는다(11-24 실측: 원격 Esc 5회가
 *  앞 창엔 갔는데 HID 키 누름 시각은 며칠 전 그대로). 그래서 표시는 Esc 를 안내하지 않는다 — 확실한 길은 단추와 `/stop` 이다.
 * ★단추만 클릭을 받는다(테두리·고리는 통과) — **언제나**(통과 모드 없음: 사람의 중지 클릭이 아래 앱으로 새면 안 된다, 독립 검토 R1).
 *  우리 클릭이 단추에 닿지 않게 하는 것은 **부모**다(`clearPillFor`): 도우미가 준비 줄과 옮김 응답에 실제 단추 자리를 싣고(`{"ready":1,"pill":…}`·
 *  `{"pill":…,"req":…}`), 부모가 발사 **전에** 누를 점과 대조해 겹치면 `TIGUCLAW_INDICATOR_MOVE` 에 요청을 쓴다 → 도우미가 위↔아래로 옮겨 응답.
 * ★창은 전부 `NSPanel`(테두리 없음 + 활성화 안 함) · 투명 · 화면보호기 레벨 · 모든 공간. 단추 클릭도 앱을 활성화하지 않는다
 *  (비활성 패널 + `acceptsFirstMouse`). 앱은 Accessory 이고 `activate` 를 부르지 않는다 — 포커스를 뺏으면 전면 창 가드가 모든 글자 입력을 멈춘다.
 * ★클릭을 받으려면 `app.run` 이어야 한다(손으로 꺼내는 루프엔 마우스 이벤트가 안 왔다) — 감시는 16ms 타이머(데몬 자식 실측 ~38ms)에서.
 * ★부모가 죽으면(`getppid()===1`) 스스로 끝난다 — 고아 표시가 남지 않게. 누른 Esc 는 삼키지 않는다(앞 창에도 간다).
 * ★빈 연습(`TIGUCLAW_DRY=1`)은 창을 만들지 않고 키를 읽지 않고 `{"ready":1,"dry":1}` 만 낸다(입력·화면 0).
 * ★문구·표식 경로는 `$env` 로 준다 — 스크립트에 끼워 넣지 않는다(`POST_SCRIPT` 와 같은 이유).
 */
/**
 * **가장자리 주황 빛** — 화면 창의 레이어에 1pt 두께 고리 레이어를 `GLOW.width` 겹 안쪽으로 쌓는다(고리 j = 가장자리에서 j pt,
 * 알파는 `indicator.ts` `GLOW` 식). 그림을 직접 그리지 않는다 — 합성기가 그리므로 Retina·크기 변화에도 같다.
 * ★색 객체는 `GLOW_C` 에 붙잡아 둔다 — 임시 `CGColor` 를 넘기면 풀린 참조가 된다(아래 번쩍임 주석의 PAC 사고와 같은 이유).
 * ★따로 내보내는 이유: 회귀가 이 조각 그대로를 창 없이 화면 밖 비트맵에 그려 알파를 잰다(사용자 화면 0).
 */
export const GLOW_JS = [
  `var GLOW_W = ${String(GLOW.width)}; var GLOW_C = [];`,
  `for (var gj = 0; gj < GLOW_W; gj++) { GLOW_C.push($.NSColor.colorWithSRGBRedGreenBlueAlpha(${String(GLOW.rgb[0] / 255)}, ${String(GLOW.rgb[1] / 255)}, ${String(GLOW.rgb[2] / 255)}, ${String(GLOW.alpha)} * Math.pow(1 - gj / GLOW_W, ${String(GLOW.falloff)}))); }`,
  "function glowInto(root, w, h){ for (var j = 0; j < GLOW_W && 2 * j < Math.min(w, h); j++) { var L = $.CALayer.layer; L.setFrame($.NSMakeRect(j, j, w - 2 * j, h - 2 * j)); L.setBorderWidth(1); L.setBorderColor(GLOW_C[j].CGColor); root.addSublayer(L); } }",
].join("\n");

export const INDICATOR_SCRIPT = [
  "ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('CoreGraphics'); ObjC.import('QuartzCore'); ObjC.import('unistd');",
  "var ENV = $.NSProcessInfo.processInfo.environment;",
  "function envStr(k){ var v = ENV.objectForKey(k); return (v && !v.isNil()) ? String(v.js) : ''; }",
  "var DRY = envStr('TIGUCLAW_DRY') === '1';",
  "var LABEL = envStr('TIGUCLAW_INDICATOR_LABEL');",
  "var MOVE = envStr('TIGUCLAW_INDICATOR_MOVE');",
  "var OUT = $.NSFileHandle.fileHandleWithStandardOutput;",
  "function emit(o){ OUT.writeData($(JSON.stringify(o) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)); }",
  "function orphan(){ return $.getppid() === 1; }",
  "if (DRY) { emit({ready: 1, dry: 1, orphan: orphan()}); }",
  "else {",
  "  var app = $.NSApplication.sharedApplication; app.setActivationPolicy(1);",
  "  var TINT = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1.0, 0.55, 0.0, 0.9);",
  // 중지 단추 — 클릭을 받아 `{"stop":1}`. 첫 클릭도 받는다(`acceptsFirstMouse`) — 비활성 패널이라 앱은 앞으로 안 나온다.
  "  ObjC.registerSubclass({ name: 'TiguclawStopView', superclass: 'NSView', methods: {",
  "    'mouseDown:': { types: ['void', ['id']], implementation: function (ev) { emit({stop: 1}); } },",
  "    'acceptsFirstMouse:': { types: ['bool', ['id']], implementation: function (ev) { return true; } }",
  "  } });",
  "  function panel(x, y, w, h){",
  // borderless(0) | NonactivatingPanel(1<<7) · NSBackingStoreBuffered(2)
  "    var p = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(x, y, w, h), 128, 2, false);",
  "    p.setOpaque(false); p.setBackgroundColor($.NSColor.clearColor); p.setHasShadow(false);",
  "    p.setIgnoresMouseEvents(true); p.setLevel(1000); p.setHidesOnDeactivate(false);",
  // canJoinAllSpaces(1) | stationary(16) | fullScreenAuxiliary(256) · sharingType ReadOnly(1) — 화면 공유·원격 접속에 보인다(§11-1).
  "    p.setCollectionBehavior(1 | 16 | 256); p.setSharingType(1);",
  "    p.contentView.setWantsLayer(true);",
  "    return p;",
  "  }",
  GLOW_JS,
  "  var screens = $.NSScreen.screens; var keep = [];",
  "  for (var i = 0; i < screens.count; i++) {",
  "    var f = screens.objectAtIndex(i).frame;",
  "    var b = panel(f.origin.x, f.origin.y, f.size.width, f.size.height);",
  "    glowInto(b.contentView.layer, f.size.width, f.size.height);",
  "    b.orderFrontRegardless; keep.push(b);",
  "  }",
  "  var main = screens.objectAtIndex(0).frame;",
  "  var label = $.NSTextField.labelWithString($(LABEL));",
  "  label.setTextColor($.NSColor.whiteColor); label.setFont($.NSFont.boldSystemFontOfSize(13));",
  "  label.sizeToFit; var lw = label.frame.size.width + 24; var lh = label.frame.size.height + 10;",
  // 단추 자리 둘 — 위(메뉴 막대 아래)·아래(Dock 위). 실제 창 자리를 CG 좌표(왼쪽 위 원점 = 주 화면 — 계획기가 쓰는 좌표)로 **출력 줄**에 싣는다.
  "  var TOPY = main.origin.y + main.size.height - lh - 34; var BOTY = main.origin.y + 110; var atTop = true;",
  "  var tag = panel(main.origin.x + (main.size.width - lw) / 2, TOPY, lw, lh);",
  "  function pillRect(){ var f = tag.frame; return {x: f.origin.x, y: main.origin.y + main.size.height - (f.origin.y + f.size.height), w: f.size.width, h: f.size.height}; }",
  "  tag.contentView.layer.setBackgroundColor(TINT.CGColor); tag.contentView.layer.setCornerRadius(lh / 2);",
  "  label.setFrameOrigin($.NSMakePoint(12, 5)); tag.contentView.addSubview(label);",
  // 글자 위를 덮는 투명 단추 뷰 — 맨 위 형제라 클릭이 글자칸이 아니라 여기로 온다.
  "  var stopView = $.TiguclawStopView.alloc.initWithFrame($.NSMakeRect(0, 0, lw, lh)); tag.contentView.addSubview(stopView);",
  "  tag.setIgnoresMouseEvents(false);",
  "  tag.orderFrontRegardless; keep.push(tag);",
  "  var R = 18;",
  "  var halo = panel(0, 0, R * 2, R * 2);",
  "  halo.contentView.layer.setBorderWidth(3); halo.contentView.layer.setBorderColor(TINT.CGColor); halo.contentView.layer.setCornerRadius(R);",
  "  halo.orderFrontRegardless; keep.push(halo);",
  // 준비 줄 = 창을 다 띄운 **뒤**, 실제 단추 자리와 함께. 부모는 이 줄을 받기 전엔 누름을 보내지 않는다(설계 §11-3).
  "  emit({ready: 1, pill: pillRect()});",
  // 비켜 달라는 요청(부모가 씀) — `;` 로 끝난 새 내용일 때만(반쯤 쓰인 요청은 무시). 받으면 위↔아래로 옮기고 **옮긴 뒤 실제 자리**를 응답한다.
  "  var lastMove = '';",
  "  function readMove(){ if (MOVE === '') { return ''; } var s = $.NSString.stringWithContentsOfFileEncodingError($(MOVE), $.NSUTF8StringEncoding, null); return (s && !s.isNil()) ? String(s.js) : ''; }",
  "  var wasDown = false; var flashUntil = 0; var flashing = false;",
  "  var PI = $.NSProcessInfo.processInfo;",
  // ★★**`app.run` + 타이머다 — 손으로 이벤트를 꺼내지 않는다** (⑤ r4 실측). `nextEventMatchingMask…` 로 직접 돌리면 **마우스 클릭이
  //  이 앱에 아예 오지 않았다**(최소 패널 4변형 중 `app.run` 만 `mouseDown:` 을 받음) — 단추가 눌리지 않는다.
  // ★타이머 주기: 데몬 자식에서 타이머·날짜 시한 대기가 늘어난다(실측: `runUntilDate(0.02)` 초당 6회 · 타이머 0.016 → 26Hz ·
  //  0.008 → 49Hz). CPU 는 0.008 이 한 코어의 14.8%, 0.016 이 9.3%(4초 평균) — 표시는 조작 중 + 유휴 60초 동안 떠 있으므로
  //  0.016(허용 오차 0, 실측 ~38ms)으로 둔다. 번쩍임은 `CLICK_HOLD_MS`, 비킴 응답 대기(`PILL_MOVE_WAIT_MS`)가 이 주기보다 넉넉하다.
  "  ObjC.registerSubclass({ name: 'TiguclawTick', superclass: 'NSObject', methods: {",
  "    'tick:': { types: ['void', ['id']], implementation: function (tm) {",
  "      try {",
  "        if (orphan()) { $.exit(0); }",
  "        var down = $.CGEventSourceKeyState(1, 53) ? true : false;",
  "        if (down && !wasDown) { emit({esc: 1}); }",
  "        wasDown = down;",
  "        var mv = readMove();",
  "        if (mv !== lastMove && mv.charAt(mv.length - 1) === ';') { lastMove = mv; atTop = !atTop; tag.setFrameOrigin($.NSMakePoint(tag.frame.origin.x, atTop ? TOPY : BOTY)); emit({pill: pillRect(), req: mv}); }",
  "        var m = $.NSEvent.mouseLocation;",
  "        halo.setFrameOrigin($.NSMakePoint(m.x - R, m.y - R));",
  // 버튼이 눌렸으면(누가 눌렀든) 고리를 잠깐 굵게 — 클릭 자리가 눈에 보이게. 우리 클릭은 `CLICK_HOLD_MS` 동안 누른다.
  // ★색 객체를 넘기지 않는다 — 임시 `NSColor.clearColor.CGColor` 를 넘기자 풀린 참조로 `setBackgroundColor:` 에서 PAC 예외 →
  //  커널이 도우미를 SIGKILL 했다(⑤ r4 실측 12:11·12:12, 클릭 순간). 두께(숫자)만 바꾼다 — Windows 도우미와 같은 모양.
  "        var t = PI.systemUptime;",
  "        if (Number($.NSEvent.pressedMouseButtons) !== 0) { flashUntil = t + 0.25; }",
  "        var fl = t < flashUntil;",
  "        if (fl !== flashing) { flashing = fl; halo.contentView.layer.setBorderWidth(fl ? 8 : 3); }",
  // 콜백 안의 예외는 프로세스를 죽인다 — 한 줄 남기고 스스로 끝낸다(부모가 «종료» 로 받는다, 표시 실패는 조작을 안 막는다).
  "      } catch (e) { emit({error: String(e), type: 'tick'}); $.exit(1); }",
  "    } }",
  "  } });",
  "  var ticker = $.TiguclawTick.alloc.init;",
  "  var timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.016, ticker, 'tick:', $(), true);",
  "  timer.setTolerance(0); $.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);",
  "  app.run;",
  "}",
].join("\n");

/**
 * **도우미를 띄운다** — `IndicatorBackend.start` 의 맥 구현.
 *
 * ★출력 프로토콜(`{"esc":1}`·`{"stop":1}`·`{"error":…}`)·`onGone` 한 번·`stop()` 한 번은 `watchIndicatorChild` 한 곳(Windows 도우미와 공유).
 */
export const startIndicator = (o: {
  label: string;
  moveFile: string;
  onStop: (via: StopVia) => void;
  onGone: (why: string) => void;
  onReady?: (pill: PillRect | null) => void;
  onPill?: (pill: PillRect | null, req: string) => void;
}): IndicatorHandle =>
  watchIndicatorChild(
    spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", INDICATOR_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TIGUCLAW_DRY: "0", TIGUCLAW_INDICATOR_LABEL: o.label, TIGUCLAW_INDICATOR_MOVE: o.moveFile },
    }),
    o,
  );
