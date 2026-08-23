/**
 * `ephemeral-wiring` 회귀의 자식 프로브 — **진짜 데몬을 띄워** 슬래시 명령을 흘리고
 * 두 축을 동시에 본다: ①`chat_log` 에 남는가(적재) ②SSE 로 흘러오는가(라이브 표시).
 *
 * 왜 이렇게까지 하나: 휘발성 배선(`publishInboundEcho` 인자·`replyCommand` 발행·
 * `/sessions` 블록의 `const ephemeral`)은 전부 `src/index.ts` 의 클로저 안이라 import 로
 * 못 뽑는다. 그래서 스위트가 **한 번도 실행하지 않았고**, 1라운드 결함을 그대로 복원해도
 * 1,608건이 초록이었다(2026-08-23 3라운드 ③-1). 4점짜리 자리에 그물이 0이었다.
 *
 * ★두 축을 **둘 다** 봐야 한다. 이 기능은 하루에 양방향으로 틀렸다 —
 *   적재를 막으려고 발행을 껐더니(1R) 대시보드 버블이 "대기 중" 으로 굳었고,
 *   발행만 보면 적재가 새는 것을 못 본다. 한 축만 보는 검사는 반대편을 놓친다.
 *
 * ★슬래시 명령은 LLM 을 안 탄다 — 부팅 한 번이면 실측이 된다(모델·네트워크 무관).
 *  입력은 **CLI 채널**(stdin readline)로 넣는다. 텔레그램 토큰 없이·격리 홈·격리 포트라
 *  라이브 데몬과 겹치지 않는다.
 */
import { spawn } from "node:child_process";
import {
  bootVerdict,
  freePort,
  reapOnExit,
  seedIsolatedEnv,
} from "./_probe-helpers.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  const home = process.env.PROBE_HOME ?? "";
  // ★포트를 커널에서 받는다 — 하드코딩(39711)이 오늘 실제로 물렸다. 다른 워크트리의
  //  프로브가 같은 포트를 잡고 있으니 `booted=true` 인 채 SSE 만 비어서, 게이트가
  //  "명령 버블이 영구히 굳는다" 며 **멀쩡한 제품을 지목**했다. 게이트가 환경 때문에
  //  빨간불이면 다음엔 아무도 안 본다. [[feedback_gate_must_actually_run]]
  const port = String(await freePort());
  const dashPort = String(await freePort());
  const token = "eph-wire-probe";
  seedIsolatedEnv(home, {
    TELEGRAM_BOT_TOKEN: "", // 라이브 폴링 409 방지(feedback_builtboot_env_409_hazard).
    HTTP_BRIDGE_PORT: port,
    HTTP_BRIDGE_TOKEN: token,
    DASHBOARD_PORT: dashPort,
  });
  const child = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "src/index.ts")], {
    cwd: REPO,
    detached: true, // 대시보드 등 손자까지 한 번에 거둘 수 있게 프로세스 그룹으로.
    env: {
      ...process.env,
      TIGUCLAW_HOME: home,
      TELEGRAM_BOT_TOKEN: "",
      // ★HOST 를 고정한다 — 부팅 판정이 `http://127.0.0.1:<port>` 문자열에 의존하는데
      //  이 키만 안 고정돼 있어서, 바깥에 `HTTP_BRIDGE_HOST=localhost` 가 있으면
      //  브리지는 멀쩡히 떴는데 게이트가 **제품을 지목**했다(실측).
      HTTP_BRIDGE_HOST: "127.0.0.1",
      HTTP_BRIDGE_PORT: port,
      HTTP_BRIDGE_TOKEN: token,
      DASHBOARD_PORT: dashPort,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  reapOnExit(child.pid);
  let childGone = false;
  child.on("exit", () => {
    childGone = true;
  });
  let out = "";
  const grab = (d: Buffer): void => {
    out += d.toString();
  };
  child.stdout.on("data", grab);
  child.stderr.on("data", grab);

  const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await sleep(150);
    }
    return cond();
  };

  // 자식이 죽으면 즉시 포기한다 — 안 그러면 부팅 실패마다 60초를 통째로 기다린다(실측 61.8초).
  await until(
    () =>
      childGone ||
      /EADDRINUSE/.test(out) ||
      out.includes(`http-bridge listening on http://127.0.0.1:${port}`),
    60_000,
  );
  const verdict = bootVerdict(out, port);
  const booted = verdict.ok;

  // ── SSE 관측 — 대시보드가 보는 것과 **같은 스트림** ─────────────────────────────
  const seen: Array<{ type: string; text: string; ephemeral: boolean }> = [];
  let sseErr = "";
  const ac = new AbortController();
  if (booted) {
    void (async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/events?token=${token}`, {
          signal: ac.signal,
        });
        // ★상태코드를 본다 — 401 이면 본문을 읽어도 프레임이 0이라 "이벤트 없음" 이
        //  되고, 그건 제품 결함으로 보고됐다(실측). throw 만 잡는 건 반쪽이다.
        if (!r.ok) {
          sseErr = `SSE HTTP ${r.status}`;
          return;
        }
        const reader = r.body?.getReader();
        if (reader === undefined) return;
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const p of parts) {
            const line = p.split("\n").find((l) => l.startsWith("data:"));
            if (line === undefined) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim()) as {
                type?: string;
                payload?: { text?: string; ephemeral?: boolean };
              };
              if (typeof ev.type !== "string") continue;
              if (!ev.type.startsWith("channel.message")) continue;
              seen.push({
                type: ev.type,
                text: String(ev.payload?.text ?? "").slice(0, 80),
                ephemeral: ev.payload?.ephemeral === true,
              });
            } catch {
              /* 조각난 프레임 무시 */
            }
          }
        }
      } catch (e) {
        // ★삼키지 않는다 — 종전엔 여기서 조용히 끝나 "이벤트 0" 이 곧 제품 결함으로
        //  보고됐다(실제 원인은 구독 자체가 실패한 것).
        if (!ac.signal.aborted) {
          sseErr = e instanceof Error ? e.message : String(e);
        }
      }
    })();
    await sleep(700); // 구독이 붙을 틈.

    // ① 휘발성 — 새 세션 생성. 적재 0 이어야 하고, **발행은 있어야** 한다.
    child.stdin.write("/sessions new 휘발성회귀\n");
    await until(() => out.includes("휘발성회귀"), 20_000);
    // ② 휘발성 아님 — 목록. 명령이 남아야 한다(휘발이 전부로 새지 않는지).
    child.stdin.write("/sessions\n");
    await until(() => out.includes("어느 세션에 묶을까요"), 20_000);
    // ★대문자 축(`/SESSIONS use x`)은 **여기서 안 본다** (2026-08-23 4라운드).
    //  그 입력은 슬래시 명령이 아니라 **LLM 턴을 실제로 돌린다** — 어댑터 SDK 는 env 밖
    //  (`~/.claude`)의 자격을 쓰므로 env 봉인으로도 못 막았고, 스위트가 돌 때마다 진짜
    //  모델 호출이 나갔다(그리고 모델이 프로브 문자열을 되뇌어 ①을 오탐시켰다).
    //  판정은 순수 함수라 `room-notice-is-ephemeral` 의 케이스 표가 0.2초에 지킨다 —
    //  **비싼 게이트에 싼 판정을 얹지 않는다.**
    // ④ ★휘발이 **아닌** `/sessions` 응답도 본다 (2026-08-23 4라운드). 종전엔 인바운드만
    //    확인해서, `const ephemeral` 을 `true` 로 바꿔 **12개 응답이 통째로 사라져도**
    //    스위트가 초록이었다. 인자 있는 archive 는 상태 변경이라 명령·답이 **둘 다** 남아야
    //    한다(없는 세션이면 "그런 세션이 없습니다" 가 그 답이다).
    child.stdin.write("/sessions archive dashboard:no-such-session-xyz\n");
    await until(() => out.includes("no-such-session-xyz"), 20_000);
    await sleep(800);
  }
  ac.abort();
  child.stdin.end();
  try {
    process.kill(-child.pid!, "SIGTERM"); // 그룹 전체(데몬 + 대시보드 손자).
  } catch {
    child.kill("SIGTERM");
  }
  await sleep(1500);
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }

  // DB 는 **자식이 죽은 뒤** 연다(같은 파일을 두 프로세스가 쓰지 않게).
  process.env.TIGUCLAW_HOME = home;
  const { initStore } = await import("../../store/sessions.js");
  initStore();
  const { getRecentChatLog } = await import("../../store/chat-log.js");
  const rows = getRecentChatLog({ limit: 200 }) as Array<{
    role: string;
    text: string;
  }>;
  console.log(
    JSON.stringify({
      booted,
      why: verdict.why,
      sseErr,
      rows: rows.map((r) => `${r.role}:${r.text.slice(0, 60)}`),
      sse: seen,
      tail: out.slice(-300),
    }),
  );
  process.exit(0);
};

void main();
