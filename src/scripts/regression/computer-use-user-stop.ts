/**
 * 회귀: **컴퓨터 조작 제어 표시 · Esc 중단 · 제어 반환** (2026-11-24, 차기 릴리스 ⑤).
 *
 * 설계 정본: `docs/decisions/2026-11-24-computer-use-indicator-esc.md` §5. 표의 행 번호(#1…#13)를 단언 이름에 붙인다.
 *
 * ★**진짜 화면·키보드·마우스를 안 쓴다.** 플러그인 **인스턴스 하나**를 가짜 배선(기록하는 실행부 · 가짜 표시부)으로
 *  만들고, 제품 `startService` 와 제품 `getMcpServer(host)` 가 돌려준 서버의 도구 처리기를 부른다(`_registeredTools` —
 *  `_notice-report-adapters-child.ts` 와 같은 관용구). Esc·중지 단추는 가짜 표시부의 `onStop(via)` 를 검사가 쏜다.
 * ★맥 실행부·도우미는 **빈 연습**(`TIGUCLAW_DRY=1` — 입력·클립보드·창 0)으로만 돌린다. 맥이 아니면 `skip`.
 * ★실 OS 의 표시·포커스·클릭 통과·Esc 키 감지·캡처 제외는 이 검사가 말하지 않는다(설계 §6 미검증).
 */
import { promises as fs, existsSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { assert, assertIsolated, loadPluginModule, skip, type Assertion, type RegressionCheck } from "./_framework.js";

type Rec = Record<string, unknown>;
type Content = { content: Array<Rec>; isError?: boolean };
interface Handler {
  handler: (args: Rec, extra: Rec) => Promise<Content>;
}
interface PluginLike {
  startService(bus?: unknown, host?: Rec): Promise<void>;
  stop(): Promise<void>;
  getMcpServer(host?: Rec): { instance: { _registeredTools: Record<string, Handler> } } | undefined;
}
interface IndexModule {
  default: new (w?: Rec) => PluginLike;
}
interface ControlModule {
  newDesktop: () => Rec;
}
interface IndicatorModule {
  newIndicator: (backend: Rec, opts: { stopDir: string; idleMs?: number }) => Rec;
}
interface MacModule {
  POST_SCRIPT: string;
  INDICATOR_SCRIPT: string;
  GLOW_JS: string;
  post: (events: Rec[], signal?: AbortSignal, opts?: { stopFile?: string; dry?: boolean }) => Promise<Rec>;
  dryPost: (events: Rec[], opts?: { stopFile?: string }) => Promise<Rec>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(5);
  }
  return cond();
};
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const textOf = (r: Content): string =>
  r.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join("\n");
const count = (s: string, needle: string): number => s.split(needle).length - 1;
// ★«사용자가 눌렀다» 를 단정하지 않는 문구(2026-11-24 Windows 확대 §3-5) — 의미 판정은 #W9 한 곳.
const HEAD = "중지 요청이 감지되어 조작을 멈췄습니다 — 제어는";
const HEAD_UNDELIVERED = "멈춤을 전하지 못했습니다";
const isRelease = (events: Rec[]): boolean => events.every((e) => e["t"] === "keyup" || e["t"] === "mouseup");

interface PostRec {
  events: Rec[];
  signal?: AbortSignal;
  opts?: { stopFile?: string; dry?: boolean };
  release: boolean;
}

export const check: RegressionCheck = {
  name: "computer-use-user-stop",
  guards:
    "비서가 화면을 조작하는 동안 사용자가 그 자리에서 멈추고 제어를 돌려받을 수단이 없던 것(⑤) — 진행 중 입력이 Esc 뒤에도 " +
    "계속 나가는 것 · 끊긴 붙여넣기가 키·클립보드를 남기는 것 · Esc 전에 보낸 메시지가 잠금을 푸는 것 · 조기 반환·사후 관측 중 Esc 가 " +
    "보고에서 사라지는 것 · 표시가 실패해 조작까지 막히는 것 · 옛 표시 도우미의 늦은 콜백이 새 상태를 바꾸는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const idx = await loadPluginModule<IndexModule>("../../../plugins/computer-use/src/index.ts");
    const { newDesktop } = await loadPluginModule<ControlModule>("../../../plugins/computer-use/src/control.ts");
    const { newIndicator } = await loadPluginModule<IndicatorModule>("../../../plugins/computer-use/src/indicator.ts");
    const Plugin = idx.default;
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cu-userstop-"));
    const stopDirOk = await fs.mkdtemp(path.join(os.tmpdir(), "cu-userstop-stop-"));

    /** 한 판 — 플러그인 인스턴스 하나 · 가짜 표시부 · 기록하는 실행부. */
    const arena = async (o: {
      idleMs?: number;
      stopDir?: string;
      idle?: number;
      startThrows?: boolean;
      post?: (r: PostRec, n: number) => Promise<Rec>;
      capture?: (n: number) => Promise<void>;
      control?: Rec;
      /** 배선의 플랫폼 이름(기본 darwin) — 공통 결정층이 Windows 에서도 같은지(#W2). */
      platform?: string;
      /** 제품 조립이 만든 표시부를 그대로 쓴다(#W1) — 그때 `starts`·`esc()` 는 쓰지 않는다. */
      indicator?: Rec;
      /** 가짜 도우미의 준비 줄(⑤ r4) — 기본은 기동 직후 화면 밖 단추 자리. `"none"` = 단추 없이 준비 · `null` = 준비 줄을 안 냄. */
      readyPill?: { x: number; y: number; w: number; h: number } | "none" | null;
      /** 가짜 도우미가 `stop()` 뒤에도 끝나지 않는다(종료 확인 실패 경로). 검사가 `closeStart(i)` 로 나중에 끝낼 수 있다. */
      stuck?: boolean;
      /** 비킴 요청 전달 — 주어지면 도우미가 **전달이 끝나기 전에** 이 자리로 응답한다(빠른 응답 순서를 결정적으로). */
      answerInRequest?: { x: number; y: number; w: number; h: number };
      /** 비킴 요청 전달을 기록만 한다(응답 없음) — «요청이 실제로 전달된 뒤» 를 검사가 본다. */
      recordRequests?: boolean;
    } = {}) => {
      const desktop = newDesktop();
      const posts: PostRec[] = [];
      const lines: string[] = [];
      type PillR = { x: number; y: number; w: number; h: number };
      type StartRec = {
        label: string;
        moveFile: string;
        onStop: (via: "esc" | "button") => void;
        onGone: (why: string) => void;
        onReady?: (pill: PillR | null) => void;
        onPill?: (pill: PillR | null, req: string) => void;
        stopped: boolean;
      };
      const starts: StartRec[] = [];
      const closers: Array<() => void> = [];
      const requests: string[] = [];
      const backend = {
        ...(o.answerInRequest !== undefined || o.recordRequests === true
          ? {
              request: async (_f: string, req: string): Promise<void> => {
                requests.push(req);
                if (o.answerInRequest !== undefined) {
                  const cur = starts[starts.length - 1];
                  cur?.onPill?.(o.answerInRequest, req); // 전달 완료(이 Promise) **전에** 응답이 온다
                  await sleep(30);
                }
              },
            }
          : {}),
        start(s: Omit<StartRec, "stopped">) {
          if (o.startThrows === true) throw new Error("합성 기동 실패");
          const rec = { ...s, stopped: false };
          starts.push(rec);
          const rp = o.readyPill === undefined ? { x: 5000, y: 5000, w: 100, h: 20 } : o.readyPill;
          if (rp !== null) setImmediate(() => rec.onReady?.(rp === "none" ? null : rp));
          let closeIt: () => void = () => {};
          const closed = new Promise<void>((r) => { closeIt = r; });
          closers.push(() => closeIt());
          return { stop: () => { rec.stopped = true; if (o.stuck !== true) closeIt(); }, closed };
        },
      };
      const indicator = newIndicator(backend, { stopDir: o.stopDir ?? stopDirOk, idleMs: o.idleMs ?? 60_000 });
      let captures = 0;
      const observe = {
        preflight: () => Promise.resolve({ ok: true, screens: [{ x: 0, y: 0, w: 1920, h: 1080, scale: 1 }] }),
        capture: async (_t: Rec, outPath: string) => {
          captures += 1;
          if (o.capture !== undefined) await o.capture(captures);
          await fs.writeFile(outPath, "stub-frame");
          return { ok: true, bytes: 10, longEdge: 1600, path: outPath, deliveredPx: { w: 1600, h: 900 } };
        },
      };
      let n = 0;
      const control = o.control ?? {
        controlPreflight: () => Promise.resolve({ ok: true }),
        idleSeconds: () => Promise.resolve(o.idle ?? 99),
        frontWindow: () => Promise.resolve("stub-front"),
        post: (events: Rec[], signal?: AbortSignal, opts?: { stopFile?: string }) => {
          const r: PostRec = { events, release: isRelease(events), ...(signal ? { signal } : {}), ...(opts ? { opts } : {}) };
          posts.push(r);
          n += 1;
          return o.post !== undefined ? o.post(r, n) : Promise.resolve({ ok: true, fired: events.length, stdout: "" });
        },
      };
      const w = { platform: o.platform ?? "darwin", observe, control, desktop, indicator: o.indicator ?? indicator };
      const plugin = new Plugin(w);
      const handlers: Array<(e: Rec) => void> = [];
      const svcHost = {
        dataDir,
        locale: "ko",
        log: (m: string) => lines.push(String(m)),
        on: (type: string, h: (e: Rec) => void) => {
          const f = (e: Rec): void => { if (e["type"] === type) h(e); };
          handlers.push(f);
          return () => { const i = handlers.indexOf(f); if (i >= 0) handlers.splice(i, 1); };
        },
      };
      await plugin.startService(undefined, svcHost);
      const turnHost = (threadKey: string): Rec => ({
        dataDir,
        locale: "ko",
        log: (m: string) => lines.push(String(m)),
        turn: { threadKey, channel: "dashboard", target: null },
        on: () => () => {},
        turnSession: () => null,
      });
      const tools = (threadKey: string): { look: Handler; doTool: Handler } => {
        const srv = plugin.getMcpServer(turnHost(threadKey));
        const t = srv?.instance._registeredTools;
        if (t?.["look"] === undefined || t["do"] === undefined) throw new Error("도구를 못 찾았다");
        return { look: t["look"], doTool: t["do"] };
      };
      const extra = (): Rec => ({ signal: new AbortController().signal });
      const frame = async (look: Handler): Promise<string> => {
        const r = await look.handler({}, extra());
        const id = /화면 id[^0-9a-f]*([0-9a-f]{8})/.exec(textOf(r))?.[1];
        if (id === undefined) throw new Error(`화면 id 를 못 받았다: ${textOf(r).slice(0, 200)}`);
        return id;
      };
      const emit = (payload: Rec): void => {
        for (const h of [...handlers]) h({ type: "channel.message.in", ts: Date.now(), payload });
      };
      const esc = (): void => {
        const last = starts[starts.length - 1];
        if (last === undefined) throw new Error("표시가 안 떴다");
        last.onStop("esc");
      };
      /** 표시의 중지 단추(⑤ r4) — 결정은 Esc 와 같은 한 곳이다. */
      const button = (): void => {
        const last = starts[starts.length - 1];
        if (last === undefined) throw new Error("표시가 안 떴다");
        last.onStop("button");
      };
      /** 가짜 도우미 i 의 종료(`close`)를 지금 일으킨다 — `stuck` 일 때 지연 종료를 만든다. */
      const closeStart = (i: number): void => closers[i]?.();
      return { w, desktop, indicator, plugin, svcHost, posts, lines, starts, requests, tools, frame, emit, esc, button, closeStart, extra, captures: () => captures };
    };
    type Arena = Awaited<ReturnType<typeof arena>>;
    const mainPosts = (a: Arena): PostRec[] => a.posts.filter((p) => !p.release);
    const handback = (a: Arena): unknown => a.desktop["handback"];
    const callsLeft = (a: Arena): number => (a.desktop["calls"] as Set<unknown>).size;
    const CLICK = [{ t: "click", x: 10, y: 10 }];
    const SHIFT_CLICK = [{ t: "keydown", key: "shift" }, { t: "click", x: 10, y: 10 }, { t: "keyup", key: "shift" }];

    // ── #1 정상 · 같은 인스턴스의 두 턴 서버가 같은 표시부 ───────────────────────────
    {
      const a = await arena();
      const A = a.tools("t1");
      const r1 = await A.doTool.handler({ frameId: await a.frame(A.look), steps: CLICK }, a.extra());
      const B = a.tools("t1"); // 같은 대화의 다음 턴 — getMcpServer 를 새로 부른다
      const r2 = await B.doTool.handler({ frameId: await a.frame(B.look), steps: CLICK }, a.extra());
      out.push(assert(
        "#1 정상: 첫 `do` 가 표시를 띄우고(기동 1) 끝나도 유지 · 다음 턴 서버의 `do` 도 **같은 표시부**(재기동 0) · 입력 2회 · 머리 없음",
        a.starts.length === 1 && a.starts[0]!.stopped === false && mainPosts(a).length === 2 &&
          !textOf(r1).includes(HEAD) && !textOf(r2).includes(HEAD) && callsLeft(a) === 0,
        { starts: a.starts.length, stopped: a.starts[0]?.stopped, posts: mainPosts(a).length },
      ));
      // ★문구 **의미**는 #W9 한 곳이 판정한다 — 여기는 선택 로케일(ko)의 카탈로그 값이 표시부까지 그대로 가는지만.
      const koLabel = (JSON.parse(await fs.readFile(new URL("../../../locales/ko.json", import.meta.url), "utf8")) as Record<string, string>)["srv.computerUse.indicator"];
      out.push(assert(
        "#1 표시 문구는 카탈로그에서(설정 언어 ko) · 본 입력에만 멈춤 요청 파일 경로가 간다",
        typeof koLabel === "string" && koLabel !== "" && a.starts[0]?.label === koLabel &&
          mainPosts(a).every((p) => typeof p.opts?.stopFile === "string" && p.opts.stopFile.startsWith(stopDirOk)),
        { label: a.starts[0]?.label, opts: mainPosts(a).map((p) => p.opts) },
      ));
      await a.plugin.stop();
    }

    // ── #2 유휴 — 리스 유휴 뒤 내림 · 행동 중엔 안 내림 ─────────────────────────────
    {
      let gate = deferred<Rec>();
      let hold = false;
      const a = await arena({
        idleMs: 120,
        post: (r) => (hold && !r.release ? gate.promise : Promise.resolve({ ok: true, fired: r.events.length, stdout: "" })),
      });
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      hold = true;
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      await until(() => mainPosts(a).length === 2);
      await sleep(300); // 유휴(120ms)를 넉넉히 넘김 — 행동이 도는 중
      const duringActive = a.starts[0]!.stopped;
      gate.resolve({ ok: true, fired: 2, stdout: "" });
      await p;
      const hidden = await until(() => a.starts[0]!.stopped === true, 1500);
      out.push(assert(
        "#2 유휴: 행동이 도는 동안엔 유휴가 지나도 표시를 안 내리고, 끝난 뒤 리스 유휴가 지나면 내린다",
        duringActive === false && hidden,
        { duringActive, hidden },
      ));
      gate = deferred<Rec>();
      await a.plugin.stop();
    }
    {
      // ★시계가 뒤로 가 첫 울림 때 리스가 아직 살아 있으면 남은 만큼 다시 걸어, 리스가 끝나면 결국 내린다(R1-1).
      const a = await arena({ idleMs: 80 });
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      (a.desktop["lease"] as { lastTouchedMs: number }).lastTouchedMs = Date.now() + 200;
      await sleep(130); // 첫 울림(80ms) 지남 — 리스는 아직 산다
      const firstFire = a.starts[0]!.stopped;
      const hidden = await until(() => a.starts[0]!.stopped === true, 1500);
      out.push(assert("#2 유휴: 울렸을 때 리스가 아직 살아 있으면(시계 뒤로) 남은 만큼 다시 걸어 리스가 끝나면 내린다", firstFire === false && hidden, { firstFire, hidden }));
      await a.plugin.stop();
    }

    // ── #3 Esc(실행 중) — 두 반환 형태 · 해제 · 파일 생성·삭제 ─────────────────────────
    for (const shape of ["partial", "complete", "partial-release-fails"] as const) {
      const gate = deferred<Rec>();
      let fileSeen = false;
      let stopPath = "";
      const a = await arena({
        post: async (r) => {
          if (r.release) return shape === "partial-release-fails" ? { ok: false, reason: "failed", detail: "합성 해제 실패", stdout: "" } : { ok: true, fired: r.events.length, stdout: "" };
          stopPath = r.opts?.stopFile ?? "";
          return gate.promise;
        },
      });
      const T = a.tools("t1");
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: SHIFT_CLICK }, a.extra());
      await until(() => mainPosts(a).length === 1);
      a.esc();
      fileSeen = stopPath !== "" && existsSync(stopPath);
      gate.resolve(
        shape === "complete"
          ? { ok: true, fired: 4, stdout: '{"step":0}\n{"step":1}\n{"step":2}\n' }
          : { ok: true, fired: 1, stdout: '{"step":0}\n{"stopped":1,"why":"user-esc","saw":""}\n' },
      );
      const r = await p;
      const t = textOf(r);
      const releases = a.posts.filter((x) => x.release);
      out.push(assert(
        `#3 Esc 실행 중(${shape}): 멈춤 요청 파일이 실제로 생기고 반환 뒤엔 없다 · 머리 정확히 1회 · «전면 창» 오보 없음 · /stop 문구 아님 · 잠금 · 표시 내림`,
        fileSeen && !existsSync(stopPath) && count(t, HEAD) === 1 && !t.includes("전면 창이 바뀌었습니다") &&
          !t.includes("조작이 취소되었습니다") && handback(a) !== null && a.starts[0]!.stopped && callsLeft(a) === 0,
        { fileSeen, after: existsSync(stopPath), heads: count(t, HEAD), handback: handback(a), t: t.slice(0, 300) },
      ));
      out.push(assert(
        `#3 Esc 실행 중(${shape}): 단계 상태 — ${shape === "complete" ? "전부 «완료» · 완주라 짝 맞은 키는 이미 떼어져 해제 post 0" : "멈춘 단계부터 «미실행» · 해제 post 는 신호·멈춤 파일 없이 1회"} · 해제 결과는 해제 경고 한 곳에서만`,
        (shape === "complete"
          ? count(t, "[완료]") === 3 && !t.includes("[미실행]") && releases.length === 0
          : t.includes("2번째부터 입력을 보내지 않았습니다") && count(t, "[미실행]") === 2 &&
            releases.length === 1 && releases[0]!.signal === undefined && releases[0]!.opts === undefined) &&
          (shape === "partial-release-fails" ? count(t, "입력 해제 실패") === 1 : !t.includes("입력 해제 실패")),
        { releases: releases.length, t: t.slice(0, 400) },
      ));
    }

    // ── #4 Esc(발사 전·조기 반환·사후 관측) — 모든 경우 «전하지 못했습니다» 아님(stopDir 가 없어도) ──────
    const noDir = path.join(stopDirOk, "없는-폴더");
    {
      // ⓐ 이전 해제분 갚기 post 를 붙잡은 채 Esc(갚기 성공) / ⓑ 갚기 실패 / ⓔ 갚기 거부(Esc 있음·없음)
      for (const mode of ["ok", "fail", "reject", "reject-no-esc"] as const) {
        const gate = deferred<Rec>();
        const a = await arena({ stopDir: noDir, post: (r) => (r.release ? gate.promise : Promise.resolve({ ok: true, fired: 1, stdout: "" })) });
        const T = a.tools("t1");
        const id = await a.frame(T.look);
        (a.desktop["held"] as { keys: string[] }).keys.push("shift");
        const p = T.doTool.handler({ frameId: id, steps: CLICK }, a.extra());
        await until(() => a.posts.length === 1);
        if (mode !== "reject-no-esc") a.esc();
        if (mode === "ok") gate.resolve({ ok: true, fired: 1, stdout: "" });
        else if (mode === "fail") gate.resolve({ ok: false, reason: "failed", detail: "합성 갚기 실패", stdout: "" });
        else gate.reject(new Error("합성 갚기 거부"));
        let r: Content | null = null;
        let threw: unknown = null;
        try { r = await p; } catch (e) { threw = e; }
        const t = r === null ? "" : textOf(r);
        const ok =
          mode === "ok" ? t.includes("입력을 보내지 않았습니다") && count(t, HEAD) === 1 && r?.isError !== true
          : mode === "fail" ? t.includes("눌린 채 남은 입력") && count(t, HEAD) === 1
          : mode === "reject" ? r?.isError === true && count(t, HEAD) === 1 && t.includes("합성 갚기 거부")
          : threw !== null && String(threw).includes("합성 갚기 거부");
        out.push(assert(
          `#4${mode === "ok" ? "ⓐ" : mode === "fail" ? "ⓑ" : "ⓔ"} 발사 전 Esc(갚기 ${mode}): 본 입력 0 · ${mode === "reject-no-esc" ? "Esc 없으면 종전처럼 던짐" : "원래 글 보존 + 머리 1회"} · «전하지 못했습니다» 아님 · 호출 기록 비움`,
          ok && mainPosts(a).length === 0 && !t.includes(HEAD_UNDELIVERED) && callsLeft(a) === 0,
          { mode, isError: r?.isError, threw: threw === null ? null : String(threw).slice(0, 80), t: t.slice(0, 300) },
        ));
        await a.plugin.stop();
      }
      // ⓒ 잘못된 프레임 id 의 재관측을 붙잡은 채 Esc / ⓕ 그 재관측이 Esc 뒤 던짐
      for (const mode of ["held", "throws"] as const) {
        const gate = deferred<void>();
        const a = await arena({ stopDir: noDir, capture: (n) => (n === 2 ? gate.promise : Promise.resolve()) });
        const T = a.tools("t1");
        await a.frame(T.look);
        const p = T.doTool.handler({ frameId: "deadbeef", steps: CLICK }, a.extra());
        await until(() => a.captures() === 2);
        a.esc();
        if (mode === "held") gate.resolve(); else gate.reject(new Error("합성 재관측 예외"));
        const r = await p;
        const t = textOf(r);
        out.push(assert(
          `#4${mode === "held" ? "ⓒ" : "ⓕ"} 프레임 거절 재관측 중 Esc(${mode}): 본 입력 0 · ${mode === "held" ? "프레임 오류 글 보존" : "isError + 원인"} + 머리 1회 · «전하지 못했습니다» 아님`,
          mainPosts(a).length === 0 && count(t, HEAD) === 1 && !t.includes(HEAD_UNDELIVERED) && callsLeft(a) === 0 &&
            (mode === "held" ? /화면 id/.test(t) : r.isError === true && t.includes("합성 재관측 예외")),
          { isError: r.isError, t: t.slice(0, 300) },
        ));
        await a.plugin.stop();
      }
      // ⓓ 정상 실행 뒤 사후 관측을 붙잡은 채 Esc / 사후 관측이 던짐
      for (const mode of ["held", "throws"] as const) {
        const gate = deferred<void>();
        const a = await arena({ stopDir: noDir, capture: (n) => (n === 2 ? gate.promise : Promise.resolve()) });
        const T = a.tools("t1");
        const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
        await until(() => a.captures() === 2);
        const callsDuring = callsLeft(a);
        a.esc();
        if (mode === "held") gate.resolve(); else gate.reject(new Error("합성 사후 관측 예외"));
        const r = await p;
        const t = textOf(r);
        out.push(assert(
          `#4ⓓ 사후 관측 중 Esc(${mode}): 입력 1회 그대로 · 단계 «완료» · 머리 1회 · 잠금 · «전하지 못했습니다» 아님 · 관측 중엔 호출 기록이 남아 있다가 반환 뒤 빈다`,
          mainPosts(a).length === 1 && t.includes("[완료]") && count(t, HEAD) === 1 && handback(a) !== null &&
            !t.includes(HEAD_UNDELIVERED) && callsDuring === 1 && callsLeft(a) === 0,
          { callsDuring, t: t.slice(0, 300) },
        ));
        await a.plugin.stop();
      }
      // ⓗ 동시 호출 — A 가 사후 관측 중일 때 B(같은 소유자)가 끝나면 **A 의 기록만** 남고, 그 뒤 Esc 는 A 의 보고에만 한 번(R1-3)
      {
        const gate = deferred<void>();
        const a = await arena({ capture: (n) => (n === 2 ? gate.promise : Promise.resolve()) });
        const T = a.tools("t1");
        const pA = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
        await until(() => a.captures() === 2);
        const rB = await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
        const callsAfterB = callsLeft(a);
        a.esc();
        gate.resolve();
        const tA = textOf(await pA);
        out.push(assert(
          "#4ⓗ 동시 호출: B 가 반환되면 사후 관측 중인 A 의 기록만 남고, 그 뒤 Esc 는 A 의 보고에 한 번 · B 엔 없다",
          // ★B 가 **실제로 행동을 마쳤어야** 겹침이 성립한다 — 거절로 끝났으면 B 는 기록을 만들지도 않았다(구현 R2).
          textOf(rB).includes("[완료]") && mainPosts(a).length === 2 &&
            callsAfterB === 1 && count(tA, HEAD) === 1 && !textOf(rB).includes(HEAD) && callsLeft(a) === 0,
          { callsAfterB, headsA: count(tA, HEAD), rB: textOf(rB).slice(0, 80) },
        ));
        await a.plugin.stop();
      }
      // ⓖ 본 post 거부 → 해제 post 를 붙잡은 채 Esc → 파일 시도 0(stopDir 가 없어도 «전하지 못했습니다» 아님)
      {
        const gate = deferred<Rec>();
        const a = await arena({
          stopDir: noDir,
          post: (r) => (r.release ? gate.promise : Promise.reject(new Error("합성 본 입력 거부"))),
        });
        const T = a.tools("t1");
        const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: SHIFT_CLICK }, a.extra());
        await until(() => a.posts.some((x) => x.release));
        a.esc();
        gate.resolve({ ok: true, fired: 2, stdout: "" });
        const r = await p;
        const t = textOf(r);
        out.push(assert(
          "#4ⓖ 본 post 거부 뒤 해제 대기 중 Esc: 기존 실패 보고 보존 · 기본 머리 1회 · «전하지 못했습니다» 아님(발사가 끝나 파일을 안 만든다)",
          count(t, HEAD) === 1 && !t.includes(HEAD_UNDELIVERED) && t.includes("합성 본 입력 거부") && callsLeft(a) === 0,
          t.slice(0, 300),
        ));
        await a.plugin.stop();
      }
    }

    // ── #5 Esc(행동 사이) — 남은 장부 해제 · 점유 중 새 do 는 입력 0 ─────────────────────
    for (const mode of ["ok", "fail"] as const) {
      const gate = deferred<Rec>();
      let holdRelease = false;
      const a = await arena({ post: (r) => (r.release && holdRelease ? gate.promise : Promise.resolve({ ok: true, fired: r.events.length, stdout: "" })) });
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()); // 표시를 띄운다
      (a.desktop["held"] as { keys: string[] }).keys.push("shift");
      holdRelease = true;
      const before = a.posts.length;
      const selfBefore = a.desktop["lastSelfInputMs"];
      a.esc();
      await until(() => a.posts.length === before + 1);
      const atMs = (handback(a) as { atMs: number }).atMs;
      a.emit({ channel: "dashboard", threadKey: "t1", text: "계속해", receivedAt: atMs + 5 });
      const unlocked = handback(a) === null;
      const id2 = await a.frame(T.look);
      // ★시한 경주 — 점유가 빠진 구현이면 새 do 가 붙잡힌 해제를 기다리며 매달린다(교착을 빨강으로 바꾼다).
      const rp = T.doTool.handler({ frameId: id2, steps: CLICK }, a.extra());
      const raced = await Promise.race([rp, sleep(1500).then(() => null)]);
      const newMainDuring = mainPosts(a).length;
      gate.resolve(mode === "ok" ? { ok: true, fired: 1, stdout: "" } : { ok: false, reason: "failed", detail: "합성", stdout: "" });
      const r = raced ?? (await rp);
      await until(() => a.desktop["active"] === null);
      await sleep(30);
      const after = a.posts.slice(before);
      const held = (a.desktop["held"] as { keys: string[] }).keys;
      out.push(assert(
        `#5 Esc 행동 사이(해제 ${mode}): 해제 post 1회(신호 없음) · 그 사이 사람 메시지로 잠금은 풀려도 새 do 는 입력 0(busy-other) · ${mode === "ok" ? "장부 빔" : "장부 보존"} · 우리 입력 시각 갱신 · 점유 해제`,
        after.length === 1 && after[0]!.release && after[0]!.signal === undefined && unlocked &&
          raced !== null && newMainDuring === 1 && /사용 중/.test(textOf(r)) &&
          (mode === "ok" ? held.length === 0 : held.includes("shift")) &&
          a.desktop["lastSelfInputMs"] !== selfBefore && a.desktop["active"] === null,
        { unlocked, newMainDuring, after: after.length, held, r: textOf(r).slice(0, 120) },
      ));
      out.push(assert(
        `#W9 Esc 행동 사이(${mode}): 그 사이 do 의 busy-other 문에 보이는 점유자 이름·Esc 로그가 «사용자 Esc» 로 단정하지 않는다`,
        textOf(r).includes("중지 뒤 입력 정리") && !/사용자 ?Esc|사용자가 Esc/.test(textOf(r)) &&
          a.lines.some((l) => l.startsWith("Esc 감지 — ")) && !a.lines.some((l) => /사용자 Esc/.test(l)),
        { r: textOf(r).slice(0, 120), escLogs: a.lines.filter((l) => l.includes("Esc")).slice(0, 4) },
      ));
      await a.plugin.stop();
    }

    // ── #6 잠금과 해제 판정 ───────────────────────────────────────────────────────────
    {
      const a = await arena();
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      a.esc();
      const atMs = (handback(a) as { atMs: number }).atMs;
      const before = mainPosts(a).length;
      const rSame = await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const O = a.tools("other");
      const rOther = await O.doTool.handler({ frameId: await a.frame(O.look), steps: CLICK }, a.extra());
      out.push(assert(
        "#6 잠금: 같은·다른 소유자 do 모두 거절(입력 0) · 다시 시도하지 말라는 안내",
        mainPosts(a).length === before && /중지 요청\(화면 표시의 중지 단추 또는 Esc\)으로 조작이 멈추고/.test(textOf(rSame)) && /중지 요청\(화면 표시의 중지 단추 또는 Esc\)으로 조작이 멈추고/.test(textOf(rOther)),
        { same: textOf(rSame).slice(0, 80), other: textOf(rOther).slice(0, 80) },
      ));
      const tries: Array<[string, Rec, boolean]> = [
        ["합성", { synthetic: true, text: "x", receivedAt: atMs + 10 }, false],
        ["슬래시", { text: "/stop", receivedAt: atMs + 10 }, false],
        ["receivedAt 없음", { text: "계속" }, false],
        ["Esc 전에 받은 메시지(발행은 뒤)", { text: "계속", receivedAt: atMs - 1 }, false],
        ["같은 밀리초", { text: "계속", receivedAt: atMs }, false],
        ["Esc 뒤에 받은 사람 메시지", { text: "계속", receivedAt: atMs + 1 }, true],
      ];
      for (const [name, payload, expectUnlock] of tries) {
        a.emit({ channel: "dashboard", threadKey: "t1", ...payload });
        out.push(assert(`#6 해제 판정 — ${name} → ${expectUnlock ? "풀림" : "안 풀림"}`, (handback(a) === null) === expectUnlock, { handback: handback(a) }));
      }
      const r = await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      out.push(assert("#6 풀린 뒤 do 는 다시 입력을 낸다", mainPosts(a).length === before + 1 && !textOf(r).includes(HEAD), textOf(r).slice(0, 80)));
      await a.plugin.stop();
    }

    // ── #6b 발사 중 멈춤 전달 실패(stopDir 없음) ─────────────────────────────────────────
    {
      const gate = deferred<Rec>();
      const a = await arena({ stopDir: noDir, post: (r) => (r.release ? Promise.resolve({ ok: true, fired: 1, stdout: "" }) : gate.promise) });
      const T = a.tools("t1");
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      await until(() => mainPosts(a).length === 1);
      a.esc();
      gate.resolve({ ok: true, fired: 3, stdout: '{"step":0}\n' });
      const t = textOf(await p);
      out.push(assert(
        "#6b 발사 중 Esc 에서 멈춤 요청 파일을 못 만들면 «전하지 못했습니다» 머리 1회 · 잠금은 걸림 · 로그",
        count(t, HEAD_UNDELIVERED) === 1 && !t.includes(HEAD) && handback(a) !== null && a.lines.some((l) => l.includes("전하지 못함")),
        t.slice(0, 200),
      ));
      await a.plugin.stop();
    }

    // ── #7 /stop(MCP 취소) · #8 실패 — Esc 가 아니면 잠금 없음 ──────────────────────────────
    {
      const ac = new AbortController();
      const a = await arena({
        post: (r) => r.release
          ? Promise.resolve({ ok: true, fired: 1, stdout: "" })
          : new Promise((res) => r.signal?.addEventListener("abort", () => res({ ok: false, reason: "failed", detail: "조작 취소 — 잔여 입력 중단", stdout: "" }), { once: true })),
      });
      const T = a.tools("t1");
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, { signal: ac.signal });
      await until(() => mainPosts(a).length === 1);
      ac.abort();
      const t = textOf(await p);
      out.push(assert("#7 /stop: 기존 취소 보고 · 머리 없음 · 잠금 없음 · 표시 유지", t.includes("조작 취소") && !t.includes(HEAD) && handback(a) === null && a.starts[0]!.stopped === false, t.slice(0, 160)));
      await a.plugin.stop();
    }
    {
      let first = true;
      const a = await arena({ post: (r) => {
        if (!r.release && first) { first = false; return Promise.resolve({ ok: false, reason: "failed", detail: "합성 실패", stdout: "" }); }
        return Promise.resolve({ ok: true, fired: r.events.length, stdout: "" });
      } });
      const T = a.tools("t1");
      const t1 = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()));
      const t2 = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()));
      out.push(assert("#8 실패: 기존 실패 보고 · 잠금 없음 · 다음 do 정상", t1.includes("합성 실패") && handback(a) === null && mainPosts(a).length === 2 && !t2.includes("다른 조작이 진행 중"), { t1: t1.slice(0, 120), t2: t2.slice(0, 80) }));
      await a.plugin.stop();
    }

    // ── #9 표시 실패·세대 ─────────────────────────────────────────────────────────────
    {
      const a = await arena({ startThrows: true });
      const T = a.tools("t1");
      const t = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()));
      out.push(assert("#9 표시 기동이 던져도 조작은 그대로(입력 1) · 로그", mainPosts(a).length === 1 && !t.includes(HEAD) && a.lines.some((l) => l.includes("띄우지 못했습니다")), t.slice(0, 80)));
      await a.plugin.stop();
    }
    {
      const a = await arena({ idleMs: 80 });
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const old = a.starts[0]!;
      await until(() => old.stopped, 1500); // 유휴로 내림 — 재기동 전
      old.onStop("esc");
      const noLock = handback(a) === null;
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()); // 재기동
      const cur = (a.indicator as { current: unknown }).current;
      old.onGone("늦은 종료");
      const kept = (a.indicator as { current: unknown }).current === cur && cur !== null && a.starts.length === 2;
      out.push(assert("#9 세대: 내린 뒤(재기동 전) 옛 도우미의 Esc 는 잠금을 안 건다 · 재기동 뒤 옛 종료 통보는 새 표시를 안 지운다", noLock && kept, { noLock, kept, starts: a.starts.length }));
      await a.plugin.stop();
    }

    // ── #10 종료 — 표시 내림 · 구독 해지 ─────────────────────────────────────────────
    {
      const a = await arena();
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const h = a.starts[0]!;
      await a.plugin.stop();
      const hidden = h.stopped;
      h.onStop("esc");
      const noLockAfterStop = handback(a) === null;
      a.desktop["handback"] = { atMs: 1 };
      a.emit({ channel: "dashboard", threadKey: "t1", text: "계속", receivedAt: 10 });
      out.push(assert("#10 종료: stop() 이 표시를 내리고, 그 뒤 옛 도우미 Esc·사람 메시지에 반응하지 않는다(구독 해지)", hidden && noLockAfterStop && handback(a) !== null, { hidden, noLockAfterStop }));
    }

    // ── #11·#11b·#12 맥 실행부·도우미 빈 연습(입력·클립보드·창 0) ─────────────────────────
    if (process.platform !== "darwin") {
      out.push(skip("#11·#11b·#12 맥 실행부·도우미 빈 연습", `platform=${process.platform} — osascript 는 macOS 것이다`));
    } else {
      const mac = await loadPluginModule<MacModule>("../../../plugins/computer-use/src/mac.ts");
      const sf = (n: string): string => path.join(stopDirOk, `dry-${n}`);
      // ⓐ 파일 미리 있음
      writeFileSync(sf("a"), "");
      const ra = await mac.dryPost([{ t: "mark", i: 0 }, { t: "keydown", key: "a" }, { t: "keyup", key: "a" }], { stopFile: sf("a") });
      out.push(assert("#11ⓐ 멈춤 파일이 이미 있으면 첫 단계 전에 멈춘다 · 시도 0 · 붙여넣기 0", ra["ok"] === true && (ra["stoppedAt"] as Rec | undefined)?.["i"] === 0 && (ra["stoppedAt"] as Rec | undefined)?.["why"] === "user-esc" && ra["tried"] === 0 && ra["uni"] === 0, ra));
      // ⓒ 대조군 — 파일 없음: 끝까지, 붙여넣기 진입이 실제로 센다
      const rc = await mac.dryPost([{ t: "mark", i: 0 }, { t: "keydown", key: "a" }, { t: "keyup", key: "a" }, { t: "mark", i: 1 }, { t: "unicode", text: "x" }], { stopFile: sf("c") });
      out.push(assert("#11ⓒ 대조군: 파일 없으면 멈춤 없음 · 시도 2 · 붙여넣기 진입 1", rc["ok"] === true && rc["stopped"] === false && rc["tried"] === 2 && rc["uni"] === 1, rc));
      const re = await mac.dryPost([]);
      out.push(assert("#11 빈 열의 빈 연습은 확실한 0(판독 불가 -1 이 아니다)", re["ok"] === true && re["fired"] === 0 && re["tried"] === 0 && re["uni"] === 0 && re["stopped"] === false, re));
      // ⓑ 단계 1(wait 3000) 을 본 뒤 파일 생성 → 그 wait 에서 끊김
      const evB = [{ t: "mark", i: 0 }, { t: "keydown", key: "a" }, { t: "keyup", key: "a" }, { t: "mark", i: 1 }, { t: "wait", ms: 3000 }, { t: "mark", i: 2 }, { t: "keydown", key: "b" }, { t: "keyup", key: "b" }, { t: "unicode", text: "y" }];
      const rb = await new Promise<{ code: number | null; out: string; ms: number }>((resolve) => {
        const t0 = Date.now();
        const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", mac.POST_SCRIPT], {
          env: { ...process.env, TIGUCLAW_DRY: "1", TIGUCLAW_EVENTS: JSON.stringify(evB), TIGUCLAW_STOP_FILE: sf("b") },
          stdio: ["ignore", "pipe", "ignore"],
        });
        let so = "";
        child.stdout.on("data", (b: Buffer) => {
          so += b.toString("utf8");
          if (so.includes('{"step":1}') && !existsSync(sf("b"))) writeFileSync(sf("b"), "");
        });
        const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.on("close", (code) => { clearTimeout(killer); resolve({ code, out: so, ms: Date.now() - t0 }); });
      });
      const last = (() => { try { return JSON.parse(rb.out.trim().split("\n").pop() ?? "") as Rec; } catch { return {} as Rec; } })();
      const st = last["stopped"] as Rec | null | undefined;
      out.push(assert(
        "#11ⓑ 단계 1 의 wait 도중 파일이 생기면 그 자리에서 끊긴다 — 멈춘 단계 1 · 시도 2(앞 단계만) · 붙여넣기 0 · 3초를 다 안 기다림",
        rb.code === 0 && st?.["stopped"] === 1 && st["why"] === "user-esc" && last["tried"] === 2 && last["uni"] === 0 && rb.ms < 2600,
        { code: rb.code, last, ms: rb.ms },
      ));
      // #11b 제품 사슬 — runSteps → post(…,{stopFile}) → env → POST_SCRIPT(빈 연습)
      {
        const results: Rec[] = [];
        const a = await arena({
          control: {
            controlPreflight: () => Promise.resolve({ ok: true }),
            idleSeconds: () => Promise.resolve(99),
            frontWindow: () => Promise.resolve("stub-front"),
            post: async (events: Rec[], signal?: AbortSignal, opts?: { stopFile?: string }) => {
              if (!isRelease(events) && opts?.stopFile !== undefined) writeFileSync(opts.stopFile, ""); // «발사가 시작되는 순간의 Esc»
              const r = await mac.post(events, signal, { ...opts, dry: true });
              if (!isRelease(events)) results.push(r);
              return r;
            },
          },
        });
        const T = a.tools("t1");
        const t0 = Date.now();
        const t = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: [{ t: "wait", ms: 3000 }, { t: "keydown", key: "a" }, { t: "keyup", key: "a" }] }, a.extra()));
        const ms = Date.now() - t0;
        const finalLine = (() => {
          try { return JSON.parse(String(results[0]?.["stdout"] ?? "").trim().split("\n").pop() ?? "") as Rec; } catch { return {} as Rec; }
        })();
        const fst = finalLine["stopped"] as Rec | null | undefined;
        out.push(assert(
          "#11b 제품 사슬: runSteps 가 멈춤 파일을 post 에 넘기고 mac.post 가 env 로 넘겨 실행부가 첫 단계 전에 멈춘다 — **같은 실행부 결과**에서 멈춤 단계 0 · user-esc · 시도 0 · 3초 안 기다림",
          results.length === 1 && fst?.["stopped"] === 0 && fst["why"] === "user-esc" && finalLine["tried"] === 0 &&
            t.includes("1번째부터 입력을 보내지 않았습니다") && count(t, "[미실행]") === 3 && ms < 2600,
          { ms, finalLine, t: t.slice(0, 200) },
        ));
        await a.plugin.stop();
      }
      // #12 도우미 빈 연습
      const ri = await new Promise<{ err: string | null; so: string }>((resolve) =>
        execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", mac.INDICATOR_SCRIPT], { env: { ...process.env, TIGUCLAW_DRY: "1" }, timeout: 8000 }, (e, so) =>
          resolve({ err: e === null ? null : String(e).slice(0, 160), so: String(so) })),
      );
      out.push(assert("#12 표시 도우미 스크립트가 JXA 로 파싱·기동되고 빈 연습 줄을 낸다(창·키 0)", ri.err === null && /"ready":1/.test(ri.so) && /"dry":1/.test(ri.so), ri));
      // #13 가장자리 주황 빛(⑤ 외형 확정) — 도우미가 쓰는 **그 조각**(`GLOW_JS`)을 창 없이 화면 밖 비트맵(1배)에 그려 알파·색을 잰다(사용자 화면 0).
      {
        const { GLOW, glowAlphaAt } = await loadPluginModule<{ GLOW: { width: number; rgb: readonly number[] }; glowAlphaAt: (d: number) => number }>("../../../plugins/computer-use/src/indicator.ts");
        const W = 240, H = 160;
        const probe = [
          "ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('QuartzCore');",
          mac.GLOW_JS,
          `var W = ${String(W)}, H = ${String(H)}; var root = $.CALayer.layer; root.setFrame($.NSMakeRect(0, 0, W, H)); glowInto(root, W, H);`,
          "var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, W, H, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);",
          "var g = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep); root.renderInContext(g.CGContext); g.flushGraphics;",
          "function px(x, y){ var c = rep.colorAtXY(x, y); return [Number(c.redComponent), Number(c.greenComponent), Number(c.blueComponent), Number(c.alphaComponent)]; }",
          // 가운데 줄의 왼쪽 가장자리부터 안쪽으로 · 모서리 · 가운데 · 오른쪽·아래 가장자리
          "var row = []; for (var x = 0; x < W / 2; x++) { row.push(px(x, H / 2)); }",
          "JSON.stringify({row: row, corner: px(0, 0), inner: px(5, 3), right: px(W - 1, H / 2), bottom: px(W / 2, H - 1), center: px(W / 2, H / 2)});",
        ].join("\n");
        const rg = await new Promise<{ err: string | null; so: string }>((resolve) =>
          execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", probe], { timeout: 8000 }, (e, so) => resolve({ err: e === null ? null : String(e).slice(0, 160), so: String(so) })),
        );
        type Probe = { row: number[][]; corner: number[]; inner: number[]; right: number[]; bottom: number[]; center: number[] };
        const m = ((): Probe | null => { try { return JSON.parse(rg.so) as Probe; } catch { return null; } })();
        const near = (a: number | undefined, b: number): boolean => typeof a === "number" && Math.abs(a - b) <= 0.01;
        const rowOk = m !== null && m.row.every((p, d) => near(p[3], glowAlphaAt(d)));
        const [r, g2, b] = GLOW.rgb.map((v) => v / 255) as [number, number, number];
        const colorOk = m !== null && near(m.row[0]?.[0], r) && near(m.row[0]?.[1], g2) && near(m.row[0]?.[2], b);
        out.push(assert(
          "★#13 가장자리 빛: 도우미 조각을 화면 밖에 그리면 가장자리에서 안쪽으로 알파가 `GLOW` 식대로 줄고(0~119 전 줄 ±0.01, 가장자리 0.71) · " +
            "폭 밖(가운데)은 투명 · 네 변·모서리 같은 규칙 · 색은 빛 주황(단추·고리 주황과 별개)",
          rg.err === null && m !== null && rowOk && colorOk && near(m.corner[3], glowAlphaAt(0)) && near(m.inner[3], glowAlphaAt(3)) &&
            near(m.right[3], glowAlphaAt(0)) && near(m.bottom[3], glowAlphaAt(0)) && m.center[3] === 0 && glowAlphaAt(GLOW.width) === 0 && (m.row[GLOW.width]?.[3] ?? -1) === 0,
          rg.err ?? { edge: m?.row[0], d29: m?.row[29], d57: m?.row[57], d58: m?.row[58], corner: m?.corner, inner: m?.inner, center: m?.center },
        ));
        const s = mac.INDICATOR_SCRIPT;
        out.push(assert(
          "#13 도우미는 그 조각을 그대로 싣고 화면마다 창 레이어에 빛을 쌓는다 · 옛 4pt 단색 테두리 없음 · 단추·고리 주황(TINT)은 그대로",
          s.includes(mac.GLOW_JS) && /glowInto\(b\.contentView\.layer, f\.size\.width, f\.size\.height\);/.test(s) && !/setBorderWidth\(4\)/.test(s) &&
            /tag\.contentView\.layer\.setBackgroundColor\(TINT\.CGColor\)/.test(s) && /halo\.contentView\.layer\.setBorderColor\(TINT\.CGColor\)/.test(s),
          { hasGlow: s.includes(mac.GLOW_JS) },
        ));
      }
    }

    // ── #R4 (⑤ r4) 중지 단추 · 우리 클릭 통과 표식 · 우리 그림의 표시 안내 ───────────────────────
    {
      // R4-1 발사 중 중지 단추 → Esc 와 같은 결정 한 곳(멈춤 파일·머리 1회·잠금·표시 내림) · 로그는 «중지 단추»
      const gate = deferred<Rec>();
      let fileSeen = false;
      const a = await arena({
        post: async (r) => {
          if (r.release) return { ok: true, fired: 1, stdout: "" };
          a.button();
          fileSeen = r.opts?.stopFile !== undefined && existsSync(r.opts.stopFile);
          gate.resolve({});
          return { ok: true, fired: 1, stdout: '{"step":0}\n{"stopped":0,"why":"user-esc","saw":""}\n' };
        },
      });
      const T = a.tools("t1");
      const t = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()));
      await gate.promise;
      out.push(assert(
        "#R4-1 발사 중 중지 단추: 멈춤 파일 생성 · 머리 정확히 1회 · 잠금 · 표시 내림 · 로그 «중지 단추 감지 — »(잠금 해제 규칙은 Esc 와 같은 한 곳 — #4~#6 이 잰다)",
        fileSeen && count(t, HEAD) === 1 && handback(a) !== null && a.starts[0]!.stopped &&
          a.lines.some((l) => l.startsWith("중지 단추 감지 — ")) && a.lines.some((l) => l === "제어 표시 내림 — 중지 단추"),
        { fileSeen, heads: count(t, HEAD), handback: handback(a), lines: a.lines.filter((l) => l.includes("중지")).slice(0, 4) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-2 비킴 요청 파일 = 도우미 세대마다 하나(부모만 쓴다) — 내리면 비움 · 다시 뜨면 새 이름 · 예기치 않은 종료에도 비움 · 실행부엔 안 준다
      const a = await arena();
      const T = a.tools("t1");
      const before = textOf(await T.look.handler({}, a.extra()));
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const ind = a.indicator as { move: string | null };
      const gen1 = ind.move;
      const after = textOf(await T.look.handler({}, a.extra()));
      a.button();
      const clearedOnHide = ind.move === null;
      a.emit({ channel: "dashboard", threadKey: "t1", text: "계속", receivedAt: Date.now() + 1 });
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const gen2 = ind.move;
      a.starts[1]?.onGone("합성 종료");
      const clearedOnGone = ind.move === null;
      const execOpts = mainPosts(a).map((p) => Object.keys(p.opts ?? {}).sort().join(","));
      out.push(assert(
        "#R4-2 세대별 요청 파일: 기동 인자 = 지금 세대 · 내리면 비움 · 다시 뜨면 새 이름 · 예기치 않은 종료에도 비움 · 실행부 인자엔 단추 관련 없음",
        gen1 !== null && a.starts[0]?.moveFile === gen1 && clearedOnHide && gen2 !== null && gen2 !== gen1 && a.starts[1]?.moveFile === gen2 &&
          clearedOnGone && execOpts.every((k) => k === "stopFile"),
        { gen1, gen2, clearedOnHide, clearedOnGone, execOpts },
      ));
      out.push(assert(
        "#R4-3 우리 그림의 표시 안내: 표시가 떠 있을 때만 «표시 참고:» 를 싣는다(뜨기 전 look 에는 없다)",
        !before.includes("표시 참고:") && after.includes("표시 참고:") && after.includes("중지"),
        { before: before.includes("표시 참고:"), after: after.includes("표시 참고:") },
      ));
      await a.plugin.stop();
    }
    {
      // R4-2c 늦은 종료 통보 — 옛 세대 도우미의 종료(onGone)는 자기 요청 파일을 지우고 새 세대 상태는 그대로
      const a = await arena();
      const T = a.tools("t1");
      const ind = a.indicator as { move: string | null; current: unknown };
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const gen1 = ind.move;
      a.button();
      a.emit({ channel: "dashboard", threadKey: "t1", text: "계속", receivedAt: Date.now() + 1 });
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const gen2 = ind.move;
      const cur2 = ind.current;
      if (gen1 !== null) writeFileSync(gen1, "x;"); // «내린 세대의 파일이 남아 있다»
      if (gen2 !== null) writeFileSync(gen2, "y;");
      a.starts[0]?.onGone("늦은 종료");
      await sleep(50);
      out.push(assert("#R4-2c 늦은 종료 통보: 새 세대 상태·요청 파일은 그대로", ind.move === gen2 && ind.current === cur2 && gen2 !== null && existsSync(gen2), { gen2 }));
      out.push(assert(
        "#R4-2c′ 늦은 종료 통보: 옛 세대 요청 파일은 디스크에서 지워진다(무삭제 러너에선 지우기가 막혀 빨강 — BLOCKED 에 이 경로)",
        gen1 !== null && !existsSync(gen1),
        { gen1 },
      ));
      await a.plugin.stop();
    }
    {
      // R4-3b 촬영 **도중** 표시가 떴다 내려간 그림 · 저장본 재열람 — 둘 다 «표시 참고:» 를 싣는다
      const indm = await loadPluginModule<{
        showIndicator: (i: Rec, owner: string, label: string, onStop: (v: string) => void, log: (m: string) => void) => void;
        hideIndicator: (i: Rec, why: string, log: (m: string) => void) => void;
      }>("../../../plugins/computer-use/src/indicator.ts");
      let flip = false;
      const a = await arena({
        capture: async () => {
          if (!flip) return;
          indm.showIndicator(a.indicator as Rec, "t2", "x", () => {}, () => {});
          indm.hideIndicator(a.indicator as Rec, "합성", () => {});
        },
      });
      const T = a.tools("t1");
      const plain = await T.look.handler({}, a.extra());
      flip = true;
      const mid = await T.look.handler({}, a.extra());
      flip = false;
      const savedRef = (mid.content.find((c) => c["type"] === "image")?.["_meta"] as Rec | undefined)?.["tiguclaw/saved-screen"];
      const re = typeof savedRef === "string" ? textOf(await T.look.handler({ saved: savedRef }, a.extra())) : "(저장본 없음)";
      out.push(assert(
        "#R4-3b 촬영 도중 떴다 내려간 표시도 그 그림에 안내를 붙인다(세대 변화) · 표시와 무관한 촬영엔 없다 · 저장본 재열람에는 조건문 안내가 붙는다",
        !textOf(plain).includes("표시 참고:") && textOf(mid).includes("표시 참고:") && re.includes("표시 참고:"),
        { plain: textOf(plain).includes("표시 참고:"), mid: textOf(mid).includes("표시 참고:"), savedRef: typeof savedRef, re: re.slice(0, 80) },
      ));
      await a.plugin.stop();
    }
    // ── #R4 clearPillFor — 우리 누름과 중지 단추(부모 판단 한 곳) ──
    // CLICK 의 누를 점 = 화면 (12,12). 그 점을 덮는 단추 자리 / 비킨 자리.
    const COVER = { x: 0, y: 0, w: 100, h: 30 };
    const AWAY = { x: 0, y: 900, w: 100, h: 30 };
    // 가짜 도우미가 비킴 요청 파일을 보고 응답한다(실제 도우미의 `{"pill":…,"req":…}` 줄과 같은 콜백).
    const answerMoves = (a: Arena, next: { x: number; y: number; w: number; h: number } | null): (() => void) => {
      let on = true;
      void (async () => {
        const seen = new Set<string>();
        while (on) {
          for (const st of a.starts) {
            if (st.stopped) continue;
            const f = st.moveFile;
            if (existsSync(f)) {
              const req = String(await fs.readFile(f, "utf8").catch(() => ""));
              if (req.endsWith(";") && !seen.has(req)) { seen.add(req); st.onPill?.(next, req); }
            }
          }
          await sleep(5);
        }
      })();
      return () => { on = false; };
    };
    {
      // R4-7 겹침 → 비킴 요청 → 응답(새 자리가 점 밖) → 그 뒤에 발사
      const a = await arena({ readyPill: COVER });
      const stopAns = answerMoves(a, AWAY);
      const T = a.tools("t1");
      const t = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()));
      stopAns();
      const mv = a.starts[0] !== undefined && existsSync(a.starts[0].moveFile) ? String(await fs.readFile(a.starts[0].moveFile, "utf8")) : "";
      out.push(assert(
        "#R4-7 겹치면 비킴 요청(부모가 세대 파일에 `;` 로 끝나는 요청) → 응답을 받은 뒤 발사 · 표시는 그대로 · 멈춤 없음",
        mainPosts(a).length === 1 && mv.endsWith(";") && a.starts[0]?.stopped === false && t.startsWith("열을 끝까지 실행했습니다"),
        { posts: mainPosts(a).length, mv, t: t.slice(0, 80) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-8 겹침 → 응답 없음 → 그 세대를 내리고 종료 확인 → 단추 없이 발사
      const a = await arena({ readyPill: COVER });
      const T = a.tools("t1");
      const t0 = Date.now();
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      out.push(assert(
        "#R4-8 비킴 응답이 없으면 그 세대를 내리고 종료를 확인한 뒤 발사(남은 요청이 다음 열에 늦게 처리되지 않는다) · 로그 «비킴 응답 없음»",
        mainPosts(a).length === 1 && a.starts[0]?.stopped === true && a.lines.some((l) => l.includes("제어 표시 내림 — 비킴 응답 없음")) && Date.now() - t0 >= 550,
        { posts: mainPosts(a).length, ms: Date.now() - t0, lines: a.lines.filter((l) => l.includes("제어 표시")).slice(0, 3) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-9 겹침 → 응답 없음 → 내렸는데 종료가 확인되지 않음 → 이번 열은 보내지 않는다
      const a = await arena({ readyPill: COVER, stuck: true });
      const T = a.tools("t1");
      const t = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()));
      out.push(assert(
        "#R4-9 종료를 확인하지 못하면 보내지 않는다(단추가 아직 화면에 있을 수 있다) — 본 입력 0 · 거절 문구",
        mainPosts(a).length === 0 && t.includes("겹치지 않는지 확인하지 못했습니다"),
        { posts: mainPosts(a).length, t: t.slice(0, 120) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-10 겹침 → 도우미가 옮기지 못함(같은 자리 응답 — Windows `SetWindowPos` 실패) → «두 자리 모두» 가 아니다: 그 세대를 내리고 끝남 확인 뒤 발사
      const a = await arena({ readyPill: COVER });
      const stopAns = answerMoves(a, COVER);
      const T = a.tools("t1");
      const t = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()));
      stopAns();
      out.push(assert(
        "#R4-10 옮기지 못하면(같은 자리 응답) 그 세대를 내리고 끝남 확인 뒤 발사 — «두 자리 모두» 오보 없음 · 로그 «단추가 비키지 않음»",
        mainPosts(a).length === 1 && !t.includes("두 자리 모두") && a.starts[0]?.stopped === true && a.lines.some((l) => l.includes("제어 표시 내림 — 단추가 비키지 않음")),
        { posts: mainPosts(a).length, t: t.slice(0, 100) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-10b 누를 점이 위·아래 두 자리 모두에 있다(실제로 옮겼는데 새 자리도 겹침) → 이번 열은 보내지 않는다
      const a = await arena({ readyPill: COVER });
      const stopAns = answerMoves(a, AWAY);
      const T = a.tools("t1");
      // 그림 (10,10) → 화면 (12,12) = COVER 안 · 그림 (10,759) → 화면 (12,911) = AWAY 안
      const t = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: [{ t: "click", x: 10, y: 10 }, { t: "click", x: 10, y: 759 }] }, a.extra()));
      stopAns();
      out.push(assert(
        "#R4-10b 두 자리 모두에 누를 점이 있으면 보내지 않는다 — 본 입력 0 · «위·아래 두 자리 모두» · 표시는 그대로",
        mainPosts(a).length === 0 && t.includes("두 자리 모두") && a.starts[0]?.stopped === false,
        { posts: mainPosts(a).length, t: t.slice(0, 120) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-9b 끝남 미확인 잔존 단추 — 다음 `do` 도 누름을 보내지 않고 새 표시를 띄우지 않는다 · 잔존 단추 클릭은 중지 · 끝나면 회복
      const a = await arena({ readyPill: COVER, stuck: true });
      const T = a.tools("t1");
      const t1 = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra())); // 응답 없음 → 내림 → 끝남 미확인 → 거절
      const t2 = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra())); // 잔존 → 거절 · 새로 안 띄움
      const startsAfter2 = a.starts.length;
      const keysOk = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: [{ t: "keydown", key: "a" }, { t: "keyup", key: "a" }] }, a.extra()));
      const postsBefore = mainPosts(a).length;
      const waitersWhileStuck = (a.indicator as { waiters: unknown[] }).waiters.length; // 잔존이 남은 채 시한·거절만 되풀이된 시점
      a.closeStart(0); // 잔존 도우미가 드디어 끝남
      await sleep(20);
      // 회복 — 새 도우미도 같은 가짜(덮는 자리)라 **단추 밖 점**(화면 12,911)을 누른다: 새로 띄우고 그 누름이 정확히 한 번 나간다.
      const t3 = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: [{ t: "click", x: 10, y: 759 }] }, a.extra()));
      out.push(assert(
        "#R4-9b 잔존 단추: 다음 do 의 누름도 거절 · 새 표시 안 띄움 · 키만 있는 열은 간다 · 잔존이 끝나면 새로 띄우고 누름이 간다",
        t1.includes("확인하지 못했습니다") && t2.includes("확인하지 못했습니다") && startsAfter2 === 1 && postsBefore === 1 &&
          keysOk.startsWith("열을 끝까지") && a.starts.length === 2 && mainPosts(a).length === postsBefore + 1 && t3.startsWith("열을 끝까지") &&
          waitersWhileStuck === 0, // 시한·거절이 되풀이돼도(깨움 없이) 대기 등록이 남지 않는다
        { t1: t1.slice(0, 60), t2: t2.slice(0, 60), startsAfter2, postsBefore, waitersWhileStuck, t3: t3.slice(0, 60), starts: a.starts.length },
      ));
      await a.plugin.stop();
    }
    {
      // R4-13 시한 → 종료 요청 → (지연) 종료 순서: 종료 전 본 입력 0 · 종료 뒤 1 / 그 사이 잔존 단추 클릭 = 중지 / 그 사이 MCP 취소 = 취소
      const a = await arena({ readyPill: null, stuck: true });
      const T = a.tools("t1");
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const seenStop = await until(() => a.starts[0]?.stopped === true, 3000); // 준비 시한 → 내림(종료 요청)
      await sleep(200);
      const beforeClose = mainPosts(a).length;
      a.closeStart(0);
      await p;
      out.push(assert("#R4-13 준비 시한 뒤 종료 요청과 실제 종료 사이에는 보내지 않는다 — 종료 요청 관측 · 종료 전 0 · 종료 뒤 1", seenStop && beforeClose === 0 && mainPosts(a).length === 1, { seenStop, beforeClose, after: mainPosts(a).length }));
      await a.plugin.stop();
      const b = await arena({ readyPill: null, stuck: true });
      const U = b.tools("t1");
      const q = U.doTool.handler({ frameId: await b.frame(U.look), steps: CLICK }, b.extra());
      const seenStopB = await until(() => b.starts[0]?.stopped === true, 3000);
      b.starts[0]?.onStop("button"); // 아직 화면에 있을 수 있는 잔존 단추를 사람이 누름
      const tq = textOf(await q);
      out.push(assert("#R4-13′ 잔존 단추 클릭도 중지다 — 종료 요청 관측 · 본 입력 0 · 잠금 · 중지 머리", seenStopB && mainPosts(b).length === 0 && handback(b) !== null && count(tq, HEAD) === 1, { seenStopB, posts: mainPosts(b).length, tq: tq.slice(0, 80) }));
      await b.plugin.stop();
      const c = await arena({ readyPill: null, stuck: true });
      const V = c.tools("t1");
      const ac = new AbortController();
      const r = V.doTool.handler({ frameId: await c.frame(V.look), steps: CLICK }, { signal: ac.signal });
      const seenStopC = await until(() => c.starts[0]?.stopped === true, 3000);
      ac.abort();
      const tr = textOf(await r);
      out.push(assert("#R4-13″ 종료 확인을 기다리는 동안 취소 — 종료 요청 관측 · 본 입력 0 · 취소 문구", seenStopC && mainPosts(c).length === 0 && tr.includes("조작이 취소되었습니다"), { seenStopC, posts: mainPosts(c).length, tr: tr.slice(0, 60) }));
      await c.plugin.stop();
    }
    {
      // R4-7f 빠른 응답 — 도우미가 요청 **전달이 끝나기 전에** 응답해도 놓치지 않는다(대기 표시가 요청보다 먼저 서 있다)
      const a = await arena({ readyPill: COVER, answerInRequest: AWAY });
      const T = a.tools("t1");
      const t = textOf(await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()));
      out.push(assert(
        "#R4-7f 전달 완료 전 응답: 은퇴 없이 한 번 발사 · 요청 1 · 표시 그대로",
        mainPosts(a).length === 1 && a.requests.length === 1 && a.starts[0]?.stopped === false && t.startsWith("열을 끝까지") &&
          !a.lines.some((l) => l.includes("비킴 응답 없음")),
        { posts: mainPosts(a).length, requests: a.requests.length, t: t.slice(0, 60) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-14 준비를 기다리는 동안 플러그인 종료 — 잔존이 끝났는지 확인 못 하면 보내지 않는다 · 새로 띄우지 않는다
      const a = await arena({ readyPill: null, stuck: true });
      const T = a.tools("t1");
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      await sleep(300);
      await a.plugin.stop();
      const t = textOf(await p);
      a.closeStart(0); // 잔존이 끝난 뒤에도
      await sleep(20);
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: [{ t: "keydown", key: "a" }, { t: "keyup", key: "a" }] }, a.extra()); // 종료 뒤 들어온 조작
      out.push(assert(
        "#R4-14 준비 대기 중 플러그인 종료: 잔존 끝남 미확인 → 본 입력 0 · 종료 뒤 들어온 조작도 표시를 새로 띄우지 않는다(기동 1회 그대로)",
        mainPosts(a).filter((x) => x.events.some((e) => e["t"] === "mousedown")).length === 0 && a.starts.length === 1 && t.includes("확인하지 못했습니다"),
        { posts: mainPosts(a).length, starts: a.starts.length, t: t.slice(0, 80) },
      ));
    }
    {
      // R4-14b **비킴 응답**을 기다리는 동안 플러그인 종료 — 요청이 실제로 전달된 뒤 종료 · 잔존 끝남 미확인 → 이번 열은 보내지 않는다
      const a = await arena({ readyPill: COVER, stuck: true, recordRequests: true });
      const T = a.tools("t1");
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const delivered = await until(() => a.requests.length === 1, 3000);
      await a.plugin.stop();
      const t = textOf(await p);
      out.push(assert(
        "#R4-14b 비킴 응답 대기 중 플러그인 종료: 요청 전달 관측 · 본 입력 0 · 거절 문구 · 잔존 유지",
        delivered && mainPosts(a).length === 0 && t.includes("확인하지 못했습니다") && (a.indicator as { zombies: Set<unknown> }).zombies.size === 1,
        { delivered, posts: mainPosts(a).length, t: t.slice(0, 80) },
      ));
    }
    {
      // R4-15b 잔존 끝남을 기다리는 사이 **MCP 취소** → 끝난 뒤에도 표시를 다시 띄우지 않는다 · 본 입력 0 · 취소 문구 · 대기 등록 0
      const a = await arena({ readyPill: COVER, stuck: true });
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()); // 응답 없음 → 은퇴 → 잔존(끝나지 않음)
      const ac = new AbortController();
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, { signal: ac.signal });
      const waiting = await until(() => (a.indicator as { waiters: unknown[] }).waiters.length > 0, 3000); // 띄우기 전 잔존 대기에 들어감
      ac.abort();
      const waitersAfterAbort = (a.indicator as { waiters: unknown[] }).waiters.length;
      a.closeStart(0); // 같은 동기 구간에서 잔존도 끝남
      const t = textOf(await p);
      out.push(assert(
        "#R4-15b 잔존 대기 중 MCP 취소 → 재기동 0(기동 1회 그대로) · 본 입력 0 · 취소 문구 · 취소만으로 대기 등록이 빠짐",
        waiting && waitersAfterAbort === 0 && a.starts.length === 1 && mainPosts(a).length === 0 && t.includes("조작이 취소되었습니다"),
        { waiting, waitersAfterAbort, starts: a.starts.length, posts: mainPosts(a).length, t: t.slice(0, 60) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-17 끄고 다시 켬 — 같은 표시부(공유)를 받는 새 인스턴스가 서비스를 시작하면 첫 정상 do 에서 표시가 한 번 뜨고 본 입력이 한 번 나간다
      const a = await arena();
      await a.plugin.stop(); // A 끔(멈춤)
      const b = new Plugin(a.w);
      await b.startService(undefined, a.svcHost); // B 켬 — 멈춤이 풀려야 한다
      const srv = b.getMcpServer({ dataDir, locale: "ko", log: (m: string) => a.lines.push(String(m)), turn: { threadKey: "t1", channel: "dashboard", target: null }, on: () => () => {}, turnSession: () => null });
      const tl = srv?.instance._registeredTools;
      const look = tl?.["look"];
      const doT = tl?.["do"];
      let ok = false;
      if (look !== undefined && doT !== undefined) {
        const lr = await look.handler({}, a.extra());
        const id = /화면 id[^0-9a-f]*([0-9a-f]{8})/.exec(textOf(lr))?.[1] ?? "";
        const t = textOf(await doT.handler({ frameId: id, steps: CLICK }, a.extra()));
        ok = t.startsWith("열을 끝까지");
      }
      out.push(assert(
        "#R4-17 다시 켠 인스턴스: 첫 정상 do 에서 표시 기동 정확히 1 · 본 입력 1",
        ok && a.starts.length === 1 && mainPosts(a).length === 1,
        { ok, starts: a.starts.length, posts: mainPosts(a).length },
      ));
      await b.stop();
    }
    {
      // R4-15 잔존 끝남을 기다리는 사이 사람이 옛 단추를 누름 → 끝난 뒤에도 표시를 다시 띄우지 않는다 · 본 입력 0
      const a = await arena({ readyPill: COVER, stuck: true });
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()); // 응답 없음 → 은퇴 → 잔존(끝나지 않음)
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()); // 띄우기 전 잔존 대기
      await sleep(200);
      a.starts[0]?.onStop("button"); // 잔존 단추를 사람이 누름 → 잠금
      a.closeStart(0); // 그 직후 잔존이 끝남
      const t = textOf(await p);
      out.push(assert(
        "#R4-15 잔존 대기 중 사람 중지 → 다시 띄우지 않는다(기동 1회 그대로) · 본 입력 0 · 잠금",
        a.starts.length === 1 && mainPosts(a).length === 0 && handback(a) !== null,
        { starts: a.starts.length, posts: mainPosts(a).length, t: t.slice(0, 80) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-16 잔존만 있는 동안 찍은 그림에도 안내(세대 변화 없음) · 잔존이 끝난 뒤엔 없다
      const a = await arena({ readyPill: COVER, stuck: true });
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra()); // 은퇴 → 잔존
      const during = textOf(await T.look.handler({}, a.extra()));
      a.closeStart(0);
      await sleep(20);
      const after = textOf(await T.look.handler({}, a.extra()));
      out.push(assert("#R4-16 잔존만 있을 때 찍은 그림에 «표시 참고:» · 끝난 뒤엔 없음", during.includes("표시 참고:") && !after.includes("표시 참고:"), { during: during.includes("표시 참고:"), after: after.includes("표시 참고:") }));
      await a.plugin.stop();
    }
    {
      // R4-5 준비 줄이 안 오면: 상한까지 기다린 뒤 표시를 내리고 종료를 확인한 뒤 발사(단추가 발사 도중 나타나지 않게)
      const a = await arena({ readyPill: null });
      const T = a.tools("t1");
      const t0 = Date.now();
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const ms = Date.now() - t0;
      out.push(assert(
        "#R4-5 준비 없음: 약 2초(상한) 기다린 뒤 «준비 안 됨» 으로 내리고 종료 확인 → 발사 · 상한을 크게 넘기지 않는다",
        mainPosts(a).length === 1 && a.starts[0]?.stopped === true && a.lines.some((l) => l.includes("제어 표시 내림 — 준비 안 됨")) && ms >= 1900 && ms < 3500,
        { ms, lines: a.lines.filter((l) => l.includes("제어 표시")).slice(0, 3) },
      ));
      await a.plugin.stop();
    }
    {
      // R4-6 단추 없이 준비 → 바로 발사 · 키만 있는 열은 준비를 안 기다린다
      const a = await arena({ readyPill: "none" });
      const T = a.tools("t1");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      out.push(assert("#R4-6 단추 없이 준비: 비킴 요청 없이 발사 · 표시는 그대로", mainPosts(a).length === 1 && a.starts[0]?.stopped === false && a.starts[0] !== undefined && !existsSync(a.starts[0].moveFile), { posts: mainPosts(a).length }));
      await a.plugin.stop();
      const b = await arena({ readyPill: null });
      const U = b.tools("t1");
      const t0 = Date.now();
      await U.doTool.handler({ frameId: await b.frame(U.look), steps: [{ t: "keydown", key: "a" }, { t: "keyup", key: "a" }] }, b.extra());
      out.push(assert("#R4-6′ 누름 없는 열(키만)은 준비를 기다리지 않는다", Date.now() - t0 < 1500 && mainPosts(b).length === 1, { ms: Date.now() - t0 }));
      await b.plugin.stop();
    }
    {
      // R4-11 준비를 기다리는 동안 사람이 단추·Esc → 본 입력 0 · 중지 문구 / MCP 취소 → 바로 돌아오고 본 입력 0
      const a = await arena({ readyPill: null });
      const T = a.tools("t1");
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      await sleep(300);
      a.button();
      const t = textOf(await p);
      out.push(assert("#R4-11 준비 대기 중 중지 단추 → 본 입력 0 · 중지 머리 1회", mainPosts(a).length === 0 && count(t, HEAD) === 1, { posts: mainPosts(a).length, t: t.slice(0, 100) }));
      await a.plugin.stop();
      const b = await arena({ readyPill: null });
      const U = b.tools("t1");
      const ac = new AbortController();
      const t0 = Date.now();
      const q = U.doTool.handler({ frameId: await b.frame(U.look), steps: CLICK }, { signal: ac.signal });
      await sleep(300);
      ac.abort();
      const tq = textOf(await q);
      out.push(assert("#R4-11′ 준비 대기 중 MCP 취소 → 남은 대기를 버리고 곧 돌아온다 · 본 입력 0", mainPosts(b).length === 0 && tq.includes("조작이 취소되었습니다") && Date.now() - t0 < 1500, { ms: Date.now() - t0, tq: tq.slice(0, 80) }));
      await b.plugin.stop();
    }

    // ── #6a 대시보드 수신 시각 — 본문 대기 전에 찍는다 ───────────────────────────────
    {
      const chat = await loadPluginModule<{ handleMessages: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-chat.ts");
      let got: number | null = null;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        void chat.handleMessages({
          req, res, url, pathname: url.pathname, channelName: "http-bridge", bus: null, sseClients: new Set(),
          channelHandler: async (m: { receivedAt: number }) => { got = m.receivedAt; return undefined as never; },
        } as never);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      let mid = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const body = JSON.stringify({ text: "회귀용", threadKey: "regression:user-stop" });
          const req = http.request({ host: "127.0.0.1", port, path: "/messages", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => { res.resume(); res.on("end", () => resolve()); });
          req.on("error", reject);
          req.write(body.slice(0, 5));
          setTimeout(() => { mid = Date.now(); req.end(body.slice(5)); }, 300);
        });
        await until(() => got !== null, 2000);
      } finally {
        server.close();
      }
      out.push(assert("#6a 대시보드: receivedAt 는 본문이 다 오기 **전**(처리기 입구)의 시각이다", got !== null && (got as number) < mid, { got, mid }));
    }

    // ── #6a′ 텔레그램 선택지 — 폴링 응답 수신 시각(소스 모양 + poll-health 동작) ───────────
    {
      const tg = await fs.readFile(new URL("../../../plugins/telegram-channel/index.ts", import.meta.url), "utf8");
      const cb = /bot\.on\("callback_query:data"[\s\S]{0,12000}?\n    \}\);/.exec(tg)?.[0] ?? "";
      const atIdx = cb.indexOf("const at = arrivedAt();");
      const firstAwait = cb.indexOf("await ");
      const shape = {
        atBeforeAwait: atIdx >= 0 && firstAwait > atIdx,
        receivedAtAt: /receivedAt: at,/.test(cb),
        partArrivedAt: /batcher\.now\(chatId, \{[^}]*arrivedAt: at \}\)/.test(cb),
        fallbackIsStart: /const arrivedAt = \(\): number => pollHealth\.lastReceivedAt\(\) \?\? pollStartedAt;/.test(tg) &&
          tg.indexOf("const pollStartedAt = Date.now();") >= 0 && tg.indexOf("const pollStartedAt = Date.now();") < tg.indexOf("bot.start("),
      };
      out.push(assert("#6a′ 텔레그램 선택지: 첫 await 앞에서 arrivedAt() 를 잡아 receivedAt·부품 arrivedAt 에 쓰고, 기록 없을 때 대체값은 폴링 시작 시각", Object.values(shape).every(Boolean), shape));
      const { createPollHealth } = await loadPluginModule<{ createPollHealth: (log: (l: string) => void, now: () => number) => { begin(t?: number): number; ok(s: number, t?: number): void; lastReceivedAt(): number | null } }>("../../../plugins/telegram-channel/poll-health.ts");
      let clock = 5_000_000;
      const h = createPollHealth(() => {}, () => clock);
      const s = h.begin(30);
      clock += 1200;
      h.ok(s, 30);
      const okAt = clock;
      clock += 9000; // 앞 업데이트 처리(첨부 다운로드)로 시간이 흐른 뒤 읽는다
      out.push(assert("#6a′ 응답 수신 시각은 처리 지연에 안 밀린다(시계를 전진시킨 뒤 읽어도 응답 시각)", h.lastReceivedAt() === okAt, { got: h.lastReceivedAt(), okAt }));
    }

    // ── #6c 선택지 지연 분류 — 부품 arrivedAt 을 쓴다 · 문구가 출처를 단정하지 않는다 ─────────
    {
      const batch = await loadPluginModule<{ createInboundBatcher: (fire: (m: unknown) => Promise<void>) => { now(chatId: string, part: Rec): void }; LATE_DELIVERY_MS: number }>("../../../plugins/telegram-channel/inbound-batch.ts");
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
      try {
        const b = batch.createInboundBatcher(() => Promise.resolve());
        const A = Date.now() - batch.LATE_DELIVERY_MS - 20_000;
        b.now("c", { msg: Promise.resolve({ text: "버튼", receivedAt: A }), replyTo: undefined, stopTyping: () => {}, arrivedAt: A });
        await until(() => logs.some((l) => l.includes("늦은 전달")), 1500);
      } finally {
        console.log = orig;
      }
      const line = logs.find((l) => l.includes("늦은 전달")) ?? "";
      out.push(assert(
        "#6c 선택지 늦은 전달: 발신→도착 0초 · 도착→전달은 수신 시각부터 · 문구가 «텔레그램 발신» 으로 단정하지 않는다",
        /발신→도착 0초/.test(line) && /도착→전달 \d{2,}초/.test(line) && line.includes("버튼 답은 받은 시각"),
        line,
      ));
    }

    // ── #13 코어 — 사람 메시지 반영 이벤트가 receivedAt 를 싣는다(진입점 클로저라 소스 모양) ─────
    {
      const src = await fs.readFile(new URL("../../../src/index.ts", import.meta.url), "utf8");
      const start = src.indexOf("const publishInboundEcho = (");
      const echo = start < 0 ? "" : src.slice(start, src.indexOf("\n};\n", start));
      const human = echo.slice(echo.indexOf("if (msg.synthetic === true)"));
      const humanPayload = human.slice(human.indexOf("return;"));
      out.push(assert(
        "#13 코어: 사람 쪽 channel.message.in payload 에 채널 수신 시각 receivedAt 를 싣는다(합성 쪽엔 없다)",
        /\.\.\.\(typeof msg\.receivedAt === "number" \? \{ receivedAt: msg\.receivedAt \} : \{\}\)/.test(humanPayload) &&
          !/receivedAt/.test(human.slice(0, human.indexOf("return;"))) && /receivedAt\?: number;/.test(echo),
        { found: humanPayload.includes("receivedAt") },
      ));
    }

    // ══ Windows 확대 (2026-11-24 — 설계 `docs/decisions/2026-11-24-computer-use-indicator-esc-windows.md` §5) ══════════

    // ── #W1 제품 조립 — win32 에 표시부가 붙고, 그 표시부로 do 가 멈춤 요청 파일을 넘긴다 ─────────────
    {
      const idxW = idx as unknown as { wiringFor: (p: string) => Rec; createTools: (w: Rec) => Array<Rec> };
      const macM = await loadPluginModule<{ startIndicator: unknown }>("../../../plugins/computer-use/src/mac.ts");
      const winM = await loadPluginModule<{ startIndicator: unknown }>("../../../plugins/computer-use/src/win.ts");
      const w1 = idxW.wiringFor("win32");
      const w2 = idxW.wiringFor("win32");
      const wm = idxW.wiringFor("darwin");
      const wl = idxW.wiringFor("linux");
      const ind = (w: Rec): { backend: { start: unknown }; stopDir: string } | undefined => w["indicator"] as never;
      out.push(assert(
        "#W1 조립: win32 표시부 기동 = win.startIndicator · darwin = mac.startIndicator · linux 표시 없음 · 멈춤 폴더 = os.tmpdir() · 같은 플랫폼 두 번 조립 = 같은 표시·같은 데스크톱 · 플랫폼 간 표시는 다르다",
        ind(w1)?.backend.start === winM.startIndicator && ind(wm)?.backend.start === macM.startIndicator && wl["indicator"] === undefined &&
          ind(w1)?.stopDir === os.tmpdir() && w1["indicator"] === w2["indicator"] && w1["desktop"] === w2["desktop"] &&
          w1["indicator"] !== wm["indicator"] && w1["platform"] === "win32",
        { win: ind(w1)?.backend.start === winM.startIndicator, mac: ind(wm)?.backend.start === macM.startIndicator, linux: wl["indicator"] === undefined, same: w1["indicator"] === w2["indicator"] },
      ));
      // 관측·실행부만 가짜로 바꾸고 **조립이 만든 표시 상태**(멈춤 폴더·유휴)를 그대로 쓴다. 기동만 **결정적으로 실패**시킨다 —
      //  실제 기동을 두면 Windows 게스트에선 진짜 도우미가 뜨고(입력 0 검사가 화면을 건드린다) 맥에선 csc 부재에 기댄다(R1-1).
      //  기동 실패 사유 문구(«표시 도우미 컴파일 실패: csc-missing …»)는 `_win-indicator-build-child` W4(f) 가 제품 `win.startIndicator` 로 잰다.
      // 조립에 표시가 없으면(위 단언이 빨강) 이 판은 판 기본 표시부로 돈다 — 멈춤 폴더가 os.tmpdir() 이 아니라 아래도 빨강(검사가 던지지 않게).
      const assembled = w1["indicator"] as Rec | undefined;
      const failing: Rec | undefined =
        assembled === undefined ? undefined : { ...assembled, backend: { start: () => { throw new Error("합성 기동 실패(W1)"); } }, current: null, owner: null, timer: null };
      const a = await arena({ platform: "win32", ...(failing !== undefined ? { indicator: failing } : {}) });
      const T = a.tools("w1");
      const r = await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const sf = mainPosts(a)[0]?.opts?.stopFile ?? "";
      out.push(assert(
        "#W1 조립된 표시 상태로 do: 본 post 가 조립의 멈춤 폴더(os.tmpdir()) 안 stopFile 을 받는다 · 표시 기동이 실패해도 입력 1(비차단) · 머리 없음",
        failing?.["stopDir"] === os.tmpdir() && mainPosts(a).length === 1 && sf.startsWith(path.join(os.tmpdir(), "tiguclaw-cu-stop-")) &&
          a.lines.some((l) => l.includes("띄우지 못했습니다") && l.includes("합성 기동 실패(W1)")) && !textOf(r).includes(HEAD),
        { posts: mainPosts(a).length, sf },
      ));
      // 도구 설명 — 표시 있는 배선만 «티구클로 자신의 표시»(look)·`esc` 문장(do)
      // 설명 원문 — look 은 도구 설명, do 의 키 설명은 스키마 안(zod 는 설명을 직렬화에 안 싣는다 — 접근자로 읽는다).
      const descOf = (w: Rec): string => {
        const tools = idxW.createTools(w);
        const look = tools.find((t) => t["name"] === "look");
        const doT = tools.find((t) => t["name"] === "do") as { inputSchema?: { steps?: { element?: { shape?: { key?: { description?: string } } } } } } | undefined;
        return `${String(look?.["description"])}\n${String(doT?.inputSchema?.steps?.element?.shape?.key?.description)}`;
      };
      const withInd = descOf({ ...a.w });
      const noInd = descOf({ ...a.w, indicator: undefined });
      out.push(assert(
        "#W9 도구 설명: 표시 있는 배선에만 «티구클로 자신의 표시»(look) 와 «`esc` 는 사용자의 Esc 와 구별되지 않을 수 있습니다»(do 키)",
        withInd.includes("티구클로 자신의 표시") && withInd.includes("구별되지 않을 수 있습니다") &&
          !noInd.includes("티구클로 자신의 표시") && !noInd.includes("구별되지 않을 수 있습니다"),
        { withInd: withInd.includes("구별되지 않을 수 있습니다"), noInd: noInd.includes("구별되지 않을 수 있습니다") },
      ));
      await a.plugin.stop();
    }

    // ── #W2 공통 결정층 — 배선 플랫폼이 win32 여도 같은 계약(발사 중·발사 전·행동 사이·잠금) ──────────────
    {
      // (a) 발사 중 Esc → 멈춤 파일 생성 · 머리 1 · 멈춘 단계부터 미실행 · 해제 · 잠금 · 표시 내림
      const gate = deferred<Rec>();
      let stopPath = "";
      const a = await arena({
        platform: "win32",
        post: async (r) => {
          if (r.release) return { ok: true, fired: r.events.length, stdout: "" };
          stopPath = r.opts?.stopFile ?? "";
          return gate.promise;
        },
      });
      const T = a.tools("w2");
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: SHIFT_CLICK }, a.extra());
      await until(() => mainPosts(a).length === 1);
      a.esc();
      const fileSeen = stopPath !== "" && existsSync(stopPath);
      gate.resolve({ ok: true, fired: 1, stdout: '{"step":0}\n{"stopped":1,"why":"user-esc","saw":""}\n' });
      const t = textOf(await p);
      out.push(assert(
        "#W2(a) win32 발사 중 Esc: 멈춤 요청 파일이 생긴다 · 머리 1회(중립 — «사용자가 Esc» 아님, 구별 불가를 말한다) · 2번째부터 미실행(«중지 요청») · 해제 post 1 · 잠금 · 표시 내림",
        fileSeen && count(t, HEAD) === 1 && t.includes("구별되지 않습니다") && !/사용자가 Esc|사용자의 Esc 멈춤/.test(t) &&
          t.includes("2번째부터 입력을 보내지 않았습니다 — 중지 요청을 받았습니다") && count(t, "[미실행]") === 2 &&
          a.posts.filter((x) => x.release).length === 1 && handback(a) !== null && a.starts[0]!.stopped,
        { fileSeen, heads: count(t, HEAD), t: t.slice(0, 300) },
      ));
      // (d) 잠금 — 다른 소유자도 거절(입력 0) · 거절문 중립 · 수신이 Esc 뒤인 사람 메시지 뒤에만 다시 된다
      const atMs = (handback(a) as { atMs: number }).atMs;
      const before = mainPosts(a).length;
      const O = a.tools("w2-other");
      const rO = await O.doTool.handler({ frameId: await a.frame(O.look), steps: CLICK }, a.extra());
      a.emit({ channel: "telegram", threadKey: "w2", text: "Esc 전", receivedAt: atMs });
      const stillLocked = handback(a) !== null;
      a.emit({ channel: "telegram", threadKey: "w2", text: "Esc 뒤", receivedAt: atMs + 1 });
      const rAfter = await O.doTool.handler({ frameId: await a.frame(O.look), steps: CLICK }, a.extra());
      out.push(assert(
        "#W2(d) win32 잠금: 다른 소유자 do 거절(입력 0) · 거절문이 «중지 요청(…)으로 조작이 멈추고» 로 사람을 단정하지 않는다 · 같은 시각 메시지는 못 풀고 뒤 메시지는 푼다",
        /중지 요청\(화면 표시의 중지 단추 또는 Esc\)으로 조작이 멈추고/.test(textOf(rO)) && !/사용자가 Esc/.test(textOf(rO)) && stillLocked && handback(a) === null &&
          mainPosts(a).length === before + 1 && !textOf(rAfter).includes(HEAD),
        { rO: textOf(rO).slice(0, 80), stillLocked, after: mainPosts(a).length - before },
      ));
      await a.plugin.stop();
    }
    {
      // (b) 발사 전 Esc(이전 해제분 갚기 post 를 붙잡은 채) → 본 입력 0 · 중립 문구
      const gate = deferred<Rec>();
      const a = await arena({ platform: "win32", post: (r) => (r.release ? gate.promise : Promise.resolve({ ok: true, fired: r.events.length, stdout: "" })) });
      const T = a.tools("w2b");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      (a.desktop["held"] as { keys: string[] }).keys.push("shift");
      const before = mainPosts(a).length;
      const p = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      await until(() => a.posts.some((x) => x.release));
      a.esc();
      gate.resolve({ ok: true, fired: 1, stdout: "" });
      const t = textOf(await p);
      out.push(assert(
        "#W2(b) win32 발사 전 Esc: 본 입력 0 · «중지 요청이 감지되어 입력을 보내지 않았습니다» · 머리 1회",
        mainPosts(a).length === before && t.includes("중지 요청이 감지되어 입력을 보내지 않았습니다") && count(t, HEAD) === 1 && !/사용자가 Esc/.test(t),
        { main: mainPosts(a).length - before, t: t.slice(0, 200) },
      ));
      await a.plugin.stop();
    }
    {
      // (c) 행동 사이 Esc → 남은 장부 해제 post 1 · 그 사이 잠금이 풀려도 새 do 입력 0(busy-other) · 장부 빔
      const gate = deferred<Rec>();
      let hold = false;
      const a = await arena({ platform: "win32", post: (r) => (r.release && hold ? gate.promise : Promise.resolve({ ok: true, fired: r.events.length, stdout: "" })) });
      const T = a.tools("w2c");
      await T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      (a.desktop["held"] as { keys: string[]; buttons: string[] }).keys.push("shift");
      (a.desktop["held"] as { keys: string[]; buttons: string[] }).buttons.push("left");
      hold = true;
      const before = a.posts.length;
      a.esc();
      await until(() => a.posts.length === before + 1);
      a.emit({ channel: "dashboard", threadKey: "w2c", text: "계속", receivedAt: (handback(a) as { atMs: number }).atMs + 5 });
      const rp = T.doTool.handler({ frameId: await a.frame(T.look), steps: CLICK }, a.extra());
      const raced = await Promise.race([rp, sleep(1500).then(() => null)]);
      const mainDuring = mainPosts(a).length;
      gate.resolve({ ok: true, fired: 2, stdout: "" });
      await until(() => a.desktop["active"] === null);
      const rel = a.posts.slice(before).filter((x) => x.release);
      const held = a.desktop["held"] as { keys: string[]; buttons: string[] };
      out.push(assert(
        "#W2(c) win32 행동 사이 Esc: 남은 키·버튼 해제 post 1(keyup shift·mouseup left) · 그 사이 새 do 입력 0(사용 중) · 해제 뒤 장부 빔",
        rel.length === 1 && rel[0]!.events.some((e) => e["t"] === "keyup" && e["key"] === "shift") && rel[0]!.events.some((e) => e["t"] === "mouseup") &&
          raced !== null && mainDuring === 1 && /사용 중/.test(textOf(raced)) && held.keys.length === 0 && held.buttons.length === 0,
        { rel: rel.map((x) => x.events), mainDuring, held },
      ));
      await a.plugin.stop();
    }

    // ── #W3 도우미 출력 프로토콜 — 맥·Windows 공통 감시기 ─────────────────────────────────────
    {
      const { watchIndicatorChild } = await loadPluginModule<{ watchIndicatorChild: (c: unknown, o: { onStop: (via: string) => void; onGone: (w: string) => void; onReady?: (pill: unknown) => void; onPill?: (pill: unknown, req: string) => void }) => { stop(): void; closed: Promise<void> } }>("../../../plugins/computer-use/src/indicator.ts");
      const mk = (): EventEmitter & { stdout: PassThrough; kills: number; kill: () => void } => {
        const c = new EventEmitter() as EventEmitter & { stdout: PassThrough; kills: number; kill: () => void };
        c.stdout = new PassThrough();
        c.kills = 0;
        c.kill = () => { c.kills += 1; };
        return c;
      };
      const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
      const c = mk();
      let escs = 0;
      let buttons = 0;
      const readies: unknown[] = [];
      const pills: unknown[] = [];
      const gone: string[] = [];
      const h = watchIndicatorChild(c, { onStop: (via) => { if (via === "esc") escs += 1; else if (via === "button") buttons += 1; }, onGone: (w) => gone.push(w), onReady: (p) => readies.push(p), onPill: (p, r) => pills.push([p, r]) });
      let closedSeen = false;
      void h.closed.then(() => { closedSeen = true; });
      c.stdout.write('{"ready":1,"dry":1}\n{"ready":1,"pill":{"x":1,"y":2,"w":3,"h":4}}\n{"pill":null,"req":"r1;"}\n{"es');
      c.stdout.write('c":1}\n모르는 줄\nnull\n{"esc":1}\n{"stop":1}\n');
      await tick();
      c.emit("exit", 1, null); // exit 가 마지막 stdout 보다 먼저 온다
      c.stdout.write('{"error":"합성 오류 — 창을 못 만듦","type":"System.ComponentModel.Win32Exception"}\n');
      await tick();
      const beforeClose = gone.length;
      c.emit("close", 1, null);
      h.stop();
      h.stop();
      await tick();
      out.push(assert(
        "#W3 감시기: 쪼개진 줄을 이어 읽어 esc 2회 · 중지 단추 줄(`{\"stop\":1}`)은 onStop(\"button\") 1회 · 준비 줄은 onReady(실제 사각형) — 빈 연습 준비는 넘기지 않음 · 비킴 응답 줄은 onPill(사각형|null, 요청) · close 에서 closed 풀림 · 모르는 줄·null 무시 · 오류 줄은 멈춤이 아니다 · exit 뒤에 온 마지막 오류 줄까지 close 에서 사유로(«표시 도우미 종료(1): 합성 오류 …») · onGone 1회 · stop 두 번에 kill 1",
        escs === 2 && buttons === 1 && JSON.stringify(readies) === '[{"x":1,"y":2,"w":3,"h":4}]' && JSON.stringify(pills) === '[[null,"r1;"]]' &&
          beforeClose === 0 && closedSeen && gone.length === 1 && gone[0]!.includes("표시 도우미 종료(1)") && gone[0]!.includes("합성 오류") &&
          gone[0]!.includes("Win32Exception") && c.kills === 1,
        { escs, buttons, readies, pills, closedSeen, gone, kills: c.kills },
      ));
      // UTF-8 한 글자 **가운데**에서 잘린 오류 줄 — 청크마다 따로 디코딩하면 한글이 깨진다(StringDecoder 가 이어 붙여야 한다).
      const cu = mk();
      const goneU: string[] = [];
      watchIndicatorChild(cu, { onStop: () => {}, onGone: (w) => goneU.push(w) });
      const bytes = Buffer.from('{"error":"창을 만들지 못함"}\n', "utf8");
      const cut = bytes.indexOf(Buffer.from("만", "utf8")) + 1; // «만» 의 첫 바이트 뒤
      cu.stdout.write(bytes.subarray(0, cut));
      await tick();
      cu.stdout.write(bytes.subarray(cut));
      await tick();
      cu.emit("close", 1, null);
      out.push(assert(
        "#W3 감시기: UTF-8 글자 가운데서 잘린 오류 줄도 원문 그대로(«창을 만들지 못함») 종료 사유에 싣는다",
        goneU.length === 1 && goneU[0]!.includes("창을 만들지 못함") && !goneU[0]!.includes("�"),
        goneU,
      ));
      // 이미 뜬 자식(pid 있음)의 error — 신호 전달 실패 등 — 는 끝남이 아니다: closed·onGone 모두 close 까지 기다린다.
      const cp = mk() as ReturnType<typeof mk> & { pid?: number };
      cp.pid = 4242;
      const goneP: string[] = [];
      let closedP = false;
      const hp = watchIndicatorChild(cp, { onStop: () => {}, onGone: (w) => goneP.push(w) });
      void hp.closed.then(() => { closedP = true; });
      cp.emit("error", new Error("kill EPERM"));
      await tick();
      const midP = { gone: goneP.length, closed: closedP };
      cp.emit("close", null, "SIGKILL");
      await tick();
      out.push(assert(
        "#W3 이미 뜬 자식의 error(신호 전달 실패 등)는 끝남이 아니다 — close 전엔 closed·onGone 없음 · close 뒤 둘 다(사유에 그 오류)",
        midP.gone === 0 && !midP.closed && goneP.length === 1 && closedP && goneP[0]!.includes("프로세스 오류"),
        { midP, goneP, closedP },
      ));
      const c2 = mk();
      const gone2: string[] = [];
      watchIndicatorChild(c2, { onStop: () => {}, onGone: (w) => gone2.push(w) });
      c2.emit("error", new Error("spawn C:\\Users\\x\\tiguclaw-indicator-abc.exe EPERM"));
      c2.emit("close", -4048, null);
      out.push(assert(
        "#W3 기동 거부: error(EPERM) → close 에서 onGone 1회 · 그 사유가 «표시 도우미 기동 실패» 와 EPERM 을 둘 다 담는다(일반 종료로 오보하지 않는다)",
        gone2.length === 1 && gone2[0]!.includes("표시 도우미 기동 실패") && gone2[0]!.includes("EPERM"),
        gone2,
      ));
    }

    // ── #G0 가장자리 빛 정본 값 = 정태님이 고른 시안 — 두 도우미가 이 한 곳을 쓰므로, 여기가 바뀌면 두 플랫폼 검사가 함께 따라간다.
    //  그래서 시안 값 자체를 **따로** 박아 둔다(참고 시안 `render.js` wide 분기: 폭 58 · 알파 .71 · 지수 2.1 · 색 sRGB(1, .60, .17) → 8비트 255·153·43).
    {
      const { GLOW, glowAlphaAt } = await loadPluginModule<{ GLOW: { width: number; alpha: number; falloff: number; rgb: readonly number[] }; glowAlphaAt: (d: number) => number }>("../../../plugins/computer-use/src/indicator.ts");
      out.push(assert(
        "★#G0 가장자리 빛 정본 = 확정 시안(폭 58 · 가장자리 알파 0.71 · 지수 2.1 · RGB 255·153·43) · 안쪽으로 줄고 폭 밖은 0",
        GLOW.width === 58 && GLOW.alpha === 0.71 && GLOW.falloff === 2.1 && GLOW.rgb.join() === "255,153,43" &&
          Math.abs(glowAlphaAt(0) - 0.71) < 1e-9 && Math.abs(glowAlphaAt(29) - 0.71 * 0.5 ** 2.1) < 1e-9 && glowAlphaAt(57) > 0 && glowAlphaAt(58) === 0 && glowAlphaAt(1000) === 0,
        GLOW,
      ));
    }

    // ── #W9 사용자에게 닿는 표시 문구 — 행동 안내(단추)만 · 대화창 /stop 안내는 뺐다(⑤ 외형 확정 — /stop 자체는 그대로 동작) · 보장 못 하는 Esc 는 안내하지 않는다(⑤ r4) ──
    {
      const cat = async (lang: string): Promise<string> =>
        (JSON.parse(await fs.readFile(new URL(`../../../locales/${lang}.json`, import.meta.url), "utf8")) as Record<string, string>)["srv.computerUse.indicator"] ?? "";
      const ko = await cat("ko");
      const en = await cat("en");
      out.push(assert(
        "#W9 표시 문구(ko·en): 단추를 누르라는 안내만 · 대화창 «/stop» 안내는 없다 · Esc 는 안내하지 않는다(원격 Esc 는 HID 상태에 안 남아 감지 보장이 없다) · «누르면 멈춥니다» 같은 결과 보장이 아니다",
        ko.includes("눌러") && !ko.includes("/stop") && !ko.includes("대화창") && !/esc/i.test(ko) && !ko.includes("누르면 멈춥니다") &&
          /\bclick here\b/.test(en) && !en.includes("/stop") && !/\bchat\b/.test(en) && !/esc/i.test(en) && !/press Esc to stop/.test(en),
        { ko, en },
      ));
    }

    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stopDirOk, { recursive: true, force: true }).catch(() => {});
    return out;
  },
};
