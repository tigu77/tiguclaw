/**
 * 회귀: **브리지가 «턴이 얼마나 걸려도 되는가» 를 판정하지 않는다** (2026-09-16)
 *
 * 잡는 것: `/messages` 의 인입 시한이 브리지 첫 커밋(2026-05-15)부터 `60_000` 으로 박혀
 * 있었고, 그때 턴은 짧았다. 그 뒤 **분포를 대고 다시 본 적이 없다.**
 *
 * ★실측(개발돌쇠 `llm.turn_done` 119건, 2026-08-07~09-15): **60초 초과 69.7%** ·
 *  평균 턴 **349초**. 즉 이 시계는 건강한 턴의 셋 중 둘에서 발화했다. 게다가 발화해도
 *  **일을 멈추지 못한다** — `Promise.race` 는 기다리기만 그만두고 핸들러는 계속 돌아
 *  턴을 끝낸다. 소켓 하나를 닫을 뿐인데 대가로 **동기 계약이 깨졌다**(60초를 넘는
 *  호출자는 `{replyText}` 를 영영 못 받는다).
 *
 * ★매니저가 2026-08-22 에 같은 결정을 이미 했다(`WORKER_TIMEOUT_MS` 기본 무한):
 *  *"상한에 걸린 작업은 멈춘 게 아니라 돌고 있었는데 잘린 것"*. 시계의 역할은 죽이기가
 *  아니라 확인이고, 확인은 턴 쪽(취소·`/stop`·잡 점검)이 갖고 있다.
 *
 * ★**그래서 이 검사는 «60초가 아니다» 를 세지 않는다** — 그건 다음 사람이 숫자를 90초로
 *  바꾸면 통과하는 검사다. 지키려는 성질은 **«기본값에 턴 길이 판정이 없다»** 이다.
 *
 * ★두 번째 축이 더 미묘하다: «상한 없음» 을 **큰 수로 표현하면 정반대가 된다.**
 *  `setTimeout(fn, Infinity)` 는 Node 가 «Timeout duration was set to 1» 로 경고하고
 *  **즉시 발화**한다(실측 3ms). 그래서 무한일 때는 시계를 **아예 안 만들어야** 한다.
 *
 * 등급: **동작 검사** — 진짜 `handleMessages` 를 격리 서버에 태우고, 시한보다 오래 걸리는
 * 핸들러로 실제 요청을 보낸다. LLM·외부 네트워크 0.
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  assert,
  loadPluginModule,
  type Assertion,
  type RegressionCheck,
} from "./_framework.js";

// ★**정적 import 로 `plugins/` 를 짚지 않는다** — `npm run build` 는 `rootDir="src"` 라
//  TS6059 로 죽고, 그 실패한 빌드는 **소스 옆에 `.js`·`.d.ts` 를 뱉는다**(gitignore 라
//  `git status` 에 안 보이고, source 모드가 옛 컴파일본을 돌게 된다). `loadPluginModule`
//  은 지정자를 **계산**해 tsc 프로그램 밖에 둔다. 이 함정은 `sync-public` §5 가 적어둔
//  것인데, 첫 판에서 그대로 밟았고 `npm run build` 가 잡았다.
type ChatRoutes = { handleMessages: (ctx: unknown) => Promise<void> };
type RouteCtxMod = { HANDLER_TIMEOUT_MS: number };

/** 시한보다 오래 걸리는 핸들러를 태우고 실제로 POST 한다. */
const drive = async (
  handleMessages: ChatRoutes["handleMessages"],
  handlerMs: number,
): Promise<{ status: number; elapsedMs: number; finished: boolean; body: unknown }> => {
  let finished = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMessages({
      req,
      res,
      url,
      pathname: url.pathname,
      channelName: "http-bridge",
      bus: null,
      sseClients: new Set<http.ServerResponse>(),
      channelHandler: async () => {
        await new Promise((r) => setTimeout(r, handlerMs));
        finished = true;
        return undefined as never;
      },
    } as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "회귀용", threadKey: "regression:turn-length" }),
    });
    const body: unknown = await r.json().catch(() => ({}));
    return { status: r.status, elapsedMs: Date.now() - t0, finished, body };
  } finally {
    server.close();
  }
};

export const check: RegressionCheck = {
  name: "bridge-does-not-cap-turn-length",
  guards:
    "브리지의 60초 시한이 건강한 턴의 69.7% 에서 발화해 504 를 냈고, 그걸 화면이 «서버가 안 받았다» 로 읽어 보낸 글을 입력창으로 되돌린 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { handleMessages } = await loadPluginModule<ChatRoutes>(
      "../../../plugins/http-bridge/routes-chat.ts",
    );
    const { HANDLER_TIMEOUT_MS } = await loadPluginModule<RouteCtxMod>(
      "../../../plugins/http-bridge/route-ctx.ts",
    );

    out.push(
      assert(
        "★기본값에 **턴 길이 판정이 없다** — 유한한 수를 기본으로 두지 않는다",
        // ★«60초가 아니다» 를 세지 않는다 — 90초로 바꾸면 통과하는 검사가 된다.
        !Number.isFinite(HANDLER_TIMEOUT_MS),
        `기본 시한 = ${String(HANDLER_TIMEOUT_MS)}`,
      ),
    );

    // ★env 손잡이는 **실제로 돌려서** 잰다 — 이 모듈은 import 시점에 값을 정하므로
    //  같은 프로세스에서 바꿔 볼 수가 없다. 자식 프로세스에 env 를 주고 값을 읽는다.
    //  (소스 정규식으로 «env 를 참조한다» 만 보면, 파싱이 틀려도 초록이다.)
    const readWithEnv = (value: string): string => {
      const url = new URL(
        "../../../plugins/http-bridge/route-ctx.ts",
        import.meta.url,
      ).href;
      return execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `import("${url}").then((m) => console.log(String(m.HANDLER_TIMEOUT_MS)));`,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HTTP_BRIDGE_HANDLER_TIMEOUT_MS: value },
          timeout: 60_000,
        },
      ).trim();
    };
    out.push(
      assert(
        "★env 로 유한값을 **복원할 수 있다** — 상한이 필요한 배치가 막히지 않는다",
        readWithEnv("90000") === "90000",
        `HTTP_BRIDGE_HANDLER_TIMEOUT_MS=90000 → ${readWithEnv("90000")}`,
      ),
      assert(
        "★`off`·`0` 도 **무한**으로 읽는다 — 매니저 손잡이와 같은 어휘다",
        readWithEnv("off") === "Infinity" && readWithEnv("0") === "Infinity",
        `off → ${readWithEnv("off")} · 0 → ${readWithEnv("0")}`,
      ),
      assert(
        "★쓰레기 값은 **기본으로 떨어진다**(0.5 를 500ms 로 읽어 모든 턴을 자르지 않는다)",
        readWithEnv("0.5") === "Infinity" && readWithEnv("나중에") === "Infinity",
        `0.5 → ${readWithEnv("0.5")} · 문자 → ${readWithEnv("나중에")}`,
      ),
    );

    const ctxSrc = await readFile(
      new URL("../../../plugins/http-bridge/route-ctx.ts", import.meta.url),
      "utf8",
    );
    out.push(
      assert(
        "★손잡이가 **소스에 실재한다**(문서만의 약속이 아니다)",
        /process\.env\.HTTP_BRIDGE_HANDLER_TIMEOUT_MS/.test(ctxSrc) &&
          /Number\.POSITIVE_INFINITY/.test(ctxSrc),
        `env 참조 ${/process\.env\.HTTP_BRIDGE_HANDLER_TIMEOUT_MS/.test(ctxSrc)} · 무한 기본 ${/Number\.POSITIVE_INFINITY/.test(ctxSrc)}`,
      ),
    );

    // ── 동작: 오래 걸리는 턴이 **잘리지 않는다** ────────────────────────────────
    // 3초 핸들러. 옛 동작(60초 유한 시한)에서도 이건 안 잘리므로, 이 검사만으로는
    // 부족하다 — 그래서 위 «기본값에 유한값이 없다» 와 **짝**으로 본다.
    const slow = await drive(handleMessages, 3_000);
    out.push(
      assert(
        "오래 걸리는 턴이 **끝까지 기다려져 200 으로 돌아온다**(504 로 안 잘린다)",
        slow.status === 200 && slow.finished === true,
        `HTTP ${slow.status} · ${slow.elapsedMs}ms · 핸들러 완료=${slow.finished} · body=${JSON.stringify(slow.body)}`,
      ),
      assert(
        "★«상한 없음» 이 **즉시 발화로 뒤집히지 않는다** — setTimeout(fn, Infinity) 는 1ms 다",
        // 무한을 큰 수로 표현하면 Node 가 1ms 로 깎아 **정반대**가 된다. 3초 핸들러가
        // 3초 가까이 걸렸다면 시계가 안 걸린 것이다.
        slow.elapsedMs >= 2_500,
        `경과 ${slow.elapsedMs}ms (핸들러 3,000ms)`,
      ),
    );

    const chatSrc = await readFile(
      new URL("../../../plugins/http-bridge/routes-chat.ts", import.meta.url),
      "utf8",
    );
    out.push(
      assert(
        "★무한일 때 **시계를 만들지 않는다**(큰 수로 표현하지 않는다)",
        /Number\.isFinite\(HANDLER_TIMEOUT_MS\)/.test(chatSrc) &&
          // 시계 생성이 그 판정 **안에** 있다.
          /if \(bounded\)/.test(chatSrc),
        `유한 판정 ${/Number\.isFinite\(HANDLER_TIMEOUT_MS\)/.test(chatSrc)} · 조건부 생성 ${/if \(bounded\)/.test(chatSrc)}`,
      ),
    );

    return out;
  },
};
