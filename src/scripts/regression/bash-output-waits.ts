/**
 * 회귀: **백그라운드 셸은 서버가 대신 기다린다** — `BashOutput(wait_seconds · until · idle_seconds)` (2026-10-01).
 *
 * 정태님: *"매니저가 특정 도구를 쓰는데 얼마나 걸릴지 모르고, 너무 오래 걸리거나 거의 멈춘 상황을 어떻게 타개하나."*
 * 없던 것: `BashOutput` 은 늘 즉시 돌아와 매니저가 «아직 실행 중» 을 받으려고 모델 요청을 반복했다
 *  (dev 09-28~10-01 실측: 백그라운드 셸 28개 · 폴링 64회 · 그중 36회가 «아직 실행 중»). 멈춤 신호도 없었다.
 * 적대 검토(같은 날)가 첫 판에서 넷을 냈고 여기서 같이 지킨다: F1 모델 정규식이 데몬 이벤트 루프를 세움 → 글자 그대로 ·
 *  F2 1MB 버퍼 상한 뒤 «멈춤» 오판 → 실제 받은 양으로 · F3 취소된 기다림이 출력을 허공에 소비 → 소비 안 함 ·
 *  F4 기다리는 동안 새 지시를 못 들음 → 깨움.
 *
 * 등급: **실행**. 실제 백그라운드 셸(node 자식)을 띄우고 실제 도구 핸들러로 기다려 시간을 잰다. 판정 순서는 순수 함수로 따로 본다.
 * 명령은 셸 문법을 피해 node 를 직접 부른다(맥·리눅스 sh, 윈도우 cmd 공통) — 문자열 안 따옴표는 홑따옴표만.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type Handler = (a: unknown, x: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
type Tools = Record<string, { handler?: Handler }>;

export const check: RegressionCheck = {
  name: "bash-output-waits",
  guards:
    "백그라운드 셸을 기다리려면 매니저가 모델 요청으로 반복 폴링해야 했고(«아직 실행 중» 36/64) 멈춤 신호가 없던 것 + 그걸 고친 첫 판의 결함 넷(정규식 폭주·1MB 상한 오판·취소 시 출력 소실·지시 못 들음)",
  run: async (): Promise<Assertion[]> => {
    const { createFileOpsMcpServer, shellWaitVerdict, killAllBgShells } = await import(
      "../../core/llm-runtime/capabilities/file-ops-mcp.js"
    );
    const { getEventBus } = await import("../../core/eventbus.js");
    const out: Assertion[] = [];
    const ac = new AbortController();
    const toolsOf = (tk: string, signal?: AbortSignal): Tools =>
      (createFileOpsMcpServer(process.cwd(), tk, signal !== undefined ? { abortSignal: signal } : {}) as unknown as { instance?: { _registeredTools?: Tools } }).instance?._registeredTools ?? {};
    const tools = toolsOf("regr:bash-wait", ac.signal);
    const call = async (name: string, args: Record<string, unknown>, extra: unknown = {}, t: Tools = tools): Promise<string> =>
      ((await t[name]!.handler!(args, extra)).content ?? []).map((c) => c.text ?? "").join("\n");
    const node = (js: string) => `"${process.execPath}" -e "${js}"`;
    const launch = async (js: string, t: Tools = tools): Promise<string> => {
      const r = await call("Bash", { command: node(js), run_in_background: true }, {}, t);
      return /bash_id: ([\w-]+)/.exec(r)?.[1] ?? "";
    };
    const timed = async (args: Record<string, unknown>, extra: unknown = {}, t: Tools = tools) => {
      const t0 = Date.now();
      const text = await call("BashOutput", args, extra, t);
      return { text, ms: Date.now() - t0 };
    };
    const KEEP = "setTimeout(()=>{},30000)";

    try {
      // ① 끝남 — 0.6초 뒤 끝나는 셸을 10초 기다리면 끝나자마자.
      const a = await launch("setTimeout(()=>console.log('done-a'),600)");
      const ra = await timed({ bash_id: a, wait_seconds: 10 });
      out.push(assert("끝나면 바로 깨운다 · 끝 출력이 실린다", /깨운 이유: 끝남/.test(ra.text) && ra.text.includes("done-a") && ra.ms < 3000, { ms: ra.ms }));

      // ② 조건 — 글자 그대로(정규식 아님): 괄호가 든 글자도 문자 그대로 찾는다 · 여러 개면 그중 하나.
      const b = await launch(`setTimeout(()=>console.log('Build (ok) done'),500);${KEEP}`);
      const rb = await timed({ bash_id: b, wait_seconds: 10, until: ["Build failed", "Build (ok)"] });
      out.push(assert("★until 은 글자 그대로 찾는다(괄호도 문자) · 셸이 살아 있어도 깨운다", /깨운 이유: 새 출력에 'Build \(ok\)'/.test(rb.text) && rb.ms < 3000, { ms: rb.ms, head: rb.text.slice(0, 80) }));

      // ②-2 찾는 글자가 두 조각에 걸쳐 와도 찾는다('BUILD ' 와 'DONE' 이 0.3초 간격).
      const sp = await launch(`process.stdout.write('BUILD ');setTimeout(()=>process.stdout.write('DONE'),300);${KEEP}`);
      const rsp = await timed({ bash_id: sp, wait_seconds: 5, until: "BUILD DONE" });
      out.push(assert("찾는 글자가 두 조각에 걸쳐 와도 찾는다", /깨운 이유: 새 출력에 'BUILD DONE'/.test(rsp.text) && rsp.ms < 2000, { ms: rsp.ms }));

      // ②-3 기다리기 전에 와 있던 꼬리('BUILD ')와 그 뒤 조각('DONE')에 걸친 글자도 찾는다(2R N2).
      const tl = await launch(`process.stdout.write('BUILD ');setTimeout(()=>process.stdout.write('DONE'),900);${KEEP}`);
      await new Promise((r) => setTimeout(r, 500));
      const rtl = await timed({ bash_id: tl, wait_seconds: 5, until: "BUILD DONE" });
      out.push(assert("기다리기 전 꼬리와 새 조각에 걸친 글자도 찾는다", /깨운 이유: 새 출력에 'BUILD DONE'/.test(rtl.text) && rtl.ms < 2000, { ms: rtl.ms }));
      // ②-3b 꼬리가 정확히 «찾는 글자 길이 − 1» 이고 앞에 다른 글자가 붙어 있어도 — 꼬리 길이·위치가 맞아야 찾는다(3R G1).
      const tl2 = await launch(`process.stdout.write('zzzzABCDEFGHI');setTimeout(()=>process.stdout.write('J'),900);${KEEP}`);
      await new Promise((r) => setTimeout(r, 500));
      const rtl2 = await timed({ bash_id: tl2, wait_seconds: 5, until: "ABCDEFGHIJ" });
      out.push(assert("꼬리 길이가 찾는 글자 − 1 일 때도 걸친 글자를 찾는다", /깨운 이유: 새 출력에 'ABCDEFGHIJ'/.test(rtl2.text) && rtl2.ms < 2000, { ms: rtl2.ms }));
      // ②-4 stderr 에 나온 글자도 찾는다.
      const se = await launch(`setTimeout(()=>console.error('FATAL ERROR'),300);${KEEP}`);
      const rse = await timed({ bash_id: se, wait_seconds: 5, until: "FATAL ERROR" });
      out.push(assert("stderr 에 나온 글자도 찾는다", /깨운 이유: 새 출력에 'FATAL ERROR'/.test(rse.text) && rse.ms < 2000, { ms: rse.ms }));

      // ③ 출력 없음 — 한 줄 찍고 조용: idle 1초면 ~1초에 깨우고 이미 읽은 마지막 출력도 다시 붙인다. 끊지 않는다.
      const c = await launch(`console.log('waiting for input? (y/N)');${KEEP}`);
      await new Promise((r) => setTimeout(r, 600)); // 출력이 먼저 와 있게
      const pre = await timed({ bash_id: c, wait_seconds: 3, until: "y/N" });
      out.push(assert("기다리기 전에 이미 와 있던(안 읽은) 출력에서도 찾는다", /깨운 이유: 새 출력에 'y\/N'/.test(pre.text) && pre.ms < 500, { ms: pre.ms }));
      const rc = await timed({ bash_id: c, wait_seconds: 10, idle_seconds: 1 });
      const cRunning = /status: running/.test(await call("BashOutput", { bash_id: c }));
      out.push(assert("★N초째 새 출력이 없으면 깨우고 마지막 출력(이미 읽은 것)을 붙인다 · 끊지 않는다", /깨운 이유: 1초째 새 출력 없음/.test(rc.text) && rc.text.includes("(y/N)") && rc.ms >= 900 && rc.ms < 3000 && cRunning, { ms: rc.ms, cRunning }));

      // ③-2 진전이 있으면 멈춤이 아니다 — stdout 으로 0.3초마다 찍다 끝나는 셸(2.4초).
      const g = await launch("let i=0;const t=setInterval(()=>{console.log('tick'+(i++));if(i>=8)clearInterval(t)},300)");
      const rg = await timed({ bash_id: g, wait_seconds: 10, idle_seconds: 1 });
      out.push(assert("★출력이 계속 늘면 «출력 없음» 으로 깨우지 않는다(stdout)", /깨운 이유: 끝남/.test(rg.text) && rg.ms >= 2000, { ms: rg.ms }));
      // ③-3 stderr 로만 찍어도 진전이다.
      const ge = await launch("let i=0;const t=setInterval(()=>{console.error('e'+(i++));if(i>=8)clearInterval(t)},300)");
      const rge = await timed({ bash_id: ge, wait_seconds: 10, idle_seconds: 1 });
      out.push(assert("stderr 로만 나오는 출력도 진전으로 센다", /깨운 이유: 끝남/.test(rge.text) && rge.ms >= 2000, { ms: rge.ms }));
      // ③-4 한동안 찍다 조용해지면 그 뒤부터 다시 잰다 — 진전 뒤 침묵도 잡는다.
      const h = await launch(`let i=0;const t=setInterval(()=>{console.log('h'+(i++));if(i>=4)clearInterval(t)},250);${KEEP}`);
      const rh = await timed({ bash_id: h, wait_seconds: 10, idle_seconds: 1 });
      out.push(assert("진전이 멈춘 뒤 N초가 지나면 깨운다(진전 시계가 계속 갱신된다)", /깨운 이유: 1초째 새 출력 없음/.test(rh.text) && rh.ms >= 1700 && rh.ms < 4000, { ms: rh.ms }));

      // F2 — 1MB 버퍼 상한 뒤에도 출력이 이어지면 멈춤이 아니고, 상한 뒤에 온 글자도 찾는다.
      const big = await launch("process.stdout.write('x'.repeat(1100000));let i=0;const t=setInterval(()=>{process.stdout.write('tick ');if(++i===6){console.log('BUILD DONE')}},200)");
      const rbig = await timed({ bash_id: big, wait_seconds: 10, idle_seconds: 1, until: "BUILD DONE" });
      out.push(assert("★버퍼 상한(1MB) 뒤에도: 출력이 이어지면 «멈춤» 아님 · 상한 뒤에 온 글자도 찾는다", /깨운 이유: 새 출력에 'BUILD DONE'/.test(rbig.text) && rbig.ms < 4000, { ms: rbig.ms, head: rbig.text.slice(0, 80) }));

      // F1 — 줄바꿈 없는 큰 출력 위에서 기다려도 이벤트 루프를 세우지 않는다(정규식 대신 글자, 새 조각만 훑음).
      const flat = await launch(`process.stdout.write('a'.repeat(900000));${KEEP}`);
      await timed({ bash_id: flat, wait_seconds: 2, until: "zz-never" }); // 큰 조각이 들어오게
      let maxLag = 0;
      let last = Date.now();
      const iv = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 20); last = n; }, 20);
      const rflat = await timed({ bash_id: flat, wait_seconds: 2, until: ".*(succeeded|failed)" });
      clearInterval(iv);
      out.push(assert("★큰 출력 위에서 기다려도 이벤트 루프가 서지 않는다(최대 지연 200ms 미만)", /깨운 이유: 2초 대기 상한/.test(rflat.text) && maxLag < 200, { maxLag, ms: rflat.ms }));

      // ④ 상한.
      const d = await launch(KEEP);
      const rd = await timed({ bash_id: d, wait_seconds: 1 });
      out.push(assert("대기 상한에 닿으면 «아직 실행 중» 으로 돌아온다", /깨운 이유: 1초 대기 상한/.test(rd.text) && rd.ms >= 900 && rd.ms < 3000, { ms: rd.ms }));

      // ④-2 상한은 느림 경고 기준보다 짧다 · 기준이 5초 이하면 «기다리지 않음» 을 말한다(조용히 꺼지지 않는다).
      const savedWarn = process.env.TOOL_SLOW_WARN_MS;
      let rcap: { text: string; ms: number };
      let roff: { text: string; ms: number };
      try {
        process.env.TOOL_SLOW_WARN_MS = "7000";
        rcap = await timed({ bash_id: d, wait_seconds: 10 });
        process.env.TOOL_SLOW_WARN_MS = "4000";
        roff = await timed({ bash_id: d, wait_seconds: 10 });
      } finally {
        if (savedWarn === undefined) delete process.env.TOOL_SLOW_WARN_MS; else process.env.TOOL_SLOW_WARN_MS = savedWarn;
      }
      out.push(assert("★대기 상한은 느림 경고 기준(TOOL_SLOW_WARN_MS)보다 짧게 묶인다", /깨운 이유: 2초 대기 상한/.test(rcap.text) && rcap.ms >= 1800 && rcap.ms < 4000, { ms: rcap.ms }));
      out.push(assert("경고 기준이 5초 이하면 «기다리지 않음» 을 말한다", /깨운 이유: 기다리지 않음/.test(roff.text) && roff.ms < 500, roff.text.slice(0, 60)));

      // ⑤ 옵션 없음 — 종전대로 즉시 · until/idle 만 주고 wait 를 빠뜨리면 오류로 말한다.
      const re = await timed({ bash_id: d });
      out.push(assert("wait_seconds 가 없으면 종전대로 바로 돌아온다", re.ms < 500 && !/깨운 이유/.test(re.text), { ms: re.ms }));
      const lone = await tools["BashOutput"]!.handler!({ bash_id: d, until: "READY", idle_seconds: 5 }, {});
      out.push(assert("until·idle_seconds 만 주고 wait_seconds 를 빠뜨리면 조용히 넘기지 않고 오류로 말한다", lone.isError === true || /^Error: until·idle_seconds 는 wait_seconds/.test(lone.content?.[0]?.text ?? ""), lone.content?.[0]?.text?.slice(0, 60)));

      // ⑥ KillShell — 기다리는 중 끊기면 바로 «끝남».
      const k = await launch(KEEP);
      const pk = timed({ bash_id: k, wait_seconds: 10 });
      setTimeout(() => { void call("KillShell", { bash_id: k }); }, 300);
      const rk = await pk;
      out.push(assert("기다리는 중 셸이 끊기면 바로 깨운다", /깨운 이유: 끝남/.test(rk.text) && rk.ms < 2000, { ms: rk.ms }));

      // F4 — 기다리는 동안 이 대화에 새 메시지가 오면 깨운다 · 매니저면 그 잡에 온 지시(worker.steered)로도.
      const st = await launch(KEEP);
      const ps = timed({ bash_id: st, wait_seconds: 10 });
      setTimeout(() => getEventBus().publish({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: "regr:bash-wait", text: "그만 기다리고 X 해" } }), 300);
      const rs = await ps;
      const wTools = toolsOf("worker:regr-job");
      const ws = await launch(KEEP, wTools);
      const pw = timed({ bash_id: ws, wait_seconds: 10 }, {}, wTools);
      setTimeout(() => getEventBus().publish({ type: "worker.steered", ts: Date.now(), payload: { jobId: "regr-job", outcome: "delivered", message: "x" } }), 300);
      const rw = await pw;
      // 남의 대화·합성 알림은 깨우지 않는다.
      const oth = await launch(KEEP);
      const po = timed({ bash_id: oth, wait_seconds: 1 });
      setTimeout(() => {
        getEventBus().publish({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: "regr:other", text: "x" } });
        getEventBus().publish({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: "regr:bash-wait", synthetic: true } });
        getEventBus().publish({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: "regr:bash-wait", text: "/logs" } });
      }, 200);
      const ro = await po;
      out.push(assert("★기다리는 동안 이 대화에 새 지시가 오면 깨운다(메인 메시지 · 매니저 steer)", /깨운 이유: 이 대화에 새 지시/.test(rs.text) && rs.ms < 2000 && /깨운 이유: 이 대화에 새 지시/.test(rw.text) && rw.ms < 2000, { rs: rs.ms, rw: rw.ms }));
      const wo = await launch(KEEP, wTools);
      const pwo = timed({ bash_id: wo, wait_seconds: 1 }, {}, wTools);
      setTimeout(() => getEventBus().publish({ type: "worker.steered", ts: Date.now(), payload: { jobId: "regr-job", outcome: "other-session", message: "x" } }), 200);
      const rwo = await pwo;
      out.push(assert("남의 대화 메시지·합성 알림·슬래시 명령·전달 안 된 steer 로는 깨우지 않는다", /깨운 이유: 1초 대기 상한/.test(ro.text) && /깨운 이유: 1초 대기 상한/.test(rwo.text), { ro: ro.text.slice(0, 40), rwo: rwo.text.slice(0, 40) }));

      // F3 — 이 호출이 취소되면(MCP 요청 취소) 바로 놓고, 출력은 소비하지 않는다 — 다음 BashOutput 이 그대로 받는다.
      const f = await launch(`setTimeout(()=>console.log('FINAL RESULT'),400);${KEEP}`);
      const callAc = new AbortController();
      const pf = timed({ bash_id: f, wait_seconds: 10 }, { signal: callAc.signal });
      setTimeout(() => callAc.abort(), 900);
      const rf = await pf;
      const after = await call("BashOutput", { bash_id: f });
      out.push(assert("★호출이 취소되면 바로 놓고 출력을 소비하지 않는다(다음 호출이 FINAL RESULT 를 받는다)", /깨운 이유: 대기 중단/.test(rf.text) && rf.ms < 2000 && !rf.text.includes("FINAL RESULT") && after.includes("FINAL RESULT"), { ms: rf.ms }));

      // ★/stop 의 실제 순서 — «새 메시지» 에코를 먼저 내고 같은 흐름에서 곧바로 중단한다. 중단이 이겨야 하고 출력은 남아야 한다(2R N1).
      const ac2 = new AbortController();
      const t2 = toolsOf("regr:bash-wait-stop", ac2.signal);
      const f2 = await launch(`setTimeout(()=>console.log('FINAL TWO'),300);${KEEP}`, t2);
      const pf2 = timed({ bash_id: f2, wait_seconds: 10 }, {}, t2);
      setTimeout(() => {
        getEventBus().publish({ type: "channel.message.in", ts: Date.now(), payload: { channel: "http-bridge", threadKey: "regr:bash-wait-stop", text: "멈춰" } });
        ac2.abort();
      }, 800);
      const rf2 = await pf2;
      const after2 = await call("BashOutput", { bash_id: f2 }, {}, t2);
      out.push(assert("★/stop 순서(에코 → 중단)에서도 중단이 이기고 출력을 남긴다", /깨운 이유: 대기 중단/.test(rf2.text) && !rf2.text.includes("FINAL TWO") && after2.includes("FINAL TWO"), { head: rf2.text.slice(0, 60) }));

      // 이미 취소된 호출 + 조건이 이미 충족(안 읽은 READY) — 취소가 이기고 출력은 남는다(외부 검토 2026-10-02).
      const rdy = await launch(`console.log('READY');${KEEP}`);
      await new Promise((r) => setTimeout(r, 500));
      const preAc = new AbortController();
      preAc.abort();
      const rpre = await timed({ bash_id: rdy, wait_seconds: 2, until: "READY" }, { signal: preAc.signal });
      const afterPre = await call("BashOutput", { bash_id: rdy });
      out.push(assert("이미 취소된 호출은 조건이 충족돼 있어도 출력을 소비하지 않는다", /깨운 이유: 대기 중단/.test(rpre.text) && afterPre.includes("READY"), { head: rpre.text.slice(0, 50) }));

      // /stop(턴 신호)도 같다.
      const pstop = timed({ bash_id: d, wait_seconds: 30 });
      setTimeout(() => ac.abort(), 300);
      const rstop = await pstop;
      out.push(assert("기다리는 중 /stop(턴 취소)이면 바로 놓는다", /깨운 이유: 대기 중단/.test(rstop.text) && rstop.ms < 2000, { ms: rstop.ms }));
    } finally {
      await killAllBgShells();
    }

    // 배선(소스) — Claude 어댑터도 턴 중단 신호를 셸 도구에 넘긴다(codex·openai 와 같은 신호, 적대 검토 F3).
    const { readFileSync } = await import("node:fs");
    const claudeSrc = readFileSync(new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url), "utf8");
    // 주석 줄은 빼고 본다 — 주석 처리된 배선이 통과하면 안 된다(2R G: «검사 대상은 설명이 아니라 코드»).
    const claudeCode = claudeSrc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    out.push(assert("Claude 어댑터가 셸 도구에 턴 중단 신호를 넘긴다", /"file-ops": createFileOpsMcpServer\(input\.cwd, input\.threadKey, \{[\s\S]{0,200}?abortSignal: effectiveAc\.signal/.test(claudeCode), "file-ops 생성 블록"));

    // 판정 순서 — 끝남 → 조건 → 새 지시 → 출력 없음 → 상한, 아무것도 아니면 계속.
    const base = { matched: false, now: 10_000, waitStartedAt: 0, lastGrowthAt: 0, waitMs: 5_000, idleMs: 1_000 };
    const order = [
      shellWaitVerdict({ ...base, running: false, matched: true, steered: true }) === "exited",
      shellWaitVerdict({ ...base, running: true, matched: true, steered: true }) === "matched",
      shellWaitVerdict({ ...base, running: true, steered: true }) === "steered",
      shellWaitVerdict({ ...base, running: true }) === "idle",
      shellWaitVerdict({ running: true, matched: false, now: 10_000, waitStartedAt: 0, lastGrowthAt: 0, waitMs: 5_000 }) === "timeout",
      shellWaitVerdict({ ...base, running: true, now: 500 }) === undefined,
    ];
    out.push(assert("판정 순서: 끝남 → 조건 → 새 지시 → 출력 없음 → 상한, 아무것도 아니면 계속 기다림", order.every(Boolean), order));
    return out;
  },
};
