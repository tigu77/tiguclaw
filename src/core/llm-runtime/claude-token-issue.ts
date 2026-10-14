/**
 * **Claude 구독 토큰을 화면에서 끝까지 발급한다** (2026-09-30 정태님 — «복사해서 터미널에서 하라는 건 아니지»).
 *
 * ★종전엔 발급 버튼이 «`npm run claude-auth` 를 그 기계 터미널에서 돌리고 나온 토큰을 붙여넣으라» 였다. 근거는
 *  09-05 실측(번들 `claude setup-token` 은 TTY 가 필요 — 비TTY 면 출력 0, `script -q` 는 부모에 TTY 가 없으면 실패).
 * ★그런데 Python 의 `pty.fork()` 는 **부모에 TTY 가 없어도** 가짜 터미널을 만든다(09-30 실측, 데몬과 같은 비TTY):
 *  발급기가 로그인 URL 을 찍고 `Paste code here if prompted >` 에서 코드를 기다린다. 그래서 이렇게 끝낸다:
 *    ①버튼 → 여기서 발급기를 가짜 터미널로 띄워 로그인 URL 을 뽑는다(화면이 새 탭으로 연다 — 폰에서도 된다)
 *    ②로그인하면 Anthropic 페이지에 코드가 뜬다 → 사용자가 붙여넣는다(이건 Anthropic 흐름이라 터미널에서도 같다)
 *    ③코드를 발급기에 넣고, 나온 토큰을 `acceptClaudeToken`(확인·저장·쉼 해제 — 재시작 없이 반영)으로 넘긴다.
 * ★발급은 **번들 실행기**가 한다 — OAuth 를 우리가 흉내 내지 않는다(상류 클라이언트 흉내 = 약관·깨짐 위험).
 * ★Windows 는 Python `pty` 가 없다(ConPTY 는 네이티브 의존) → `unavailable` 로 답하고 화면은 종전 방식(명령 + 붙여넣기).
 *  python3 가 없는 기계도 같다. 거짓으로 «버튼 한 번» 이라고 말하지 않는다.
 * ★발급기는 브라우저를 열지 않게 한다(`BROWSER=true` — 실측: 발급기가 이 변수를 따른다). 화면이 같은 URL 을 새 탭으로
 *  열므로, 안 막으면 데몬 기계에 탭이 하나 더 뜬다(원격이면 엉뚱한 기계에).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { findBundledClaude, bundledClaudeMissingHint } from "../claude-cli.js";
import { getPaths, sourceRoot } from "../paths.js";
import { acceptClaudeToken, claudeTokenCandidates, terminalText } from "./claude-token.js";
import { translate } from "../i18n.js";

/**
 * 가짜 터미널 중계 — 자식에게 넓은 창(1000열: URL·토큰이 줄바꿈으로 안 잘리게)을 주고, 표준입력 ↔ 터미널을 잇는다.
 * ★의존성 0 — 파이썬 표준 라이브러리만(pty·select·fcntl·termios).
 */
const PTY_RELAY = `
import os, pty, sys, select, fcntl, termios, struct, signal
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
signal.signal(signal.SIGTERM, lambda *a: (os.kill(pid, signal.SIGKILL), os._exit(143)))
inputs = [fd, 0]
while True:
    r, _, _ = select.select(inputs, [], [])
    if fd in r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if not d:
            # 입력이 닫혔다 = 부모(데몬)가 죽었다 — 정상 흐름엔 입력을 닫는 길이 없다(코드는 쓰기만 한다). 발급기를 같이 끝낸다:
            # 종전엔 입력만 빼고 pty 를 계속 기다려, 재시작·배포 때마다 발급기와 이 중계가 고아로 남았다(적대 검토 실측).
            os.kill(pid, signal.SIGKILL)
            os._exit(0)
        os.write(fd, d)
_, st = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1)
`;

/** 실패 진단용 꼬리 — 공백을 접고 마지막 240자, 16자 넘는 낱말(코드·토큰 조각)과 `sk-ant-` 는 길이만 남긴다. */
export const maskIssuerTail = (text: string): string =>
  text
    .replace(/sk-ant-\S*/g, (m) => `<토큰 ${m.length}자>`)
    .replace(/[A-Za-z0-9_\-#.]{16,}/g, (m) => `<${m.length}자>`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(-240) || "(없음)";

/** 터미널 제어 문자를 걷어 사람이 읽는 글자만 남긴다 — 판단은 `terminalText` 한 곳(커서 이동을 공백으로 바꾸는 것까지). */
const plain = terminalText;

const AUTHORIZE_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/;
/** 코드 입력 대기 — 화면이 커서 이동으로 그려 공백이 빠진다(실측 `Pastecodehereifprompted>`). */
const PASTE_PROMPT = /paste\s*code/i;
/** 발급기가 코드를 거절했다(실측 `OAuth error: Request failed with status code 400 · Press Enter to retry`). */
const ISSUE_ERROR = /OAuth\s*error[^\n]*/i;
/** 로그인 URL 을 기다리는 시한 — 실측 첫 출력까지 ~3초. */
const BEGIN_TIMEOUT_MS = 30_000;
/** 코드를 넣은 뒤 토큰이 나오기까지. */
const FINISH_TIMEOUT_MS = 60_000;
/** 코드를 넣고 엔터를 치기까지 — 붙여넣기 판정이 끝날 틈(실측 400ms 로 제출됨, 여유를 둔다). */
const PASTE_SETTLE_MS = 600;
/** 버튼을 누르고 코드를 안 넣은 채 둔 발급기는 치운다. */
const SESSION_TTL_MS = 15 * 60_000;

interface IssueSession {
  child: ChildProcess;
  out: string;
  exited: boolean;
  ttl: NodeJS.Timeout;
}
let session: IssueSession | null = null;

/**
 * 그 발급을 치운다 — ★**자기 것만.** 코드를 넣고 기다리는(최대 1분) 사이 버튼을 다시 누르면 새 발급기가 뜨는데,
 *  종전엔 늦게 끝난 앞 마무리가 «지금 발급» 을 닫아 **새 발급기를 죽였다**(적대 검토). 지금 발급이 그것일 때만 비운다.
 */
const closeSession = (s: IssueSession | null = session): void => {
  if (s === null) return;
  if (session === s) session = null;
  clearTimeout(s.ttl);
  if (!s.exited) s.child.kill("SIGTERM");
};

/** 출력이 조건을 채우거나 발급기가 끝나거나 시한이 올 때까지 기다린다. */
const waitFor = (s: IssueSession, done: (text: string) => boolean, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = (): void => {
      if (done(plain(s.out)) || s.exited || Date.now() > deadline) return resolve();
      setTimeout(tick, 200);
    };
    tick();
  });

export type ClaudeIssueBegin = { ok: true; url: string } | { ok: true; console: true } | { ok: false; reason: string };

/**
 * **윈도우 — 발급기를 새 콘솔 창으로 띄운다** (2026-10-10 정태님: «당연히 발급기를 새 콘솔창으로 띄워야지»).
 * ★발급기(`claude setup-token`)는 TTY 가 있어야 돈다. 맥·리눅스는 위 파이썬 가짜 터미널로 감싸 화면 안에서 끝내지만 윈도우 파이썬엔
 *  `pty` 가 없다 — 그래서 종전엔 «그 기계 터미널에서 명령을 치라» 고만 했다. 새 콘솔 창은 **진짜 터미널**이라 발급기가 그대로 돌고,
 *  스스로 브라우저를 연다. 로그인하면 그 창에 토큰이 나오고, 사용자는 그걸 화면에 붙여넣는다(저장·확인은 `finishClaudeTokenIssue`).
 * ★창은 `cmd /k` 로 남긴다 — 발급기가 끝나자마자 창이 닫히면 토큰을 복사할 틈이 없다.
 * ★우리 자격은 물려주지 않는다 — 이미 든 토큰을 본 발급기는 새로 발급하지 않고 엉뚱하게 굴 수 있다(한도 조회 CLI 와 같은 규칙).
 * ★데몬이 사용자 데스크톱 세션에서 돌 때만 창이 보인다(작업 스케줄러 로그온 실행 = 그렇다). 서비스(세션 0)면 안 보인다.
 */
/**
 * 새 창에서 돌릴 명령 — `node <소스 루트>/bin/tiguclaw.mjs claude-auth`. ★`appRoot()` 가 아니라 `sourceRoot()` 다: 설치 기본값(built)에선
 * appRoot 가 `dist` 라 그 아래엔 `bin/` 이 없다(2026-10-10 적대 검토 F1 — 새 창이 MODULE_NOT_FOUND 로 죽는데 화면은 «성공» 이었다).
 * `self-update.ts` 가 `bin/daemon.mjs` 를 찾는 것과 같은 기준이다.
 */
export const consoleIssuerCommand = (): { bin: string; args: string[] } => ({
  bin: process.execPath,
  args: [path.join(sourceRoot(), "bin", "tiguclaw.mjs"), "claude-auth"],
});

const launchConsoleIssuer = async (issuer?: readonly string[]): Promise<ClaudeIssueBegin> => {
  // ★창 안에서는 날것의 `claude setup-token` 이 아니라 **우리 `claude-auth`** 를 돌린다 (2026-10-10 정태님: «터미널 claude-auth 는
  //  마지막에 토큰도 자동으로 들어가던데»). 그게 발급기 출력에서 토큰을 집어 확인·저장까지 한다 — 붙여넣을 일이 없다.
  //  자동이 안 되면 그 창이 붙여넣기를 묻고, 화면의 붙여넣기 칸도 예비로 남는다. 홈은 이 데몬의 홈으로 못박는다.
  //  (claude-auth 는 홈 .env 를 스스로 다시 읽는다 — 아래 자격 env 제거는 «데몬 프로세스의 것을 창에 섞지 않는다» 까지다.)
  if (issuer === undefined && findBundledClaude() === null) return { ok: false, reason: bundledClaudeMissingHint() };
  const cmd = issuer === undefined ? consoleIssuerCommand() : { bin: issuer[0]!, args: issuer.slice(1) };
  if (!existsSync(cmd.bin) || (issuer === undefined && !existsSync(cmd.args[0]!))) {
    return { ok: false, reason: `발급 명령 파일이 없습니다: ${issuer === undefined ? cmd.args[0] : cmd.bin}` };
  }
  const env: NodeJS.ProcessEnv = { ...process.env, TIGUCLAW_HOME: getPaths().home };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // ★명령줄은 **바깥 cmd 가 해석하지 않게** 환경변수로 넘기고 새 창 cmd 의 지연 확장(`/v:on` · `!이름!`)으로 꺼낸다 (적대 검토 F7).
  //  지연 확장은 특수문자 해석이 끝난 뒤에 일어나서, 경로의 `&`·`^`·`%`(예 `C:\Users\R&D\…`)가 명령을 쪼개거나 글자를 삼키지 않는다.
  //  따옴표로 감싼 경로는 공백(`Program Files`·`Jane Doe`)을 지킨다.
  env.TIGUCLAW_ISSUER_CMDLINE = [cmd.bin, ...cmd.args].map((a) => `"${a.replace(/"/g, "")}"`).join(" ");
  const line = `start "Claude token (tiguclaw claude-auth)" cmd /v:on /k !TIGUCLAW_ISSUER_CMDLINE!`;
  return await new Promise<ClaudeIssueBegin>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", line], { env, stdio: "ignore", detached: true, windowsVerbatimArguments: true });
    } catch (e) {
      resolve({ ok: false, reason: `새 콘솔 창을 띄우지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    child.once("error", (e) => resolve({ ok: false, reason: `새 콘솔 창을 띄우지 못했습니다: ${e.message}` }));
    child.once("spawn", () => {
      child.unref();
      console.log("[auth] Claude 구독 토큰 발급기를 새 콘솔 창으로 띄웠습니다");
      resolve({ ok: true, console: true });
    });
  });
};

/**
 * 발급기를 띄우고 로그인 URL 을 돌려준다. 이미 떠 있던 발급은 치운다(버튼을 다시 눌렀다).
 * @param issuer 가짜 터미널 안에서 돌릴 실행 파일과 인자 — 기본은 번들 `claude setup-token`. 회귀가 가짜 발급기를 넣는다
 *  (회귀는 실제 실행기를 띄우지 않는다).
 */
export const beginClaudeTokenIssue = async (issuer?: readonly string[]): Promise<ClaudeIssueBegin> => {
  closeSession();
  if (process.platform === "win32") return launchConsoleIssuer(issuer);
  const bin = issuer === undefined ? findBundledClaude() : issuer[0]!;
  if (bin === null) return { ok: false, reason: bundledClaudeMissingHint() };
  const child = spawn("python3", ["-c", PTY_RELAY, bin, ...(issuer === undefined ? ["setup-token"] : issuer.slice(1))], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "true" },
  });
  const s: IssueSession = { child, out: "", exited: false, ttl: setTimeout(() => closeSession(s), SESSION_TTL_MS) };
  s.ttl.unref();
  session = s;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => { s.out += c; });
  child.stderr?.on("data", () => { /* 파이썬 오류는 아래 «URL 없음» 판정으로 드러난다 */ });
  let spawnError: string | undefined;
  child.on("error", (e) => { spawnError = e.message; s.exited = true; });
  child.on("close", () => { s.exited = true; });
  await waitFor(s, (t) => AUTHORIZE_URL.test(t) && PASTE_PROMPT.test(t), BEGIN_TIMEOUT_MS);
  const url = AUTHORIZE_URL.exec(plain(s.out))?.[0];
  if (url === undefined) {
    closeSession(s);
    const tail = plain(s.out).replace(/\s+/g, " ").trim().slice(-160);
    return {
      ok: false,
      reason: spawnError !== undefined
        ? `가짜 터미널(python3)을 띄우지 못했습니다: ${spawnError}`
        : `발급기가 로그인 주소를 내지 않았습니다${tail === "" ? "" : ` — ${tail}`}`,
    };
  }
  console.log("[auth] Claude 구독 토큰 발급기 시작 — 로그인 주소를 화면에 넘겼습니다");
  return { ok: true, url };
};

/**
 * 붙여넣은 것으로 마무리한다 — **판단은 여기 한 곳**: 토큰 모양이 보이면 토큰으로 저장(종전 붙여넣기 길),
 * 아니고 발급기가 떠 있으면 **로그인 코드**로 보고 발급기에 넣은 뒤 나온 토큰을 저장한다.
 */
export const finishClaudeTokenIssue = async (
  pasted: string,
  accept: typeof acceptClaudeToken = acceptClaudeToken,
): Promise<{ ok: boolean; message: string }> => {
  const s = session;
  const text = String(pasted ?? "");
  if (s === null || s.exited || claudeTokenCandidates(text).length > 0) {
    closeSession(s);
    return accept(text);
  }
  const code = text.trim();
  if (code === "") return { ok: false, message: translate("srv.claudeToken.pasteCode") };
  const before = s.out.length;
  // ★엔터는 **따로** 보낸다 (2026-10-14 테스트돌쇠 실측 · 재현). 발급기는 긴 입력이 한 덩어리로 오면 붙여넣기로 보고, 같이 온
  //  엔터를 제출이 아니라 내용으로 먹는다 — 실제 로그인 코드(~94자)는 별표로만 찍히고 60초 무반응이었다(짧은 27자는 제출됨).
  //  코드를 넣고 잠깐 뒤 엔터를 치면 제출된다. 사람이 붙여넣고 엔터를 누르는 것과 같은 순서다.
  s.child.stdin?.write(code);
  await waitFor(s, () => false, PASTE_SETTLE_MS);
  s.child.stdin?.write("\r");
  await waitFor(s, () => {
    const t = plain(s.out.slice(before));
    return claudeTokenCandidates(t).length > 0 || ISSUE_ERROR.test(t);
  }, FINISH_TIMEOUT_MS);
  // 조금 더 기다린다 — 토큰이 여러 조각으로 도착할 수 있다(끝까지 받아야 이어 붙일 게 없다).
  await waitFor(s, () => false, 1_500);
  const after = plain(s.out.slice(before));
  closeSession(s);
  if (claudeTokenCandidates(after).length === 0) {
    // 붙여넣은 코드는 문구에 싣지 않는다(발급기가 가려 찍지만 일부가 보인다) — 오류 줄만.
    const why = ISSUE_ERROR.exec(after)?.[0].replace(/\s*Press\s*Enter.*$/i, "").trim();
    // ★로그만으로 원인을 잡을 수 있게 — 코드를 넣은 뒤 발급기가 **무엇을** 냈는지 끝부분을 남긴다(2026-10-14 테스트돌쇠:
    //  오류도 토큰도 없이 «답하지 않았습니다» 만 남아 원인을 못 갈랐다). 긴 낱말(코드·토큰 조각)은 길이만 남기고 가린다.
    console.log(
      `[auth] Claude 토큰 발급 실패 진단 — 코드 뒤 출력 ${after.length}자 · 발급기 ${s.exited ? "끝남" : "아직 떠 있음"} · 끝부분: ` +
        maskIssuerTail(after),
    );
    return {
      ok: false,
      message: why === undefined ? translate("srv.claudeToken.issueSilent") : translate("srv.claudeToken.issueError", { why }),
    };
  }
  console.log("[auth] Claude 구독 토큰 발급기가 토큰을 냈습니다 — 확인·저장으로 넘깁니다");
  const r = await accept(after);
  if (!r.ok) {
    // ★확인에서 떨어지면 «무엇을 토큰으로 뽑았나» 를 남긴다 — 후보 길이와 토큰 주변 **원문 제어 구조**(토큰 글자는 길이만).
    //  2026-10-14: 발급된 토큰이 401 — 뒤 낱말이 붙었는지 원문 없이는 못 가렸다.
    const raw = s.out.slice(before);
    const at = raw.indexOf("sk-ant-");
    const around = at === -1 ? "" : raw.slice(Math.max(0, at - 40), at + 200);
    console.log(
      `[auth] Claude 토큰 확인 실패 진단 — 후보 ${claudeTokenCandidates(after).map((c) => c.length).join("·") || "0"}자 · ` +
        `토큰 주변 원문: ${JSON.stringify(around.replace(/sk-ant-[A-Za-z0-9._-]*/g, (m) => `<토큰 ${m.length}자>`).replace(/[A-Za-z0-9_-]{16,}/g, (m) => `<${m.length}자>`))}`,
    );
  }
  return r;
};
