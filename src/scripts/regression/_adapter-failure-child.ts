/**
 * `adapter-failure-honesty` 의 **동작** 검사용 자식 — codex 어댑터·토큰 수명주기·facade 를 가짜 네트워크로 실제로 돌린다.
 *
 * ★왜 자식인가: `globalThis.fetch` 를 스텁하고 auth provider·인증 env 를 전역으로 바꾼다. 스위트 프로세스에서 하면
 *  뒤따르는 검사가 그 오염을 물려받는다(`_codex-cancel-child` 와 같은 이유). 시나리오 하나 = 프로세스 하나.
 *
 * 출력: 마지막 줄에 JSON 한 줄(시나리오마다 모양이 다르다 — 호출부가 읽는다).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";

const scenario = process.argv[2] ?? "";
const enc = new TextEncoder();
const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const streamResponse = (events: unknown[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(sse(events)));
        c.close();
      },
    }),
    { status: 200 },
  );
/** 서버가 도중에 끊는 응답 — 이벤트를 다 준 **다음 읽기**에서 undici 와 같은 모양으로 실패한다(error() 는 큐를 비우므로 pull 로 나눈다). */
const cutResponse = (events: unknown[]): Response => {
  let pulls = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        if (pulls === 1 && events.length > 0) {
          c.enqueue(enc.encode(sse(events)));
          return;
        }
        const cause = Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });
        c.error(new TypeError("terminated", { cause }));
      },
    }),
    { status: 200 },
  );
};
const completed = (id: string): unknown => ({
  type: "response.completed",
  response: { id, usage: { input_tokens: 10, output_tokens: 2 } },
});
const textDelta = (t: string): unknown => ({ type: "response.output_text.delta", delta: t });
const OVERLOAD = { code: "server_is_overloaded", message: "Our servers are currently overloaded." };
const overloadEvents = [{ type: "error", ...OVERLOAD }, { type: "response.failed", response: { error: OVERLOAD } }];
const fnCall = (name: string, args: unknown, cid: string): unknown[] => {
  const a = JSON.stringify(args);
  return [
    { type: "response.output_item.added", item: { type: "function_call", id: `fc_${cid}`, call_id: cid, name } },
    { type: "response.function_call_arguments.delta", delta: a },
    { type: "response.output_item.done", item: { type: "function_call", id: `fc_${cid}`, call_id: cid, name, arguments: a } },
  ];
};
/** 부작용 도구 — 실제로 격리 홈의 메모리에 쓴다(`isReadOnlyTool` 밖이라 부작용으로 분류된다). */
const sideEffectCall = (cid: string): unknown[] =>
  fnCall("add_memory", { name: `regr-${cid}`, kind: "note", summary: "회귀 검사용", body: "x" }, cid);

const print = (o: unknown): void => console.log(JSON.stringify(o));

/** 이 프로세스만의 하위 홈 — 설정(입력 상한)·인증 .env 를 쓴다. */
const subHome = (settings?: unknown): string => {
  assertIsolated();
  const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "afc-"));
  process.env.TIGUCLAW_HOME = home;
  if (settings !== undefined) writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings));
  return home;
};

const runCodex = async (
  respond: (n: number, init: RequestInit) => Response | Promise<Response>,
  extra: Record<string, unknown> = {},
): Promise<{ outcome: string; text: string; calls: number; bodies: string[]; items: unknown[] }> => {
  let calls = 0;
  const bodies: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (_u: string, init: RequestInit) => {
    calls += 1;
    bodies.push(String(init.body));
    return respond(calls, init);
  });
  const { initStore } = await import("../../store/sessions.js");
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  initStore();
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
  const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
  try {
    const out = await runOpenAiCodex({
      text: "회귀 검사 요청",
      threadKey: `regr:afc-${scenario}`,
      channel: "cli",
      model: "gpt-fake",
      ...extra,
    } as never);
    return { outcome: "returned", text: out.text, calls, bodies, items: (out as { turnItems?: unknown[] }).turnItems ?? [] };
  } catch (e) {
    return { outcome: "threw", text: e instanceof Error ? `${e.name}: ${e.message}` : String(e), calls, bodies, items: [] };
  }
};

const main = async (): Promise<void> => {
  switch (scenario) {
    // ── 토큰 수명주기 ───────────────────────────────────────────────────────────
    case "refresh-race":
    case "refresh-soon":
    case "refresh-fresh": {
      subHome();
      process.env.OPENAI_CODEX_OAUTH_TOKEN = "old-access";
      process.env.OPENAI_CODEX_OAUTH_REFRESH = "rt-1";
      process.env.OPENAI_CODEX_OAUTH_EXPIRES = String(
        scenario === "refresh-race" ? Date.now() - 1000 : scenario === "refresh-soon" ? Date.now() + 60_000 : Date.now() + 3_600_000,
      );
      const used = new Set<string>();
      let posts = 0;
      (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (_u: string, init: RequestInit) => {
        posts += 1;
        const rt = new URLSearchParams(String(init.body)).get("refresh_token") ?? "";
        await new Promise((r) => setTimeout(r, 30));
        // 회전형 갱신 토큰 — 한 번 쓰면 무효(재사용 감지). 실제 서버와 같은 성질.
        if (used.has(rt)) return new Response(JSON.stringify({ error: "refresh_token_reused" }), { status: 401 });
        used.add(rt);
        return new Response(JSON.stringify({ access_token: `new-access-${posts}`, refresh_token: `rt-${posts + 1}`, expires_in: 3600 }), { status: 200 });
      });
      const { ensureFreshAccessToken } = await import("../../core/llm-runtime/adapters/openai-codex-oauth-auth.js");
      const n = scenario === "refresh-race" ? 3 : 1;
      const rs = await Promise.allSettled(Array.from({ length: n }, () => ensureFreshAccessToken()));
      print({
        posts,
        results: rs.map((r) => (r.status === "fulfilled" ? r.value : `ERR ${String((r.reason as Error)?.message).slice(0, 80)}`)),
        envRefresh: process.env.OPENAI_CODEX_OAUTH_REFRESH,
      });
      return;
    }
    case "refresh-reused-elsewhere": {
      // 다른 프로세스(터미널 codex-auth)가 먼저 갱신해 홈 .env 를 바꿔 놓았다 — 우리 메모리의 rt-1 은 이미 무효.
      const home = subHome();
      const envPath = path.join(home, ".env");
      process.env.OPENAI_CODEX_OAUTH_TOKEN = "old-access";
      process.env.OPENAI_CODEX_OAUTH_REFRESH = "rt-1";
      process.env.OPENAI_CODEX_OAUTH_EXPIRES = String(Date.now() - 1000);
      writeFileSync(envPath, `OPENAI_CODEX_OAUTH_TOKEN=old-access\nOPENAI_CODEX_OAUTH_REFRESH=rt-1\nOPENAI_CODEX_OAUTH_EXPIRES=${process.env.OPENAI_CODEX_OAUTH_EXPIRES}\n`);
      const { startHomeCredentialWatch } = await import("../../core/credential-env.js");
      startHomeCredentialWatch(envPath);
      writeFileSync(envPath, `OPENAI_CODEX_OAUTH_TOKEN=other-access\nOPENAI_CODEX_OAUTH_REFRESH=rt-other\nOPENAI_CODEX_OAUTH_EXPIRES=${Date.now() + 3_600_000}\n`);
      let posts = 0;
      (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async () => {
        posts += 1;
        return new Response(JSON.stringify({ error: { code: "refresh_token_reused", message: "Your refresh token has already been used" } }), { status: 401 });
      });
      const { ensureFreshAccessToken } = await import("../../core/llm-runtime/adapters/openai-codex-oauth-auth.js");
      const r = await ensureFreshAccessToken().then((v) => v, (e: unknown) => `ERR ${String((e as Error)?.message).slice(0, 80)}`);
      print({ posts, result: r });
      return;
    }

    // ── codex 본 턴 ─────────────────────────────────────────────────────────────
    case "partial-fail-then-ok": {
      // 답을 쓰던 도중 과부하 → 같은 body 재전송에서 온전한 답.
      const r = await runCodex((n) =>
        n === 1
          ? streamResponse([textDelta("결론부터 말씀드리면, 첫째"), ...overloadEvents])
          : streamResponse([textDelta("온전한 답입니다."), completed(`r${n}`)]),
      );
      print({ outcome: r.outcome, text: r.text.slice(0, 200), calls: r.calls });
      return;
    }
    case "partial-fail-manager": {
      // 글을 화면에 흘리지 않는 턴(매니저) — 받은 글이 이 응답 안에만 있으니 다시 보내도 두 번 쓰이지 않는다 → 재전송.
      const r = await runCodex(
        (n) =>
          n === 1
            ? streamResponse([textDelta("결론부터 말씀드리면, 첫째"), ...overloadEvents])
            : streamResponse([textDelta("온전한 답입니다."), completed(`r${n}`)]),
        { workerDepth: 1 },
      );
      print({ outcome: r.outcome, text: r.text.slice(0, 200), calls: r.calls });
      return;
    }
    case "side-effect-then-partial-fail": {
      // 부작용 뒤 글을 쓰던 도중 과부하 — 재전송은 못 하지만(이미 흘렀다) 안내는 «잠시 후 다시» 다(«요청을 바꿔서» 가 아니다).
      const r = await runCodex((n) =>
        n === 1
          ? streamResponse([...sideEffectCall("c1"), completed("r1")])
          : streamResponse([textDelta("결론부터 말씀드리면, 첫째"), ...overloadEvents]),
      );
      print({ outcome: r.outcome, text: r.text.slice(-300), calls: r.calls });
      return;
    }
    case "cut-before-output": {
      // 서버가 첫 출력 전에 끊는다 → 같은 요청을 그대로 다시 보낸다.
      const r = await runCodex((n) => (n === 1 ? cutResponse([]) : streamResponse([textDelta("온전한 답입니다."), completed(`r${n}`)])));
      print({ outcome: r.outcome, text: r.text.slice(0, 200), calls: r.calls, sameBody: r.bodies[0] === r.bodies[1] });
      return;
    }
    case "cut-mid-text": {
      // 글을 쓰던 중 끊긴다 → 흘린 글을 붙이고 이어 쓰게 한다. 최종 답 = 앞 + 이어 쓴 것.
      const r = await runCodex((n) =>
        n === 1 ? cutResponse([textDelta("결론부터 말씀드리면, ")]) : streamResponse([textDelta("첫째는 A 입니다."), completed(`r${n}`)]),
      );
      const second = r.bodies[1] ?? "";
      print({
        outcome: r.outcome,
        text: r.text.slice(0, 200),
        calls: r.calls,
        carriesPartial: second.includes("결론부터 말씀드리면, ") && second.includes("잘린 바로 그 지점부터"),
      });
      return;
    }
    case "cut-mid-tool": {
      // 부작용 도구 호출이 담긴 응답이 끝나기 전에 끊긴다 — 그 호출은 실행하지 않고 다시 묻는다(두 번 실행 0).
      const r = await runCodex((n) =>
        n === 1
          ? cutResponse(sideEffectCall("c1"))
          : n === 2
            ? streamResponse([...sideEffectCall("c1"), completed("r2")])
            : streamResponse([textDelta("완료"), completed(`r${n}`)]),
      );
      print({
        outcome: r.outcome,
        text: r.text.slice(0, 200),
        calls: r.calls,
        secondHasNoOutput: !(r.bodies[1] ?? "").includes("function_call_output"),
        thirdOutputs: ((r.bodies[2] ?? "").match(/function_call_output/g) ?? []).length,
      });
      return;
    }
    case "cut-after-external-tool-delta": {
      // 게이트웨이 외부 도구 호출 조각이 이미 밖으로 흘렀다 — 다시 보내면 반쪽 호출 뒤에 새 호출이 이어진다 → 복구하지 않는다.
      const r = await runCodex(
        (n) => (n === 1 ? cutResponse(fnCall("app_fn", { a: 1 }, "e1")) : streamResponse([textDelta("안 와야 함"), completed(`r${n}`)])),
        { externalTools: [{ name: "app_fn", description: "회귀용 앱 함수", parameters: { type: "object", properties: {} } }] },
      );
      print({ outcome: r.outcome, calls: r.calls });
      return;
    }
    case "cut-twice": {
      // 두 번 연달아 글 쓰던 중 끊긴다 — 앞글이 둘 다 남고 한 번씩만 실린다.
      const r = await runCodex((n) =>
        n === 1 ? cutResponse([textDelta("ALPHA1 ")]) : n === 2 ? cutResponse([textDelta("BRAVO2 ")]) : streamResponse([textDelta("CHARLIE3"), completed(`r${n}`)]),
      );
      const third = r.bodies[2] ?? "";
      print({ outcome: r.outcome, text: r.text, calls: r.calls, gaInThird: third.split("ALPHA1").length - 1, naInThird: third.split("BRAVO2").length - 1 });
      return;
    }
    case "cut-then-tool": {
      // 끊김 뒤 이어 쓴 응답에 도구 호출이 있다 — 다음 요청 입력에 앞글이 한 번만(이어 쓴 글만 이력에 더한다).
      const r = await runCodex((n) =>
        n === 1
          ? cutResponse([textDelta("확인부터 ")])
          : n === 2
            ? streamResponse([textDelta("하겠습니다"), ...fnCall("Glob", { pattern: "*.nothing" }, "g1"), completed("r2")])
            : streamResponse([textDelta("끝"), completed(`r${n}`)]),
      );
      const third = r.bodies[2] ?? "";
      print({ outcome: r.outcome, calls: r.calls, partialInThird: third.split("확인부터 ").length - 1 });
      return;
    }
    case "cut-then-fetch-fail": {
      // 글 쓰던 중 끊긴 뒤 다음 요청이 **연결 단계**에서 계속 실패한다 — 앞 시도의 글을 «방금 잘린 글» 로 다시 붙이지 않는다.
      const r = await runCodex((n) =>
        n === 1
          ? cutResponse([textDelta("앞글 ")])
          : n <= 4
            ? Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }))
            : streamResponse([textDelta("뒷글"), completed(`r${n}`)]),
      );
      const last = r.bodies[r.bodies.length - 1] ?? "";
      print({ outcome: r.outcome, text: r.text.slice(0, 120), calls: r.calls, partialInLast: last.split("앞글 ").length - 1 });
      return;
    }
    case "cut-exhausted-after-side-effect": {
      // 부작용 뒤 끊김이 소진된다(매니저) — 안내는 흘린 글 전부를 싣고, 붙였던 부분 글은 이력 항목에 안 남는다(다음 턴 중복 X).
      const r = await runCodex(
        (n) => (n === 1 ? streamResponse([...sideEffectCall("c1"), completed("r1")]) : n === 2 ? cutResponse([textDelta("부분보고 ")]) : n === 3 ? cutResponse([textDelta("이어서 ")]) : cutResponse([textDelta("또")])),
        { workerDepth: 1 },
      );
      const itemsText = JSON.stringify(r.items);
      print({ outcome: r.outcome, text: r.text.slice(0, 200), calls: r.calls, partialItems: itemsText.split("부분보고").length - 1 });
      return;
    }
    case "overload-after-external-tool-delta": {
      // 게이트웨이 외부 도구 조각이 나간 뒤 과부하 — 재전송하지 않는다(반쪽 호출 뒤 새 호출 X).
      const r = await runCodex(
        (n) => (n === 1 ? streamResponse([...fnCall("app_fn", { a: 1 }, "e1").slice(0, 2), ...overloadEvents]) : streamResponse([textDelta("안 와야 함"), completed(`r${n}`)])),
        { externalTools: [{ name: "app_fn", description: "회귀용 앱 함수", parameters: { type: "object", properties: {} } }] },
      );
      print({ outcome: r.outcome, calls: r.calls });
      return;
    }
    case "cut-density": {
      // 이어 쓰기·재전송 뒤 토큰 밀도에 쓰이는 글자 수 = **실제로 보낸 마지막 본문** 길이(2026-10-10 아스트라 검토: 옛 본문 크기가 남았다).
      //  입력 토큰은 그 본문 길이의 절반으로 준다(밀도 허용 범위 안 — 범위 밖이면 기록이 안 돼 검사가 공짜 통과한다).
      const { getDb } = await import("../../store/sessions.js");
      const done = (n: number, body: string): Response =>
        streamResponse([textDelta("끝"), { type: "response.completed", response: { id: `r${n}`, usage: { input_tokens: Math.ceil(body.length / 2), output_tokens: 1 } } }]);
      const runs: Record<string, unknown> = {};
      const shapes: Array<[string, (n: number, init: RequestInit) => Response]> = [
        ["once", (n, init) => (n === 1 ? cutResponse([textDelta("DENSITY-PARTIAL ")]) : done(n, String(init.body)))],
        ["twice", (n, init) => (n === 1 ? cutResponse([textDelta("D1 ")]) : n === 2 ? cutResponse([textDelta("D2 ")]) : done(n, String(init.body)))],
        ["nopartial", (n, init) => (n === 1 ? cutResponse([]) : done(n, String(init.body)))],
      ];
      for (const [name, respond] of shapes) {
        const threadKey = `regr:afc-cut-density-${name}`;
        const r = await runCodex(respond, { threadKey });
        const row = getDb().prepare(`SELECT chars FROM thread_token_density WHERE thread_key = ?`).get(threadKey) as { chars: number } | undefined;
        const last = r.bodies[r.bodies.length - 1] ?? "";
        runs[name] = { outcome: r.outcome, calls: r.calls, recorded: row?.chars ?? null, lastBody: last.length, firstBody: (r.bodies[0] ?? "").length };
      }
      print(runs);
      return;
    }
    case "cut-exhausted": {
      // 계속 끊긴다 — 정해진 횟수만 복구를 시도하고 정직하게 실패한다(무한 재시도 0).
      const r = await runCodex(() => cutResponse([textDelta("가")]));
      print({ outcome: r.outcome, text: r.text.slice(0, 200), calls: r.calls });
      return;
    }
    case "partial-incomplete": {
      // 대조군 — 출력 상한(`response.incomplete`)은 받은 부분을 쓴다(요약 경로와 같은 규칙).
      const r = await runCodex(() =>
        streamResponse([textDelta("상한까지 쓴 부분 답"), { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }]),
      );
      print({ outcome: r.outcome, text: r.text.slice(0, 200), calls: r.calls });
      return;
    }
    case "spaced-overload": {
      // 요청마다 한 번씩만 과부하(다음 재전송은 성공) — 도구를 다섯 번 쓰고 여섯 번째에 답한다.
      const r = await runCodex((n) => {
        if (n % 2 === 1) return streamResponse(overloadEvents);
        const k = n / 2;
        if (k >= 6) return streamResponse([textDelta("완료"), completed(`r${n}`)]);
        return streamResponse([...fnCall("Glob", { pattern: `*.none${n}` }, `c${n}`), completed(`r${n}`)]);
      });
      print({ outcome: r.outcome, text: r.text.slice(0, 200), calls: r.calls });
      return;
    }
    case "steer-then-fail": {
      // 끼워넣기를 꺼낸 뒤 재시도 불가 실패(400) — 메시지가 채널에 돌아와야 한다.
      const { createSteeringChannel } = await import("../../core/steering.js");
      const steering = createSteeringChannel();
      steering.push({ text: "[끼워넣기] 파일명도 알려줘", raw: "파일명도 알려줘", ts: Date.now() });
      const r = await runCodex(() => new Response('{"error":{"message":"bad request"}}', { status: 400 }), { steering });
      print({
        outcome: r.outcome,
        sentInBody: r.bodies.some((b) => b.includes("파일명도")),
        leftover: steering.drain().map((s) => s.raw),
      });
      return;
    }
    case "input-cap": {
      // iteration 0 의 조립 입력이 상한을 넘으면 **보내지 않고** 던진다(빈 응답 20초 대신 즉시 다음 후보).
      subHome({ models: { limits: { "codex:gpt-fake": { maxInputChars: 200 } } } });
      const r = await runCodex(() => streamResponse([textDelta("보내졌다"), completed("r1")]));
      print({ outcome: r.outcome, text: r.text.slice(0, 200), calls: r.calls });
      return;
    }
    case "swallow-redacts": {
      // 부작용 뒤 일반 실패는 삼켜 부분 보고를 지키되(partial-report-survives-cut), 백엔드 원문의 비밀은 가린다.
      const r = await runCodex((n) =>
        n === 1
          ? streamResponse([...sideEffectCall("c1"), completed("r1")])
          // 가짜 비밀은 실행 중에 잇는다 — 소스에 시크릿 모양이 있으면 공개 싱크의 시크릿 스캔이 멈춘다(그 스캔은 진짜를 막는 게이트다).
          : new Response(JSON.stringify({ error: { message: "bad", echo: ["sk", "regrSecret1234567890abcdef"].join("-") } }), { status: 400 }),
      );
      print({ outcome: r.outcome, leaked: r.text.includes("sk-regrSecret"), redacted: r.text.includes("[REDACTED]"), calls: r.calls });
      return;
    }

    // ── facade 경유 — 도구 실행 뒤 계정 축 실패 ─────────────────────────────────
    case "facade-429":
    case "facade-401": {
      pinModelForTest("codex:gpt-fake");
      const events: string[] = [];
      const { getEventBus } = await import("../../core/eventbus.js");
      getEventBus().subscribe((ev: { type: string }) => {
        if (ev.type === "llm.turn_done" || ev.type === "llm.turn_error") events.push(ev.type);
      });
      let calls = 0;
      (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async () => {
        calls += 1;
        if (calls === 1) return streamResponse([...sideEffectCall("c1"), completed("r1")]);
        return scenario === "facade-429"
          ? new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 3600 } }), { status: 429 })
          : new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "bad token" } }), { status: 401 });
      });
      const { initStore } = await import("../../store/sessions.js");
      const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
      initStore();
      registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
      const rt = await import("../../core/llm-runtime/index.js");
      let outcome: string;
      let text: string;
      try {
        const out = await rt.runRegionA({ text: "메모 남기고 확인해줘", channel: "cli", threadKey: `regr:afc-${scenario}` } as never);
        outcome = "returned";
        text = out.text;
      } catch (e) {
        outcome = "threw";
        text = e instanceof Error ? e.message : String(e);
      }
      print({ outcome, text: text.slice(0, 300), calls, events, cooldowns: rt.listActiveCooldowns().map((c) => c.key) });
      return;
    }
    default:
      print({ outcome: "unknown-scenario", scenario });
  }
};

void main().then(
  () => process.exit(0),
  (e: unknown) => {
    print({ outcome: "harness-error", text: String(e instanceof Error ? e.stack : e).slice(0, 500) });
    process.exit(1);
  },
);
