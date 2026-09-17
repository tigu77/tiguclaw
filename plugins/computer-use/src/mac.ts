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
} from "./observe.js";

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
  { ok: true } | { ok: false; reason: "timeout" | "failed"; detail: string }
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
    return { ok: true };
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
export const capture = async (
  // ★★**검증을 통과한 대상만 받는다** (2026-09-17, 회사돌쇠 재검토). 종전엔 `CaptureTarget`
  //  이라 이 함수를 **직접 부르면** 화면 밖 좌표가 그대로 성공했다 — 검사가 도구 핸들러에만
  //  있었기 때문이다. 인터페이스(`ObserveBackend`)만 좁히는 것으로는 안 막힌다: 넓은 인자를
  //  받는 함수는 좁은 계약에 그냥 들어맞는다(반공변). **선언 자체**가 좁아야 한다.
  target: CheckedTarget,
  outPath: string,
): Promise<
  | { ok: true; bytes: number; longEdge: number; path: string }
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
    };
  } catch {
    return { ok: false, reason: "failed", detail: "산출물 없음" };
  }
};
