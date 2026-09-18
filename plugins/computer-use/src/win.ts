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
import type { LowEvent } from "./control.js";

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
 * 자식 하나의 시한 — **재고 정했다** (2026-09-17, 회사돌쇠 실기).
 *
 * ★처음엔 15초를 «안 잰 값» 으로 박아뒀다. 실측이 들어왔으므로 확정한다:
 *
 *      preflight  790 / 801 / 782 ms      (자식 1개 · Add-Type C# 즉석 컴파일 포함)
 *      capture    900 / 937 / 899 ms      (자식 1개 · 캡처+축소+JPEG)
 *      콜드 종단  약 2초                   (데몬 재시작 직후 첫 호출, 로그 초 단위)
 *
 *  시한은 **자식 하나당**이므로 최대 관측치가 0.94초다. 8초면 **8배 여유**이고, 그만큼
 *  «최악으로 매달리는 시간» 이 절반이 된다. mac 이 4초인 것과도 균형이 맞는다(여긴
 *  PowerShell 기동 + 컴파일이 얹힌다).
 *
 * ★★**이 실측은 기계 하나짜리다** — 회사 Windows PC · 2560×1440 모니터 둘 · `dpi=v2`.
 *  느린 디스크·백신 실시간 검사·모니터가 더 많은 기계는 더 걸릴 수 있다. 8초를 고른 것은
 *  «4배면 충분» 이 아니라 **8배를 남겼기 때문**이고, 시한에 걸리는 사례가 실제로 보고되면
 *  그때는 숫자를 올리는 게 아니라 **무엇이 느린지부터 로그로 본다**(어느 자식인지가 찍힌다).
 */
const CHILD_TIMEOUT_MS = 8_000;

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

/** 캡처 전용 래퍼 — 고정 스크립트에 env 만 바꿔 넣는다. */
const run = (env: Record<string, string>): Promise<RunOk | RunFail> => runScript(SCRIPT, env);

interface RunOk {
  ok: true;
  stdout: string;
}
interface RunFail {
  ok: false;
  reason: "timeout" | "failed";
  detail: string;
}

/**
 * **오류를 stdout 으로 끌어낸다** (2026-09-17 실기).
 *
 * ★PowerShell 은 자식으로 돌 때 stderr 를 **CLIXML** 로 싼다. 우리는 그걸 300자에서 잘라
 *  보여줬는데, 잘린 앞부분이 **CLIXML 서문뿐**이라 **진짜 오류가 안 보였다** — 컴파일이
 *  깨졌는데 «왜» 가 사라진 것이다. 그래서 스크립트가 **자기 오류를 stdout 에 JSON 으로**
 *  적게 한다(형식을 우리가 정한다 = 잘릴 일이 없다). stderr 는 보조로만 남는다.
 */
/**
 * 스크립트가 스스로 적은 오류(우리 형식) — 있으면 그게 «왜» 의 정본이다.
 *
 * ★**한 줄도 버리지 않는다** (2026-09-17 2차 실기). 종전엔 ①문자열이 아니면 ②JSON 이 안
 *  읽히면 **둘 다 `null`** 로 떨어져, 그 순간 «왜» 가 통째로 사라지고 껍데기만 남았다
 *  (실기 보고의 `detail:"System.Management.Automation.PSCustomObject"` 가 그 모양이다).
 *  이제 **못 읽어도 줄을 그대로** 주고, 문자열이 아니면 **그 값을 그대로** 보여준다.
 */
export const scriptError = (stdout: string): string | null => {
  const line = stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) return null;
  let v: { error?: unknown; type?: unknown; at?: unknown };
  try {
    v = JSON.parse(line) as typeof v;
  } catch {
    // 우리 형식처럼 생겼는데 못 읽었다 — 진단은 **원문**이 있어야 한다.
    return line.includes('"error"') ? `(읽을 수 없는 오류 줄) ${line}`.slice(0, 400) : null;
  }
  if (v.error === undefined) return null;
  const msg = typeof v.error === "string" ? v.error : JSON.stringify(v.error);
  // ★**«무엇이었나»(예외 형)** 를 같이 준다 — 메시지가 비거나 껍데기일 때 이게 유일한 단서다.
  const kind = typeof v.type === "string" && v.type !== "" ? ` [${v.type}]` : "";
  const at =
    typeof v.at === "string" && v.at.trim() !== ""
      ? ` @ ${v.at.trim().split("\n")[0] ?? ""}`
      : "";
  const full = `${msg}${kind}${at}`.trim();
  return full === "" ? null : full.slice(0, 400);
};

/**
 * **CLIXML 껍데기를 벗긴다** — 보조 경로.
 *
 * ★PowerShell 이 자식으로 돌면 stderr 가 `#< CLIXML` 로 시작하는 XML 이다. 그냥 앞에서
 *  자르면 **서문만 남고 진짜 오류가 사라진다**(실기에서 그렇게 «왜» 를 잃었다). 태그를
 *  걷어내고 **의미 있는 마지막 조각**을 준다.
 */
export const cleanPowerShellError = (raw: string): string | null => {
  const text = raw.trim();
  if (text === "") return null;
  if (!text.startsWith("#< CLIXML")) return text.slice(0, 400);
  const inner = text
    .replace(/^#< CLIXML\s*/, "")
    .replace(/<[^>]*>/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/_x000D__x000A_|_x000A_/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  // ★**앞이 아니라 «가장 긴 줄»** 을 고른다 — CLIXML 은 머리말이 길고 본문이 뒤에 온다.
  const best = inner.reduce((a, b) => (b.length > a.length ? b : a), "");
  return best === "" ? null : best.slice(0, 400);
};

/**
 * 스크립트를 try/catch 로 감싸 **오류를 우리 형식으로 stdout 에** 적게 한다.
 *
 * ★**JSON 을 손으로 만들지 않는다** (2026-09-17 2차 실기). 종전엔 `-replace` 로 따옴표·
 *  역슬래시를 직접 이스케이프해 문자열을 이어 붙였는데, 그 치환이 틀려서 **따옴표가 든
 *  오류 메시지가 JSON 을 깨뜨렸다** — 그리고 깨진 JSON 은 위에서 `null` 이 되어 «왜» 가
 *  사라졌다. 정작 이번 음수 스크롤 오류가 *따옴표가 든* 형 변환 메시지다. 이제
 *  `ConvertTo-Json` 이 이스케이프를 맡는다 — 우리가 틀릴 자리를 없앤다.
 * ★메시지에 더해 **예외 형(`type`)과 위치(`at`)** 를 싣는다. 메시지가 껍데기로 보일 때
 *  «그래서 그게 뭐였나» 를 답하는 것이 이 둘이다.
 */
const wrapped = (script: string): string =>
  [
    // ★★**출력을 UTF-8 로 못 박는다** (2026-09-18, 회사돌쇠 3차 P1).
    //  Windows PowerShell 은 stdout 을 **그 기계의 코드 페이지**로 내는데(한국어면 CP949,
    //  일본어면 CP932, 서유럽이면 CP1252) Node 는 UTF-8 로 읽는다. 그래서 **ASCII 밖 글자가
    //  U+FFFD 로 바뀌어 도착했다** — 되돌릴 수 없는 손실이라 하류에서 복구할 방법이 없다.
    //  실기에서 오류 하나가 «U+FFFD 82개, 한글 0자» 로 왔다(한국어 기계였을 뿐, 어느
    //  언어든 같은 길로 사라진다).
    //  ★2차 이후 «왜» 를 살리려 쌓은 세 겹(ConvertTo-Json · 예외형+위치 · detail 을 도구
    //   응답까지)이 **마지막 한 걸음에서 전부 무의미해지던 자리**다. 우리 오류 문구는
    //   거의 다 한글이다.
    //  ★`try` **밖**에 둔다 — 스크립트가 일찍 죽어도 오류 문구는 UTF-8 로 나와야 한다.
    //  BOM 없는 UTF8Encoding 이어야 첫 줄에 쓰레기 바이트가 안 붙는다.
    "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}",
    "try { $OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}",
    "try {",
    script,
    "} catch {",
    "  $err = $_",
    "  $msg = ''",
    "  try { $msg = [string]$err.Exception.Message } catch {}",
    "  if([string]::IsNullOrWhiteSpace($msg)){ try { $msg = [string]$err } catch {} }",
    "  $kind = ''",
    "  try { $kind = [string]$err.Exception.GetType().FullName } catch {}",
    "  $at = ''",
    "  try { $at = [string]$err.InvocationInfo.PositionMessage } catch {}",
    "  try {",
    "    [Console]::Out.WriteLine((@{ error = $msg; type = $kind; at = $at } | ConvertTo-Json -Compress))",
    "  } catch {",
    "    [Console]::Error.WriteLine($msg)",
    "  }",
    "  exit 1",
    "}",
  ].join("\n");

/**
 * **PowerShell 자식 하나** — 스크립트를 받는다.
 *
 * ★관측만 있을 땐 스크립트가 하나뿐이라 안 받았는데, 조작이 붙으며 셋이 됐다(캡처·유휴·입력).
 *  ★`-EncodedCommand`(UTF-16LE base64)는 **셋 다 그대로** — 명령줄 따옴표 규칙을 아예 안 지난다.
 */
const runScript = (script: string, env: Record<string, string>): Promise<RunOk | RunFail> =>
  new Promise((resolve) => {
    execFile(
      psExe(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(wrapped(script), "utf16le").toString("base64"),
      ],
      {
        timeout: CHILD_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: { ...process.env, ...env },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = String(stdout);
        // ★**스크립트가 제 오류를 stdout 에 적었으면 그게 정본**이다(형식을 우리가 정했다).
        const own = scriptError(out);
        if (err === null && own === null) return resolve({ ok: true, stdout: out });
        const killed = (err as { killed?: boolean }).killed === true;
        resolve({
          ok: false,
          reason: killed ? "timeout" : "failed",
          detail: killed
            ? `${CHILD_TIMEOUT_MS}ms 초과`
            : (own ?? cleanPowerShellError(String(stderr)) ?? err?.message.slice(0, 300) ?? "알 수 없는 실패"),
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
  | { ok: true; info?: string; screens?: readonly ScreenRect[] }
  | { ok: false; reason: "timeout" | "failed"; detail: string }
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
  | {
      ok: true;
      bytes: number;
      longEdge: number;
      path: string;
      info?: string;
      deliveredPx: { w: number; h: number } | null;
    }
  | { ok: false; reason: "timeout" | "failed"; detail: string }
> => {
  const shot = await run(winCaptureEnv(target, outPath));
  if (!shot.ok) {
    await fs.rm(outPath, { force: true }).catch(() => {});
    return shot;
  }
  const line = shot.stdout.trim().split("\n").pop() ?? "";
  let longEdge = FRAME_LONG_EDGE;
  // ★★**이 값을 계산해놓고 버리고 있었다** (2026-09-18, 회사돌쇠 3차 P0). 같은 `w`·`h` 로
  //  `longEdge` 만 내고 `deliveredPx` 는 안 냈다 — 그래서 Windows 에선 프레임이 한 번도
  //  등록되지 않았고, **`frameId` 가 영영 발급되지 않아 조작 도구 다섯이 호출조차 불가능**
  //  했다. 관측은 내내 성공을 반환했다. 한 줄이 빠진 자리가 기능 전체를 닫고 있었다.
  let deliveredPx: { w: number; h: number } | null = null;
  try {
    const m = JSON.parse(line) as { w?: number; h?: number };
    if (typeof m.w === "number" && typeof m.h === "number") {
      longEdge = Math.max(m.w, m.h);
      deliveredPx = { w: m.w, h: m.h };
    }
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
      deliveredPx,
      path: outPath,
      info: line === "" ? undefined : line,
    };
  } catch {
    return { ok: false, reason: "failed", detail: "산출물 없음" };
  }
};

// ─── 2단계: 조작 (2026-09-17, 설계 §15) ──────────────────────────────────────

/**
 * **Windows 실행부의 조작** — `SendInput`(user32) P/Invoke. 관측과 **같은 경로**다
 * (`powershell` + `Add-Type`), 그래서 의존성은 그대로 0이다.
 *
 * ★★**mac 과 갈리는 자리 셋** — 여기가 «공통 계약 + 얇은 실행부» 가 값을 하는 지점이다.
 *  판단(무엇을 쏠지)은 `control.ts` 한 곳에 있고, 아래는 **그것을 OS 말로 옮기기만** 한다.
 *
 *  1. **한글은 직접 주입한다.** `KEYEVENTF_UNICODE` 는 P/Invoke 가 진짜 마셜링을 하므로
 *     맥에서 막혔던 벽(JXA 가 `UniChar*` 를 못 넘긴다)이 여기엔 없다 —
 *     **클립보드를 안 쓴다**(사용자 클립보드를 건드리지 않는 게 더 낫다).
 *  2. **좌표는 절대 좌표를 0..65535 로 정규화**해서 준다(`VIRTUALDESK`). 가상 데스크톱
 *     전체가 좌표계라 **다중 모니터가 자연히 된다** — 맥에서 §6-C 로 접었던 제약이 없다.
 *  3. **`cmd` 는 Ctrl 로 옮긴다**(아래 `VK` 주석 참조).
 */
const CONTROL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  // DPI — 좌표가 **물리 픽셀**이어야 한다. 관측과 같은 이유로 자식이 스스로 선언한다.
  "try{",
  "Add-Type -Namespace TC -Name Dpi2 -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);',
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  "'@",
  "}catch{}",
  "try{[TC.Dpi2]::SetProcessDpiAwarenessContext([IntPtr](-4))}catch{}",
  "try{[TC.Dpi2]::SetProcessDPIAware()}catch{}",
  // ★`SendInput` 구조체 — 64비트 PowerShell 기준(`FieldOffset(8)`).
  // ★★`-UsingNamespace System.Runtime.InteropServices` 를 **쓰지 않는다** (2026-09-17 실기).
  //  `Add-Type -MemberDefinition` 은 생성 C# 에 그 `using` 을 **이미 넣는다** — 또 주면
  //  **중복 선언으로 컴파일이 깨진다.** 그리고 그 실패가 `idleSeconds()===null` → `user-active`
  //  로 흘러, «사람이 쓰는 중» 처럼 보였다(첫 클릭 전에 차단).
  "Add-Type -Namespace TC -Name In -MemberDefinition @'",
  "[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
  "[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
  "[StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }",
  '[DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
  // ★**글자 → 진짜 키코드.** 이게 없으면 글자 키를 유니코드로밖에 못 넣는데, 유니코드
  //  주입은 **수식키를 안 탄다**(아래 `KeyName` 주석 — `ctrl+a` 가 «a» 로 들어갔다).
  '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern short VkKeyScan(char ch);',
  "'@",
  "$SZ=[Runtime.InteropServices.Marshal]::SizeOf([type][TC.In+INPUT])",
  // ★★**빈 연습(dry run)** — `SendInput` 만 건너뛰고 **나머지는 전부 진짜로 돈다**
  //  (2026-09-17 2차 실기). 좌표 정규화·형 변환·키 이름 해석·유니코드 분해가 다 실행되고
  //  **화면에는 아무 일도 안 일어난다.** 이번 음수 스크롤 실행 오류(`[uint32](-240)` 가
  //  던진 것)가 정확히 이 구간에서 났는데, 순수부 회귀 91건은 그걸 볼 수가 없었다.
  //  ★`SendInput` 을 부르는 자리는 **여기 하나뿐**이고 가드가 첫 줄이다 — 그래서 이 스위치가
  //   켜진 동안 입력이 새는 경로가 없다(회귀가 사용자 화면을 건드리면 안 된다).
  "$DRY = ($env:TIGUCLAW_DRY -eq '1')",
  "function Send($i){ if($DRY){ return }; [void][TC.In]::SendInput(1, @($i), $SZ) }",
  // 가상 데스크톱 — 절대 좌표 정규화의 분모다(음수 원점 모니터도 여기서 흡수된다).
  "$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen",
  "function Abs($x,$y){",
  "  $nx = [int][Math]::Round((($x - $vs.X) * 65535.0) / [Math]::Max(1, $vs.Width - 1))",
  "  $ny = [int][Math]::Round((($y - $vs.Y) * 65535.0) / [Math]::Max(1, $vs.Height - 1))",
  "  return @($nx, $ny)",
  "}",
  "$MOVE=0x0001; $ABS=0x8000; $VDESK=0x4000; $WHEEL=0x0800; $HWHEEL=0x1000",
  "$BTN=@{ left=@{d=0x0002; u=0x0004}; right=@{d=0x0008; u=0x0010}; middle=@{d=0x0020; u=0x0040} }",
  "function Mouse($x,$y,$flags,$data){",
  "  $a = Abs $x $y",
  "  $i = New-Object TC.In+INPUT; $i.type = 0",
  "  $m = New-Object TC.In+MOUSEINPUT",
  // ★★`mouseData` 는 `uint` 인데 **휠 델타는 음수가 온다** — `[uint32](-240)` 은 «너무
  //  작다» 며 **던진다**(2026-09-17 실기: 음수 스크롤이 통째로 실행 오류였다). Win32 는
  //  이 자리를 **2의 보수 비트패턴**으로 읽으므로 하위 32비트만 떼어 넘긴다.
  "  $m.dx = $a[0]; $m.dy = $a[1]; $m.mouseData = [uint32]([int64]$data -band 4294967295)",
  "  $m.dwFlags = [uint32]($flags -bor $MOVE -bor $ABS -bor $VDESK)",
  "  $i.mi = $m; Send $i",
  "}",
  // ★★**휠 한 칸씩 나눠 쏜다** (2026-09-18, 회사돌쇠 3차 §5-2).
  //  실측: 음수는 -1200 까지 선형인데 **양수는 한 이벤트당 15줄에서 포화**했다
  //  (+360·+600·+1200 이 전부 15줄). 그런데 **같은 양을 여러 번 나눠 부르면 정확히
  //  누적된다** — 즉 «한 이벤트가 나르는 양» 에 상한이 있다는 뜻이다.
  //  ★그래서 한 번에 몰아 쏘던 것을 **실제 휠처럼 노치 단위로** 쪼갠다.
  //  ★이건 실측에 근거한 **가설적 수정**이다 — 포화의 진짜 주인이 앱인지 OS 인지는 우리가
  //   못 정한다. 판정은 재관측이다(그래서 결과 문구가 그렇게 말한다).
  "function Wheel($x,$y,$flags,$units){",
  "  $left = [int]$units",
  "  $guard = 0",
  "  while($left -ne 0 -and $guard -lt 200){",
  "    $step = if($left -gt 120){120} elseif($left -lt -120){-120} else {$left}",
  "    Mouse $x $y $flags $step",
  "    $left = $left - $step",
  "    $guard = $guard + 1",
  "  }",
  "}",
  // ★**`cmd` → Ctrl.** 모델이 `cmd+c` 라고 쓸 때 뜻하는 것은 «이 플랫폼의 주 수식키» 다.
  //  Windows 키로 옮기면 복사가 아니라 시작 메뉴가 열린다 — 이름을 그대로 두는 것이 오히려
  //  **의도를 배신**한다. 진짜 Windows 키가 필요하면 `win` 이라는 이름을 따로 받는다.
  //  ★이건 실행부의 **번역**이다(판단이 아니다) — 그래서 여기 산다.
  "$MODVK=@{ cmd=0x11; ctrl=0x11; alt=0x12; shift=0x10; win=0x5B }",
  "$VK=@{ enter=0x0D; 'return'=0x0D; tab=0x09; esc=0x1B; escape=0x1B; space=0x20; backspace=0x08;",
  "       'delete'=0x2E; up=0x26; down=0x28; left=0x25; right=0x27; home=0x24; end=0x23;",
  "       pageup=0x21; pagedown=0x22 }",
  "$KEYUP=0x0002; $UNI=0x0004; $EXT=0x0001",
  // ★★**탐색키는 «확장 키» 라고 밝혀야 한다** (2026-09-18, 회사돌쇠 3차 §5-1 가설).
  //  `wScan=0` 으로 VK 만 주면 Windows 가 스캔코드를 `MapVirtualKey` 로 유도하는데,
  //  방향키·Home·End·PageUp/Down 은 그 유도가 **숫자패드 쪽**을 가리킨다. NumLock 이 꺼져
  //  있으면 캐럿은 그래도 움직여서 «되는 것처럼» 보이지만, **Shift 가 눌린 순간 숫자패드는
  //  의미가 뒤집혀** 선택이 안 된다 — 실기에서 본 «캐럿만 이동, selLen 0» 이 정확히 그 모양이다.
  //  ★`click hold:["shift"]` 는 되고 `shift+left` 는 안 됐다는 감별이 여기를 가리켰다.
  "$EXTVK=@(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E)",
  "function KeyVk($vk,$down){",
  "  $i = New-Object TC.In+INPUT; $i.type = 1",
  "  $k = New-Object TC.In+KEYBDINPUT",
  "  $k.wVk = [uint16]$vk; $k.wScan = 0",
  "  $f = if($down){0}else{$KEYUP}",
  "  if($EXTVK -contains [int]$vk){ $f = $f -bor $EXT }",
  "  $k.dwFlags = [uint32]$f",
  "  $i.ki = $k; Send $i",
  "}",
  // ★**유니코드 직접 주입** — 코드 유닛마다 down/up. 서로게이트 쌍도 그대로 성립한다.
  "function Uni($text){",
  "  foreach($ch in $text.ToCharArray()){",
  "    foreach($isUp in @($false,$true)){",
  "      $i = New-Object TC.In+INPUT; $i.type = 1",
  "      $k = New-Object TC.In+KEYBDINPUT",
  "      $k.wVk = 0; $k.wScan = [uint16][char]$ch",
  "      $k.dwFlags = [uint32]$(if($isUp){$UNI -bor $KEYUP}else{$UNI})",
  "      $i.ki = $k; Send $i",
  "    }",
  "  }",
  "}",
  // ★지금 눌러둔 수식키 — 아래 «유니코드로 새지 않게» 판정에 쓴다.
  "$HELD=New-Object 'System.Collections.Generic.List[string]'",
  "function KeyName($name,$down){",
  "  $n = [string]$name",
  "  if($MODVK.ContainsKey($n)){",
  "    KeyVk $MODVK[$n] $down",
  "    if($down){ [void]$HELD.Add($n) } else { [void]$HELD.Remove($n) }",
  "    return",
  "  }",
  "  if($VK.ContainsKey($n.ToLower())){ KeyVk $VK[$n.ToLower()] $down; return }",
  "  if($n.Length -ne 1){ throw ('알 수 없는 키 이름: ' + $n) }",
  // ★★**글자 키는 «진짜 키»로 누른다** (2026-09-17 실기로 확정).
  //
  //  종전엔 표에 없는 한 글자를 **유니코드 주입**으로 보냈다. 그런데 `KEYEVENTF_UNICODE`
  //  는 자판 배치도 **수식키 상태도 타지 않는다** — 앱은 «글자 a 가 들어왔다» 만 받는다.
  //  그래서 `ctrl+a` 가 *Ctrl 은 눌린 채로 «a» 한 글자 삽입*이 됐고, **함수는 성공을
  //  반환했다.** 「보냈다 ≠ 됐다」가 가장 아프게 드러난 자리다.
  //
  //  ★`VkKeyScan` 이 **현재 자판 배치**에서 그 글자의 키코드와 shift 필요 여부를 준다 —
  //   표를 손으로 늘리는 길(배치마다 틀린다)을 안 간다.
  "  $sc = [int][TC.In]::VkKeyScan([char]$n)",
  "  if($sc -ne -1){",
  // 상위 바이트 bit0 = shift 가 필요하다는 뜻(대문자·기호). 이미 눌러뒀으면 또 안 누른다.
  "    $needShift = ((($sc -shr 8) -band 1) -eq 1) -and (-not $HELD.Contains('shift'))",
  "    if($needShift -and $down){ KeyVk $MODVK['shift'] $true }",
  "    KeyVk ($sc -band 0xFF) $down",
  "    if($needShift -and (-not $down)){ KeyVk $MODVK['shift'] $false }",
  "    return",
  "  }",
  // ★이 배치에 없는 글자(한글 등). 유니코드로 «넣을» 수는 있지만, **수식키를 눌러둔
  //  채로면 그건 «눌렀다» 가 아니라 «글자를 넣었다» 다** — 조용히 딴 일을 하느니 던진다.
  "  if($HELD.Count -gt 0){ throw ('이 자판 배치에서 «' + $n + '» 는 키로 누를 수 없습니다 — 수식키(' + ($HELD -join '+') + ')와 함께 쓸 수 없습니다. 글자를 넣는 것이 목적이면 type_text 를 쓰세요.') }",
  "  if(-not $down){ return }",
  "  Uni $n",
  "}",
  "$evs = ConvertFrom-Json $env:TIGUCLAW_EVENTS",
  "$last = $null",
  "foreach($e in $evs){",
  "  if($e.t -eq 'mousemove'){ Mouse $e.x $e.y 0 0; $last=@($e.x,$e.y) }",
  "  elseif($e.t -eq 'mousedown'){ Mouse $e.x $e.y $BTN[[string]$e.button].d 0; $last=@($e.x,$e.y) }",
  "  elseif($e.t -eq 'mouseup'){",
  // 좌표가 없으면 **마지막으로 간 자리**에서 뗀다(정리 경로 — 맥과 같은 계약).
  "    $ux = $(if($null -ne $e.x){$e.x}elseif($null -ne $last){$last[0]}else{[System.Windows.Forms.Cursor]::Position.X})",
  "    $uy = $(if($null -ne $e.y){$e.y}elseif($null -ne $last){$last[1]}else{[System.Windows.Forms.Cursor]::Position.Y})",
  "    Mouse $ux $uy $BTN[[string]$e.button].u 0",
  "  }",
  "  elseif($e.t -eq 'mousedrag'){ Mouse $e.x $e.y 0 0; $last=@($e.x,$e.y) }",
  // ★**부호는 공통 계약과 같다** — 양수 = 문서 앞쪽(위 내용). Windows 휠도 양수가 forward 다.
  //  ★크기는 **대략**이다: 한 노치(120)가 보통 3줄이라, «픽셀 느낌» 을 맞추려고 2를 곱한다.
  //   정확한 양은 앱마다 다르므로 **재관측이 정본**이다(그래서 결과 문구가 그렇게 말한다).
  "  elseif($e.t -eq 'scroll'){",
  "    if($e.dy -ne 0){ Wheel $e.x $e.y $WHEEL ([int]$e.dy * 2) }",
  "    if($e.dx -ne 0){ Wheel $e.x $e.y $HWHEEL ([int]$e.dx * 2) }",
  "  }",
  "  elseif($e.t -eq 'unicode'){ Uni $e.text }",
  "  elseif($e.t -eq 'keydown'){ KeyName $e.key $true }",
  "  elseif($e.t -eq 'keyup'){ KeyName $e.key $false }",
  "  Start-Sleep -Milliseconds 12",
  "}",
  // `ConvertFrom-Json` 은 원소가 하나면 **배열이 아니라 객체**를 준다 — `@()` 로 감싸 센다.
  "[Console]::Out.WriteLine('{\"sent\":' + @($evs).Count + '}')",
].join("\n");

/**
 * **조작 프리플라이트** — Windows 엔 mac 의 «손쉬운 사용» 같은 **동의 스위치가 없다.**
 * 그래서 여기서 보는 것은 권한이 아니라 **데스크톱 세션**이다(관측과 같은 판정).
 *
 * ★★**그래도 «권한 없음» 같은 실패가 하나 있다**: UIPI — 우리보다 **높은 권한으로 도는 창**
 *  (관리자 권한 앱·UAC 대화상자)에는 `SendInput` 이 **조용히 안 닿는다.** 미리 알 방법이
 *  없으므로(창마다 다르다) 여기서 막지 못한다 — **재관측이 유일한 판정**이고, 결과 문구가
 *  그렇게 말한다. 「보냈다 ≠ 됐다」가 여기서도 그대로다.
 */
export const controlPreflight = async (): Promise<
  { ok: true } | { ok: false; reason: "no-permission" | "timeout" | "failed"; detail: string }
> => {
  const probe = await preflight();
  if (!probe.ok || probe.screens === undefined || probe.screens.length === 0) {
    return {
      ok: false,
      reason: "no-permission",
      detail: "데스크톱 세션이 없습니다(서비스로 떠 있으면 화면·입력이 닿지 않습니다).",
    };
  }
  return { ok: true };
};

/**
 * **사람이 마지막으로 입력한 뒤 경과 초** — `GetLastInputInfo`.
 *
 * ★★**이 값은 우리 입력도 센다**(mac 과 같다 — 거기선 실측으로 확인했다). Windows 는 소스를
 *  가르는 수단조차 없다. 그래서 «자기 입력에 자기가 막히는» 것을 막는 일은 **여기가 아니라
 *  순수부**가 한다(`lastSelfInputMs`) — 설계가 이 위험을 Windows 쪽으로 적어뒀는데, 맥에서
 *  먼저 터졌고 처방이 **플랫폼 공통**이라 이미 서 있다.
 */
/** ★유휴 스크립트는 **한 벌**이다 — 자가 점검이 «제품이 쓰는 바로 그것» 을 돌려야 한다. */
const IDLE_SCRIPT = [
  // ★위와 같은 이유로 `-UsingNamespace` 없음(중복 `using` → 컴파일 실패).
  "Add-Type -Namespace TC -Name Idle -MemberDefinition @'",
  "[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
  '[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '[DllImport("kernel32.dll")] public static extern uint GetTickCount();',
  "'@",
  "$l = New-Object TC.Idle+LASTINPUTINFO",
  "$l.cbSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][TC.Idle+LASTINPUTINFO])",
  "[void][TC.Idle]::GetLastInputInfo([ref]$l)",
  "[Console]::Out.WriteLine('{\"s\":' + ([math]::Round((([TC.Idle]::GetTickCount() - $l.dwTime) / 1000.0), 3)) + '}')",
].join("\n");

export const idleSeconds = async (): Promise<number | null> => {
  const r = await runScript(IDLE_SCRIPT, {});
  if (!r.ok) return null;
  try {
    const v = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as { s?: number };
    return typeof v.s === "number" && Number.isFinite(v.s) ? v.s : null;
  } catch {
    return null;
  }
};

/** 이벤트를 순서대로 쏜다 — 스크립트는 **고정 리터럴**, 값은 전부 `$env` (관측과 같은 규율). */
export const post = async (
  events: readonly LowEvent[],
): Promise<{ ok: true; sent: number } | { ok: false; reason: "timeout" | "failed"; detail: string }> => {
  if (events.length === 0) return { ok: true, sent: 0 };
  // ★`TIGUCLAW_DRY` 를 **명시적으로 끈다.** 자식은 `process.env` 를 물려받으므로, 어디선가
  //  그 이름이 켜져 있으면 **진짜 조작이 조용히 아무것도 안 하게** 된다 — 우리가 이 세션
  //  내내 쫓던 바로 그 모양이다. 켜는 쪽이 아니라 **끄는 쪽**을 못 박는다.
  const r = await runScript(CONTROL_SCRIPT, {
    TIGUCLAW_EVENTS: JSON.stringify(events),
    TIGUCLAW_DRY: "0",
  });
  if (!r.ok) return r;
  try {
    const v = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as { sent?: number };
    return { ok: true, sent: typeof v.sent === "number" ? v.sent : events.length };
  } catch {
    return { ok: false, reason: "failed", detail: `산출 판정 불가: ${r.stdout.slice(0, 80)}` };
  }
};

/**
 * **실행부 자가 점검** — 입력을 **하나도 내지 않고** 스크립트가 도는지만 본다
 * (2026-09-17, 회사돌쇠 제안).
 *
 * ★이번 결함(중복 `using` → C# 컴파일 실패)은 **순수부 회귀 91건이 전부 초록인데** 실행부가
 *  아예 안 돌던 것이다. 그 공백이 여기 있었다: 검사는 «무엇을 쏠지» 만 재고, «쏘는 쪽이
 *  컴파일이라도 되나» 는 아무도 안 봤다.
 * ★**제품이 만드는 바로 그 스크립트**를 돌려야 한다 — 검사용으로 다시 쓴 C# 은 이 부류를
 *  못 잡는다(그 사본은 중복 `using` 이 없을 테니까).
 * ★`TIGUCLAW_EVENTS` 를 **빈 배열**로 준다: 구조체·P/Invoke·함수 정의가 전부 컴파일되고
 *  루프는 0번 돈다 = **입력 0**.
 */
/**
 * 빈 연습이 통과시킬 **대표 이벤트** — 실행부가 «던지는» 부류를 전부 한 번씩 밟는다.
 * ★음수 휠이 여기 있는 이유: 그게 실기에서 실제로 던졌다(`[uint32]` 는 음수를 못 받는다).
 */
const DRY_EVENTS: readonly LowEvent[] = [
  { t: "mousemove", x: 0, y: 0 },
  { t: "mousedown", x: 0, y: 0, button: "left", count: 1 },
  { t: "mousedrag", x: 1, y: 1, button: "left" },
  { t: "mouseup", button: "left", count: 1 },
  { t: "scroll", x: 0, y: 0, dx: 0, dy: 120 },
  { t: "scroll", x: 0, y: 0, dx: -120, dy: -120 },
  { t: "keydown", key: "ctrl" },
  { t: "keydown", key: "a" },
  { t: "keyup", key: "a" },
  { t: "keyup", key: "ctrl" },
  { t: "keydown", key: "enter" },
  { t: "keyup", key: "enter" },
  { t: "unicode", text: "가A\n" },
];

export const selfCheck = async (): Promise<
  | { ok: true; idleSeconds: number | null; textSurvives: boolean }
  | { ok: false; where: "idle" | "input" | "dry"; detail: string }
> => {
  const idle = await runScript(IDLE_SCRIPT, {});
  if (!idle.ok) return { ok: false, where: "idle", detail: idle.detail };
  const input = await runScript(CONTROL_SCRIPT, { TIGUCLAW_EVENTS: "[]", TIGUCLAW_DRY: "0" });
  if (!input.ok) return { ok: false, where: "input", detail: input.detail };
  // ★**이벤트를 실제로 통과시켜 본다 — 입력은 0이다**(`TIGUCLAW_DRY`).
  //  빈 배열은 «컴파일이 되나» 까지만 본다. 루프 안에서 던지는 부류(음수 휠의 `[uint32]`,
  //  모르는 키 이름, 좌표 정규화)는 **이벤트가 흘러야** 드러난다.
  const dry = await runScript(CONTROL_SCRIPT, {
    TIGUCLAW_DRY: "1",
    TIGUCLAW_EVENTS: JSON.stringify(DRY_EVENTS),
  });
  if (!dry.ok) return { ok: false, where: "dry", detail: dry.detail };
  // ★**오류 문구의 한글이 살아서 오는가** (2026-09-18, 회사돌쇠 3차 P1).
  //  일부러 실패시켜 되돌아온 글자를 본다 — 인코딩이 어긋나면 여기서 U+FFFD 가 된다.
  //  ★이것도 **입력 0**이다: 던지는 자리가 `Send` 앞이고, 빈 연습이라 애초에 안 쏜다.
  //  ★**한글 전용이 아니다.** 어긋나는 것은 «코드 페이지 ↔ UTF-8» 이지 한국어가 아니다
  //   (일본어 CP932·중국어 CP936·서유럽 CP1252 전부 같은 모양이다). 그래서 검사도 우리
  //   문구를 찾지 않고, **우리가 보낸 글자가 그대로 돌아오는지**를 본다 — 한글·라틴 악센트·
  //   한자·이모지(서로게이트 쌍)를 한 번에 태운다.
  const echo = "키é漢🙂";
  const probe = await runScript(CONTROL_SCRIPT, {
    TIGUCLAW_DRY: "1",
    TIGUCLAW_EVENTS: JSON.stringify([{ t: "keydown", key: echo }]),
  });
  const textSurvives = !probe.ok && probe.detail.includes(echo);
  return { ok: true, idleSeconds: await idleSeconds(), textSurvives };
};
