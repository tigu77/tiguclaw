/**
 * **Windows 실행부** — `mac.ts` 의 형제. 여기도 불순하다(자식 프로세스).
 *
 * ★**의존성 0**: PowerShell 과 .NET(`System.Drawing`·`System.Windows.Forms`)은 Windows
 *  내장이다. 스크린샷 네이티브 모듈을 들이지 않는 이유는 mac 쪽과 같다 — 네이티브 빌드가
 *  붙으면 윈도우 설치에서 터진 이력이 있다([[project_windows_update_tsc_missing_prod_env]]).
 *
 * ★★**mac 과 다른 점 셋** (그래서 코드를 공유하지 않고 형제로 둔다):
 *  1. **권한 프롬프트가 없다.** Windows 는 화면 캡처에 TCC 같은 동의가 없어서, mac 의
 *     «권한 대화상자가 프로세스를 막는다»(설계 §4-2) 위험이 여기엔 없다.
 *  2. 대신 **세션**이 그 자리다. 데몬이 서비스(Session 0)로 떠 있으면 사용자 데스크톱이
 *     아예 없다 — .NET 이 «handle is invalid» 로 던지거나 화면을 0개로 센다. 이건 권한이
 *     아니라 **어떻게 띄웠나**의 문제라 처방이 다르다(`winPreflightMessage`).
 *  3. **디스플레이 배치를 OS 가 알려준다**(`Screen.AllScreens` 의 `Bounds`). mac 에선
 *     원점·배율을 알 수단이 없어 «조작은 주 화면 한정» 으로 접었는데(설계 §6-C), Windows 는
 *     그 정보가 공짜다. 2단계 기하가 이쪽에선 더 단순하다.
 *
 * ★**DPI 는 자식이 스스로 해결한다.** 프로세스가 DPI-unaware 면 Windows 가 **축소된 가상
 *  해상도**를 돌려줘서 «캡처는 됐는데 기하가 조용히 틀어진» 상태가 된다 — 맥의 배율 문제와
 *  같은 부류인데 증상이 더 은밀하다(그림은 멀쩡해 보인다). 데몬 전체를 DPI-aware 로 만들
 *  필요는 없다: **캡처가 자식에서 일어나므로 자식만 선언하면 된다.**
 *
 * ★★**절대 매달리지 않는다** — mac.ts 와 같은 불변식. MCP `callTool` 천장은 11분이라
 *  우리가 안 끊으면 턴이 그만큼 묶인다.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  winCaptureEnv,
  FRAME_LONG_EDGE,
  type CheckedTarget,
  type ScreenRect,
} from "./observe.js";

/**
 * 탐침 한 줄에서 **화면 사각형 목록**을 읽는다. 못 읽으면 `null` — «모른다» 이고,
 * 그때 순수 판정은 요청을 막지 않는다(관측은 가역이다).
 */
const parseScreens = (line: string): ScreenRect[] | null => {
  try {
    const m = JSON.parse(line) as { screens?: unknown };
    if (!Array.isArray(m.screens)) return null;
    const rects = m.screens.filter(
      (r): r is ScreenRect =>
        typeof r === "object" &&
        r !== null &&
        ["x", "y", "w", "h"].every((k) => typeof (r as Record<string, unknown>)[k] === "number"),
    );
    return rects.length === 0 ? null : rects;
  } catch {
    return null;
  }
};

/**
 * 자식 하나의 시한.
 *
 * ★★**안 잰 값이다**(2026-09-17). mac 은 4초인데 여기가 더 긴 이유는 PowerShell 기동
 *  (~0.3–0.8초)에 더해 `Add-Type` 이 **C# 을 즉석 컴파일**하기 때문이다(첫 호출이 특히
 *  느리다). 회사돌쇠 실측으로 확정한다 — 짧으면 멀쩡한 캡처를 시한으로 죽이고, 길면
 *  «안 매달린다» 는 약속이 느슨해진다.
 */
const CHILD_TIMEOUT_MS = 15_000;

/** `powershell.exe` 를 **절대 경로로** 부른다 — PATH 를 믿지 않는다(mac 이 `/usr/sbin` 을 박는 것과 같다). */
const psExe = (): string =>
  path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

/**
 * **캡처 스크립트 — 고정 리터럴이다.** 변하는 값은 전부 `$env:` 로 들어온다(`winCaptureEnv`).
 *
 * ★문자열을 끼워 넣지 않는 이유: 파일 이름엔 `threadKey` 가 들어가고 그건 바깥에서 온다.
 *  PowerShell 은 `-Command` 를 **다시 파싱**하므로 끼워 넣으면 그게 코드가 될 수 있다.
 * ★그리고 이 스크립트는 `-EncodedCommand`(UTF-16LE base64)로 넘긴다 — 명령줄 따옴표
 *  규칙(Node → Windows → CommandLineToArgvW → PowerShell)을 **아예 지나지 않는다.**
 */
const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -AssemblyName System.Windows.Forms",
  // ① DPI — 화면을 **묻기 전에** 선언해야 한다. 물은 뒤엔 늦다.
  "$dpi='none'",
  // ★세 덩이를 **따로** 감싼다. 하나로 묶으면 최신 API 가 없는 빌드(8.1 이하)에서 던지는
  //  순간 **예전 API 까지 건너뛴다** — 되는 길이 있는데 안 쓰는 것이라 더 나쁘다.
  "try{",
  "Add-Type -Namespace TC -Name Dpi -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);',
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  "'@",
  "}catch{}",
  // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.
  "try{if([TC.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))){$dpi='v2'}}catch{}",
  "if($dpi -eq 'none'){try{if([TC.Dpi]::SetProcessDPIAware()){$dpi='system'}}catch{}}",
  // ② 화면 — 1번이 주 화면이 되도록 정렬한다(mac `-D1` 과 같은 의미).
  "$all=[System.Windows.Forms.Screen]::AllScreens",
  "$ordered=@($all|Where-Object{$_.Primary})+@($all|Where-Object{-not $_.Primary})",
  // ★화면이 0개 = **데스크톱 세션이 없다**(Session 0 서비스). 캡처 실패가 아니라 배치 문제다.
  "if($ordered.Count -eq 0){[Console]::Error.WriteLine('no-desktop: no screens in this session');exit 4}",
  "$mode=$env:TIGUCLAW_MODE",
  "if($mode -eq 'display'){",
  "$i=[int]$env:TIGUCLAW_DISPLAY",
  // ★mac `screencapture -D` 는 틀린 번호에 **개수를 알려주며** 실패한다. 도구 설명이 그걸
  //  «발견 경로» 로 쓰고 있으므로(열거 도구를 안 만든 근거) Windows 도 같은 말을 해야 한다.
  "if($i -lt 1 -or $i -gt $ordered.Count){[Console]::Error.WriteLine('Invalid display specified. Only '+$ordered.Count+' display(s), valid values are 1..'+$ordered.Count+'.');exit 3}",
  "$b=$ordered[$i-1].Bounds",
  "}elseif($mode -eq 'region'){",
  "$b=New-Object System.Drawing.Rectangle([int]$env:TIGUCLAW_X,[int]$env:TIGUCLAW_Y,[int]$env:TIGUCLAW_W,[int]$env:TIGUCLAW_H)",
  "}elseif($mode -eq 'probe'){",
  "$p=$ordered[0].Bounds",
  "$b=New-Object System.Drawing.Rectangle($p.X,$p.Y,1,1)",
  "}else{",
  "$b=$ordered[0].Bounds",
  "}",
  "if($b.Width -le 0 -or $b.Height -le 0){[Console]::Error.WriteLine('no-desktop: empty bounds');exit 4}",
  // ③ 캡처
  "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)",
  "$g=[System.Drawing.Graphics]::FromImage($bmp)",
  "$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)",
  "$g.Dispose()",
  // ④ 줄이기 — mac 의 `sips -Z` 자리. 여기선 같은 프로세스가 하므로 자식이 하나로 끝난다.
  "$le=[int]$env:TIGUCLAW_LONG_EDGE",
  "$max=[Math]::Max($bmp.Width,$bmp.Height)",
  "if($le -gt 0 -and $max -gt $le){",
  "$r=$le/$max",
  "$nw=[Math]::Max(1,[int][Math]::Round($bmp.Width*$r))",
  "$nh=[Math]::Max(1,[int][Math]::Round($bmp.Height*$r))",
  "$dst=New-Object System.Drawing.Bitmap($nw,$nh)",
  "$g2=[System.Drawing.Graphics]::FromImage($dst)",
  "$g2.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
  "$g2.DrawImage($bmp,0,0,$nw,$nh)",
  "$g2.Dispose()",
  "$bmp.Dispose()",
  "$bmp=$dst",
  "}",
  // ⑤ JPEG — 해상도보다 압축으로 줄인다(설계 실측: 같은 화면 PNG 1.32MB vs JPEG q80 0.23MB).
  "$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}|Select-Object -First 1",
  "$eps=New-Object System.Drawing.Imaging.EncoderParameters(1)",
  "$eps.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[int]$env:TIGUCLAW_QUALITY)",
  "$w=$bmp.Width",
  "$h=$bmp.Height",
  "$bmp.Save($env:TIGUCLAW_OUT,$enc,$eps)",
  "$bmp.Dispose()",
  // ⑥ ★**판정 수치를 같이 낸다.** 로그가 1차 진단면이라 «됐다/안 됐다» 만으론 못 고친다
  //    ([[feedback_logs_must_stand_alone]]) — 화면 수·전달 크기·DPI 선언 결과가 그 수치다.
  // ★화면 **사각형 목록**을 낸다 — 개수만으로는 «이 좌표가 화면 안인가» 를 못 판정한다
  //  (2026-09-17 회사돌쇠 실기: 화면 밖 region 이 성공으로 돌아왔다). 판정은 순수부가 한다.
  "$js=''",
  "foreach($s in $ordered){if($js -ne ''){$js+=','}$js+='{\"x\":'+$s.Bounds.X+',\"y\":'+$s.Bounds.Y+',\"w\":'+$s.Bounds.Width+',\"h\":'+$s.Bounds.Height+'}'}",
  "[Console]::Out.WriteLine('{\"screens\":['+$js+'],\"w\":'+$w+',\"h\":'+$h+',\"dpi\":\"'+$dpi+'\"}')",
].join("\n");

const encoded = (): string => Buffer.from(SCRIPT, "utf16le").toString("base64");

interface RunOk {
  ok: true;
  stdout: string;
}
interface RunFail {
  ok: false;
  reason: "timeout" | "failed";
  detail: string;
}

const run = (env: Record<string, string>): Promise<RunOk | RunFail> =>
  new Promise((resolve) => {
    execFile(
      psExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded()],
      {
        timeout: CHILD_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: { ...process.env, ...env },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err === null) return resolve({ ok: true, stdout: String(stdout) });
        const killed = (err as { killed?: boolean }).killed === true;
        // ★**stderr 를 앞에 둔다.** 스크립트가 남긴 «왜» 가 거기 있고, `err.message` 는
        //  `Command failed: …` 로 시작해 경로만 길게 싣는다(mac 에서 유출로 한 번 겪은 것).
        const why = String(stderr).trim() !== "" ? String(stderr).trim() : err.message;
        resolve({
          ok: false,
          reason: killed ? "timeout" : "failed",
          detail: killed ? `${CHILD_TIMEOUT_MS}ms 초과` : why.slice(0, 300),
        });
      },
    );
  });

/**
 * **세션·DPI 프리플라이트** — 1×1 픽셀을 찍어 본다(mac 과 같은 모양).
 *
 * ★Windows 에선 이게 «권한 확인» 이 아니라 **«데스크톱이 있는가» 확인**이다. 그리고 그
 *  결과(화면 수·DPI 선언)를 `info` 로 올려 보낸다 — 코드를 쓰기 전에 사람이 재야 했던 두
 *  가지가 바로 이것이라, **관측 자체가 그걸 말하게** 했다.
 */
export const preflight = async (): Promise<
  { ok: true; info?: string } | { ok: false; reason: "timeout" | "failed"; detail: string }
> => {
  const probe = path.join(
    os.tmpdir(),
    // mac 과 같은 이유로 **호출마다 고유**해야 한다 — 동시 관측이 서로의 산출물을 지운다.
    `tiguclaw-screen-probe-${String(process.pid)}-${randomUUID()}.jpg`,
  );
  try {
    const r = await run(winCaptureEnv({ kind: "probe" }, probe, { longEdge: 0 }));
    if (!r.ok) return r;
    try {
      const st = await fs.stat(probe);
      if (st.size === 0) return { ok: false, reason: "failed", detail: "빈 파일" };
    } catch {
      return { ok: false, reason: "failed", detail: "산출물 없음" };
    }
    const line = r.stdout.trim().split("\n").pop() ?? "";
    return {
      ok: true,
      info: line === "" ? undefined : line,
      ...(parseScreens(line) === null ? {} : { screens: parseScreens(line) as ScreenRect[] }),
    };
  } finally {
    await fs.rm(probe, { force: true }).catch(() => {});
  }
};

/**
 * 실제 캡처 — 찍고, 줄이고, JPEG 으로 저장하고 바이트를 돌려준다.
 *
 * ★mac 은 자식이 둘(`screencapture` → `sips`)인데 여기는 **하나**다. 한 프로세스가 다
 *  하므로 «변환만 실패» 라는 중간 상태가 없다 — 그래서 `longEdge: -1`(줄이기 실패) 경로가
 *  Windows 엔 없다. 대신 **실제 전달 크기**를 스크립트가 알려주므로 그 값을 그대로 쓴다
 *  (화면이 1600px 보다 작으면 안 줄이고, 그때 «긴 변 1600» 이라 말하면 그게 거짓이다).
 */
export const capture = async (
  // ★★**검증을 통과한 대상만 받는다** (2026-09-17, 회사돌쇠 재검토). 종전엔 `CaptureTarget`
  //  이라 이 함수를 **직접 부르면** 화면 밖 좌표가 그대로 성공했다 — 검사가 도구 핸들러에만
  //  있었기 때문이다. 인터페이스(`ObserveBackend`)만 좁히는 것으로는 안 막힌다: 넓은 인자를
  //  받는 함수는 좁은 계약에 그냥 들어맞는다(반공변). **선언 자체**가 좁아야 한다.
  target: CheckedTarget,
  outPath: string,
): Promise<
  | { ok: true; bytes: number; longEdge: number; path: string; info?: string }
  | { ok: false; reason: "timeout" | "failed"; detail: string }
> => {
  const shot = await run(winCaptureEnv(target, outPath));
  if (!shot.ok) {
    await fs.rm(outPath, { force: true }).catch(() => {});
    return shot;
  }
  const line = shot.stdout.trim().split("\n").pop() ?? "";
  let longEdge = FRAME_LONG_EDGE;
  try {
    const m = JSON.parse(line) as { w?: number; h?: number };
    if (typeof m.w === "number" && typeof m.h === "number") longEdge = Math.max(m.w, m.h);
  } catch {
    // 수치를 못 읽어도 캡처는 성립한다 — 상한을 그대로 쓴다(거짓말은 아니다, 상한이다).
  }
  try {
    const st = await fs.stat(outPath);
    if (st.size === 0) return { ok: false, reason: "failed", detail: "빈 파일" };
    return {
      ok: true,
      bytes: st.size,
      longEdge,
      path: outPath,
      info: line === "" ? undefined : line,
    };
  } catch {
    return { ok: false, reason: "failed", detail: "산출물 없음" };
  }
};
