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
import { execFile } from "node:child_process";
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
import type { LowEvent } from "./control.js";

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
): Promise<
  | { ok: true; out: string }
  // ★`out` 은 **실패해도 싣는다** (2026-09-19, 계약 3) — 죽은 자식이 어디까지 갔는지는
  //  여기에만 남아 있고, 종전엔 그것을 버려서 시한 초과에 `"4000ms 초과"` 만 남았다.
  //  ★부분일 수 있다(줄 중간에서 잘린다). 읽는 쪽은 **완전한 줄만** 쓴다.
  | { ok: false; reason: "timeout" | "failed"; detail: string; out: string }
> =>
  new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL", env: { ...process.env, ...env } },
      (err, so, se) => {
        if (err === null) return resolve({ ok: true, out: String(so).trim() });
        const killed = (err as { killed?: boolean }).killed === true;
        const why = String(se).trim() !== "" ? String(se).trim() : err.message;
        resolve({
          ok: false,
          reason: killed ? "timeout" : "failed",
          detail: killed ? `${CHILD_TIMEOUT_MS}ms 초과` : why.slice(0, 300),
          out: String(so),
        });
      },
    );
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
const POST_SCRIPT = [
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
  "function post(ev){ if (DRY) { return; } FIRED = FIRED + 1; $.CGEventPost(SESSION_TAP, ev); }",
  // ★**진행을 흘린다**(계약 3). 최종식만으로는 중간 출력이 안 되므로 **파일 핸들에 직접**
  //  쓴다. 실측(2026-09-19): 세 줄을 쓰고 SIGKILL 하면 **3/3 이 도착한다** — 죽은 자식이
  //  어디까지 갔는지를 말할 수 있는 유일한 길이다.
  "ObjC.import('Foundation');",
  "var OUT = $.NSFileHandle.fileHandleWithStandardOutput;",
  "function emit(o){ OUT.writeData($(JSON.stringify(o) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)); }",
  // ★**전면 창 — 자식 «안» 에서 본다**(계약 1). 실측 0.10ms/회. 따로 띄우면 64ms 라
  //  «매 step 마다» 가 아예 불가능해진다.
  //  ★★맥은 **앱 단위**다(`localizedName:pid`). 같은 앱의 **다른 창**으로 옮겨간 것은 못
  //   본다 — Windows 는 HWND 라 창 단위다. **확인된 제한**이고, 숨기지 않고 적는다.
  "var WS = $.NSWorkspace.sharedWorkspace;",
  "function frontNow(){ try { var a = WS.frontmostApplication; if (!a || a.isNil()) { return null; } return ObjC.unwrap(a.localizedName) + ':' + a.processIdentifier; } catch (e) { return null; } }",
  "var CUR = -1; var STOP = null;",
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
  "    if (heldNames.length > 0) throw new Error('이 배치에서 «' + name + '» 는 키로 누를 수 없습니다 — 수식키(' + heldNames.join('+') + ')와 함께 쓸 수 없습니다. 글자를 넣는 것이 목적이면 type_text 를 쓰세요.');",
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
  // ★빈 연습에선 **여기서 곧장 돌아온다** — 클립보드는 남의 물건이고, 「입력 0」은
  //  «안 쐈다» 만이 아니라 «아무것도 안 건드렸다» 여야 한다. 발사구(`post`)가 이미
  //  막고 있지만 붙여넣기 경로는 **쏘기 전에** 남의 상태를 바꾼다.
  "  if (DRY) { return; }",
  "  var pb = $.NSPasteboard.generalPasteboard;",
  "  var prev = pb.stringForType($.NSPasteboardTypeString);",
  "  var prevStr = prev.isNil() ? null : ObjC.unwrap(prev);",
  "  pb.clearContents;",
  "  pb.setStringForType($(text), $.NSPasteboardTypeString);",
  "  delay(0.05);",
  "  var d = $.CGEventCreateKeyboardEvent($(), 9, true);",   // v
  "  $.CGEventSetFlags(d, 0x100000 | flags());",
  "  post(d); delay(0.03);",
  "  var u = $.CGEventCreateKeyboardEvent($(), 9, false);",
  "  $.CGEventSetFlags(u, 0x100000 | flags());",
  "  post(u); delay(0.25);",
  "  pb.clearContents;",
  "  if (prevStr !== null) pb.setStringForType($(prevStr), $.NSPasteboardTypeString);",
  "}",
  "var BTN = {left:{d:1,u:2,b:0,drag:6}, right:{d:3,u:4,b:1,drag:7}, middle:{d:25,u:26,b:2,drag:27}};",
  "for (var i = 0; i < evs.length; i++) {",
  "  var e = evs[i];",
  // ★입력이 아닌 원소는 **`delay(0.012)` 를 안 태운다** — 64개 열이면 0.77초가 그냥 샌다.
  "  if (e.t === 'mark') { CUR = e.i; emit({step: e.i}); continue; }",
  "  if (e.t === 'wait') { delay(e.ms / 1000); continue; }",
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
  "  delay(0.012);",  // 앱이 이벤트를 소화할 틈 — 너무 빠르면 흘린다
  "}",
  "if (STOP) { emit(STOP); }",
  "JSON.stringify({items: evs.length, fired: FIRED, stopped: STOP})",
].join("\n");

export const post = async (
  events: readonly LowEvent[],
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
  const r = await jxa(POST_SCRIPT, {
    TIGUCLAW_EVENTS: JSON.stringify(events),
    TIGUCLAW_DRY: "0",
  });
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
const DRY_EVENTS: readonly LowEvent[] = [
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
  | { ok: true; dryFired: number; dryStopped: boolean }
  | { ok: false; where: "dry"; detail: string }
> => {
  const dry = await jxa(POST_SCRIPT, {
    TIGUCLAW_DRY: "1",
    TIGUCLAW_EVENTS: JSON.stringify(DRY_EVENTS),
  });
  if (!dry.ok) return { ok: false, where: "dry", detail: dry.detail };
  // ★빈 연습이면 **한 번도 안 쏴야** 한다 — 그 숫자가 이름의 뜻을 지킨다.
  try {
    // ★최종 산출은 **마지막 줄**이다 — 앞은 진행(`mark`)과 멈춤(`stopped`)이다.
    const v = JSON.parse(dry.out.trim().split("\n").pop() ?? "") as {
      fired?: number;
      stopped?: unknown;
    };
    return {
      ok: true,
      dryFired: typeof v.fired === "number" ? v.fired : -1,
      // ★**가드가 실제로 멈췄나** — 일부러 어긋나는 `front` 를 줬으므로 반드시 멈춰야 한다.
      dryStopped: v.stopped !== null && v.stopped !== undefined,
    };
  } catch {
    return { ok: true, dryFired: -1, dryStopped: false };
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
