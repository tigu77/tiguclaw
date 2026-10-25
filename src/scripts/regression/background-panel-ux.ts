/**
 * 회귀: **백그라운드 위젯·패널 UX** (2026-10-23, [설계](../../../docs/decisions/2026-10-23-background-panel-ux.md) v3 ⑪).
 *
 * 사용자 요청 넷 + 완료 시간 고정:
 *  ① 위젯 기본 = **세션별**(대화 머리 줄만 줄을 차지, 종류는 아이콘 + 종류가 바뀌는 자리의 얇은 선) · 메뉴로 종류별 전환(기억)
 *  ② 위젯 항목을 누르면 패널의 그 카드 **윗변**으로 — **안 펼친다**(프로젝트 상세는 지금처럼 펼침) · 이동 뒤 따라가기가 끌고 가지 않는다 ·
 *     셸 목록을 다시 그려도 읽던 자리를 지킨다
 *  ③ 매니저/에이전트 행 오른쪽 경과시간 — **생산자**(`worker.*`)가 `startedAt` 을 싣는다(종전엔 실시간 잡은 빈칸)
 *  ④ 셸 이름 = Bash `description` — 생산·저장·조회·리퍼·위젯·카드가 한 값 · 없으면 지금 표시 그대로
 *  ⑤ 끝난 잡·셸 카드는 **서버가 아는 끝 시각**에서 멈춘다(다시 그려도 안 자란다) · 시작 시각도 서버 값이 이긴다
 *  ⑥ 잡 카드 «지금 하는 일»(진행 도구) 한 줄은 도는 카드에만 — 끝나면 실시간 화면도 새로고침 뒤와 같게 꺼진다
 *  ⑦ 셸 카드 맨 윗줄 — 설명이 있으면 세션 배지가 먼저 줄어 설명 자리를 낸다(설명 없는 카드는 그대로)
 *
 * 등급: **동작** — ③④⑤의 생산은 진짜 코어 함수(격리 홈 DB·버스·실제 셸), 화면은 실제 대시보드·플러그인 파일을 미니 DOM 에 싣는다.
 *  미니 DOM 엔 레이아웃이 없어 «화면에 보이나» 는 헤드리스로 잰다 — 여기선 그 결과를 만드는 값(정렬량·래치·보정량)을 잰다.
 */
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";
import { mountWidget } from "./background-work-widget.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const KO = JSON.parse(readFileSync(path.join(REPO, "plugins/running-work/web/locales/ko.json"), "utf8")) as Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Handler = (a: unknown, x: unknown) => Promise<{ content: Array<{ text?: string }> }>;
type Tools = Record<string, { handler?: Handler }>;
type Ev = { type: string; payload: Record<string, any> };

export const check: RegressionCheck = {
  name: "background-panel-ux",
  guards:
    "백그라운드 위젯·패널 UX(10-23) — 실시간 매니저 경과 빈칸 · 셸 설명이 버려짐/뒤 통지가 지움 · 위젯 이동이 카드를 펼침·끝 쪽 카드가 끌려감·셸 재그리기에 밀림 · 끝난 카드 경과가 다시 그릴 때마다 자람·화면 시각을 시작으로 써 0s 로 굳음 · 세션별 보기의 종류 구분 · 끝난 잡 카드에 멈춘 «Bash N째» 가 남음(새로고침하면 없음) · 셸 설명이 세션 배지에 밀려 7~8자만 보임",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { getEventBus } = await import("../../core/eventbus.js");
    const wj = await import("../../core/worker-jobs.js");
    const fo = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
    const { insertBgShell } = await import("../../store/bg-shells.js");
    const { getDb } = await import("../../store/sessions.js");
    const seen: Ev[] = [];
    const unsub = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
      if (typeof e.type === "string" && (e.type.startsWith("worker.") || e.type.startsWith("shell."))) seen.push({ type: e.type, payload: (e.payload ?? {}) as Record<string, any> });
    });
    const evOf = (type: string, key: "jobId" | "shellId", id: string): Ev | undefined => seen.find((e) => e.type === type && e.payload[key] === id);

    // ── ③⑤ 생산자: worker.* 에 시작·끝 시각 ─────────────────────────────────────
    let startedPayload: Record<string, any> | undefined;
    try {
      const reg = (label: string) => wj.registerJob({ label, task: "t", threadKey: "dashboard:regr-bgux", channel: "dashboard" as never, channelUserId: "u", kind: "agent", agentName: "regr" });
      const a = reg("완료될 잡");
      const b = reg("실패할 잡");
      const c = reg("취소될 잡");
      wj.markDone(a, "ok");
      wj.markFailed(b, "boom");
      wj.markCancelled(c, "stop");
      const ja = wj.getJob(a)!, jb = wj.getJob(b)!, jc = wj.getJob(c)!;
      startedPayload = evOf("worker.started", "jobId", a)?.payload;
      const fin = [["worker.done", a, ja], ["worker.failed", b, jb], ["worker.cancelled", c, jc]].map(([t, id, j]) => {
        const p = evOf(t as string, "jobId", id as string)?.payload ?? {};
        return { t, start: p.startedAt === (j as any).startedAt, fin: typeof p.finishedAt === "number" && p.finishedAt === (j as any).finishedAt };
      });
      out.push(
        assert(
          "★★생산자: `worker.started` 가 서버 시작 시각을 싣는다(종전엔 없어 실시간 잡은 위젯 경과가 빈칸) · 종료 셋은 시작·끝 시각을 잡 기록과 같은 값으로",
          typeof startedPayload?.startedAt === "number" && startedPayload.startedAt === ja.startedAt && !("finishedAt" in (startedPayload ?? {})) && fin.every((f) => f.start && f.fin),
          { started: startedPayload && { startedAt: startedPayload.startedAt, has끝: "finishedAt" in startedPayload }, fin },
        ),
      );

      // ── ④⑤ 생산자: 셸 설명·끝 시각 ─────────────────────────────────────────────
      const tools = ((fo.createFileOpsMcpServer(process.cwd(), "regr:bgux") as unknown as { instance?: { _registeredTools?: Tools } }).instance?._registeredTools ?? {}) as Tools;
      const bash = async (args: Record<string, unknown>): Promise<string> => {
        const r = await tools.Bash!.handler!({ run_in_background: true, ...args }, {});
        return /bash_id: ([\w-]+)/.exec((r.content ?? []).map((x) => x.text ?? "").join(""))?.[1] ?? "";
      };
      const node = (js: string) => `"${process.execPath}" -e "${js}"`;
      const KEEP = node("setTimeout(()=>{},30000)");
      const s1 = await bash({ command: KEEP, description: "  개발 서버 띄우기  " });
      const sBlank = await bash({ command: KEEP, description: "   " });
      const long = "가".repeat(199) + "😀나";
      const sLong = await bash({ command: KEEP, description: long });
      const sQuick = await bash({ command: node("1"), description: "빠른 끝" });
      const run = await fo.startBackgroundShell(node("1"), process.cwd(), "regr:bgux-run");
      const started1 = evOf("shell.started", "shellId", s1)?.payload ?? {};
      const snap1 = fo.listShells().find((x) => x.shellId === s1);
      await fo.killShellById(s1);
      await fo.killShellById(sBlank);
      await fo.killShellById(sLong);
      await run.done;
      for (let i = 0; i < 100 && !evOf("shell.exited", "shellId", sQuick); i++) await sleep(30);
      const exited1 = evOf("shell.exited", "shellId", s1)?.payload ?? {};
      const exitedQuick = evOf("shell.exited", "shellId", sQuick)?.payload ?? {};
      const snapEnded = fo.listShells().find((x) => x.shellId === s1);
      const row = (id: string) => getDb().prepare(`SELECT finished_at AS f, description AS d FROM bg_shells WHERE bash_id = ?`).get(id) as { f: number | null; d: string | null } | undefined;
      const longGot = evOf("shell.started", "shellId", sLong)?.payload.description as string | undefined;
      out.push(
        assert(
          "★★셸 설명: 앞뒤 공백을 걷어 `shell.started`·`listShells()`·`shell.exited`·DB 행이 같은 이름 · 진행 중엔 끝 시각 없음",
          started1.description === "개발 서버 띄우기" && snap1?.description === "개발 서버 띄우기" && exited1.description === "개발 서버 띄우기" &&
            row(s1)?.d === "개발 서버 띄우기" && !("finishedAt" in started1) && snap1?.finishedAt === undefined,
          { started: started1.description, snap: snap1?.description, exited: exited1.description, db: row(s1)?.d },
        ),
      );
      out.push(
        assert(
          "공백뿐인 설명은 없음(필드 자체가 없다 — 빈 문자열로 싣지 않는다) · 201자는 200자(코드 포인트, 이모지를 반으로 안 자른다) · `run:` 셸은 설명 없음",
          !("description" in (evOf("shell.started", "shellId", sBlank)?.payload ?? {})) && row(sBlank)?.d === null &&
            longGot !== undefined && [...longGot].length === 200 && longGot.endsWith("😀") &&
            !("description" in (evOf("shell.started", "shellId", run.shellId)?.payload ?? {})),
          { blank: evOf("shell.started", "shellId", sBlank)?.payload.description, longLen: longGot ? [...longGot].length : null, run: evOf("shell.started", "shellId", run.shellId)?.payload.description },
        ),
      );
      out.push(
        assert(
          "★★셸 끝 시각: 강제 종료·자연 종료 모두 `shell.exited.finishedAt` = DB `finished_at` = `listShells()` 의 값(한 번 잰 값을 셋에 쓴다)",
          typeof exited1.finishedAt === "number" && exited1.finishedAt === row(s1)?.f && snapEnded?.finishedAt === exited1.finishedAt &&
            typeof exitedQuick.finishedAt === "number" && exitedQuick.finishedAt === row(sQuick)?.f && exitedQuick.description === "빠른 끝",
          { killed: [exited1.finishedAt, row(s1)?.f, snapEnded?.finishedAt], quick: [exitedQuick.finishedAt, row(sQuick)?.f, exitedQuick.description] },
        ),
      );

      // 데몬 종료(`killAllBgShells`) — 셸이 끝나는 또 하나의 출구. 설명·끝 시각이 다른 출구와 같은 규칙이어야 한다(적대 검토 10-23 A-1:
      //  이 출구에서 설명을 빼거나 끝 시각만 60초 밀어도 전체 초록이던 것).
      const sAll = await bash({ command: KEEP, description: "종료 때 정리" });
      const sAllBare = await bash({ command: KEEP });
      await fo.killAllBgShells();
      const exAll = evOf("shell.exited", "shellId", sAll)?.payload ?? {};
      const exAllBare = evOf("shell.exited", "shellId", sAllBare)?.payload ?? {};
      out.push(
        assert(
          "★데몬 종료 출구도 `shell.exited` 의 설명·끝 시각 = DB 행(한 번 잰 값) · 설명 없는 셸은 필드 없음",
          exAll.status === "killed" && exAll.description === "종료 때 정리" && row(sAll)?.d === "종료 때 정리" &&
            typeof exAll.finishedAt === "number" && exAll.finishedAt === row(sAll)?.f &&
            exAllBare.status === "killed" && !("description" in exAllBare) && typeof exAllBare.finishedAt === "number" && exAllBare.finishedAt === row(sAllBare)?.f,
          { all: [exAll.description, row(sAll)?.d, exAll.finishedAt, row(sAll)?.f], bare: [exAllBare.description, exAllBare.finishedAt, row(sAllBare)?.f] },
        ),
      );

      // 리퍼 — 재시작 뒤 새로 연 화면은 리퍼 통지로 종료 카드를 만든다. 설명은 DB 행에서 온다 · 이미 없던 프로세스(stale)는 끝 시각을 모른다.
      const ghostA = `bash_bgux_a_${process.pid}`, ghostB = `bash_bgux_b_${process.pid}`;
      insertBgShell({ bashId: ghostA, pid: 999_997, pgid: 999_997, command: "old-a", cwd: process.cwd(), startedAt: Date.now() - 90_000, description: "이전 세대 서버" });
      insertBgShell({ bashId: ghostB, pid: 999_998, pgid: 999_998, command: "old-b", cwd: process.cwd(), startedAt: Date.now() - 90_000 });
      await fo.reapPreviousGeneration();
      const ra = evOf("shell.exited", "shellId", ghostA)?.payload ?? {};
      const rb = evOf("shell.exited", "shellId", ghostB)?.payload ?? {};
      const cols = (getDb().prepare(`PRAGMA table_info(bg_shells)`).all() as Array<{ name: string }>).map((c) => c.name);
      out.push(
        assert(
          "★리퍼 통지에 DB 행의 설명이 실린다(설명 없는 옛 꼴 행은 필드 없음) · stale 은 끝 시각을 싣지 않는다(언제 끝났는지 모른다) · 열은 생성문 밖의 멱등 ALTER 로 생긴다",
          ra.description === "이전 세대 서버" && !("description" in rb) && !("finishedAt" in ra) && !("finishedAt" in rb) && cols.includes("description"),
          { a: { d: ra.description, f: ra.finishedAt }, b: { d: rb.description }, cols },
        ),
      );
    } finally {
      if (typeof unsub === "function") unsub();
    }

    // ── 화면(패널) ────────────────────────────────────────────────────────────
    const clock = makeClock();
    const BASE = Date.now();
    const ClockDate = class extends Date { static now(): number { return BASE + clock.now(); } };
    let seedShells: unknown[] = [];
    const dash = bootDashboard({
      clock, i18n: i18nForContext, upTo: "tabs.js", allIds: true, extra: { Date: ClockDate },
      fetch: async (url: string) => (url.startsWith("/api/shells") ? jsonResponse({ shells: seedShells }) : jsonResponse({}, 404)),
    });
    await clock.advance(20);
    const R = (code: string): any => dash.run(code);
    const fmt = (ms: number): string => R(`fmtElapsed(${ms})`);

    // ③ 생산자 → 리소스 → 위젯: 실제 `worker.started` 페이로드를 그대로 화면 리소스에 → 위젯 행에 «N분째»
    {
      const res = R(`applyJobEvent([], ${JSON.stringify({ ...startedPayload, startedAt: (startedPayload?.startedAt ?? 0) - 7 * 60000 })})`);
      const w = mountWidget(undefined, { view: null, sessionName: () => "회귀" });
      w.push("running-work", res);
      w.push("bg-shells", []);
      w.push("bg-timers", []);
      out.push(assert("★★생산자 페이로드 → `applyJobEvent` → 위젯: 실시간으로 시작된 잡도 오른쪽에 «N분째»", JSON.stringify(w.text(".rw-since")) === JSON.stringify(["7분째"]), w.text(".rw-since")));
    }

    // ⑤ 잡: 활동이 먼저 만든 카드 → 서버 시작 시각이 이긴다 → 끝 시각에서 멈춘다(드로어·buildAgentCard 둘 다)
    {
      const S = BASE - 10 * 60000;
      R(`handleWorkerActivity({ threadKey: "agent:jx", kind: "tool", label: "Read" }, "")`);
      const before = R(`jobCards.get("jx").startTs`);
      R(`handleWorkerEvent({ jobId: "jx", status: "running", kind: "agent", label: "x", task: "t", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default", startedAt: ${S} }, "")`);
      const corrected = R(`jobCards.get("jx").startTs`);
      R(`handleWorkerEvent({ jobId: "jx", status: "done", kind: "agent", label: "x", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default", startedAt: ${S}, finishedAt: ${S + 90000} }, "")`);
      const drawer1 = R(`jobCards.get("jx").elapsedEl.textContent`);
      await clock.advance(5000);
      R(`tickElapsed()`);
      const drawer2 = R(`jobCards.get("jx").elapsedEl.textContent`);
      const agentCard = R(`buildAgentCard("jx", jobCards.get("jx"), Date.now(), null, { compact: true }).querySelector(".agent-card-elapsed").textContent`);
      out.push(
        assert(
          "★★잡: 활동이 먼저 만든 카드도 서버 시작 시각으로 고쳐지고(종전엔 화면 시각 → 끝 − 시작 음수 → 0s) · 끝나면 `finishedAt − startedAt` 에서 멈춘다 — 드로어·에이전트 뷰/프로젝트 상세 카드 모두, 시계가 흘러도",
          before !== S && corrected === S && drawer1 === fmt(90000) && drawer2 === fmt(90000) && agentCard === fmt(90000),
          { before, corrected, S, drawer1, drawer2, agentCard, want: fmt(90000) },
        ),
      );
      // 끝 시각을 모르는 종료 → 처음 본 때로 멈춤 → 뒤에 온 서버 값이 덮음 → 다시 돌면 흐른다
      const t0 = R(`Date.now()`) as number;
      R(`handleWorkerEvent({ jobId: "jy", status: "running", kind: "worker", label: "y", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default", startedAt: ${t0} }, "")`);
      await clock.advance(3000);
      R(`handleWorkerEvent({ jobId: "jy", status: "interrupted" }, "")`);
      await clock.advance(4000);
      const guess = R(`buildAgentCard("jy", jobCards.get("jy"), Date.now(), null, { compact: true }).querySelector(".agent-card-elapsed").textContent`);
      R(`handleWorkerEvent({ jobId: "jy", status: "interrupted", fromServer: true, startedAt: ${t0}, finishedAt: ${t0 + 1000} }, "")`);
      const server = R(`buildAgentCard("jy", jobCards.get("jy"), Date.now(), null, { compact: true }).querySelector(".agent-card-elapsed").textContent`);
      R(`handleWorkerEvent({ jobId: "jy", status: "running", fromServer: true, startedAt: ${t0} }, "")`);
      await clock.advance(2000);
      const revived = R(`buildAgentCard("jy", jobCards.get("jy"), Date.now(), null, { compact: true }).querySelector(".agent-card-elapsed").textContent`);
      out.push(
        assert(
          "끝 시각을 모르는 종료는 처음 끝난 걸 본 때로 멈추고(더 안 자란다) · 뒤에 온 서버 `finishedAt` 이 덮는다 · 서버가 다시 «running» 이라 하면 다시 흐른다",
          guess === fmt(3000) && server === fmt(1000) && revived === fmt(9000),
          { guess, server, revived },
        ),
      );
    }

    // ⑥ 잡 카드 «지금 무엇을 하는 중» 한 줄의 수명 — 도는 카드에만 산다(10-23 실측: 끝난 카드에 «· Bash 37s째» 가 멈춘 채 남고
    //  새로고침하면 사라졌다). 재료는 실제 처리기(`handleWorkerEvent` — SSE·하이드레이션·단건 조회가 모두 지나는 곳)와 1초 틱.
    {
      const tk = "dashboard:default";
      const act = (since: number) => ({ lastActivityAt: since, inFlight: [{ tool: "Bash", since }] });
      const doing = (id: string) => R(`(() => { const e = jobCards.get(${JSON.stringify(id)}); return { shown: e.doingEl.style.display !== "none", text: e.doingEl.textContent, act: e.activity }; })()`);
      const ev = (p: Record<string, unknown>) => R(`handleWorkerEvent(${JSON.stringify(p)}, "")`);
      const base = { kind: "worker", label: "d", threadKey: tk, ownerThreadKey: tk };
      const t0 = R(`Date.now()`) as number;
      ev({ jobId: "dj", status: "running", ...base, startedAt: t0, fromServer: true, activity: act(t0) }); // 하이드레이션(스냅샷)
      const first = doing("dj");
      await clock.advance(5000);
      const running = doing("dj");
      ev({ jobId: "dj", status: "running", ...base }); // 값 없는 running(SSE replay) — 덮지 않는다
      const kept = doing("dj");
      ev({ jobId: "dj", status: "done", ...base, finishedAt: t0 + 6000, result: "ok" }); // SSE worker.done
      const done = doing("dj");
      ev({ jobId: "dj", status: "running", ...base, startedAt: t0, activity: act(t0) }); // 늦게 온 옛 running 스냅샷
      ev({ jobId: "dj", status: "running", ...base, startedAt: t0, fromServer: true, activity: act(t0) });
      await clock.advance(3000);
      const stale = doing("dj");
      const terminal: Record<string, unknown> = {};
      for (const st of ["failed", "cancelled", "interrupted"]) {
        const id = `dj-${st}`;
        ev({ jobId: id, status: "running", ...base, startedAt: t0, fromServer: true, activity: act(t0) });
        ev({ jobId: id, status: st, ...base, ...(st === "interrupted" ? {} : { error: "x" }) });
        terminal[st] = doing(id);
      }
      ev({ jobId: "dj-interrupted", status: "running", ...base, startedAt: t0, fromServer: true, activity: act(t0) }); // 서버가 «아직 돈다» — 추측을 덮는다
      const revived = doing("dj-interrupted");
      // 도구 사이(진행 중 도구 없음) — «마지막 활동 N 전» 으로 보인다(도는 카드의 다른 모양 · 사냥 구멍 1)
      ev({ jobId: "dj-idle", status: "running", ...base, startedAt: t0, fromServer: true, activity: { lastActivityAt: t0, inFlight: [] } });
      const idle = doing("dj-idle");
      const idleWant = R(`i18n("bg.lastActivity", { ago: fmtElapsed(Date.now() - ${t0}) })`) as string;
      ev({ jobId: "dj-idle", status: "done", ...base, finishedAt: t0 + 9000, result: "ok" });
      const idleDone = doing("dj-idle");
      out.push(
        assert(
          "★★잡 카드 «지금 하는 일» 한 줄은 도는 카드에만 — 스냅샷으로 «Bash N째» 가 보이고(시계로 흐름) · 값 없는 running 은 안 지운다 · 끝나면(완료·실패·취소·중단) 꺼지고 활동도 비운다(새로고침 뒤 화면과 같다) · 늦게 온 옛 running 스냅샷이 끝난 카드에 되살리지 않는다 · 서버가 다시 «running» 이라 하면 다시 보인다 · 도구 사이(진행 도구 없음)엔 «마지막 활동 N 전» 이 보이고 끝나면 같이 꺼진다",
          first.shown && running.shown && /Bash/.test(running.text) && running.text !== first.text &&
            kept.shown && /Bash/.test(kept.text) && kept.act !== null &&
            !done.shown && done.act === null && !stale.shown && stale.act === null &&
            Object.values(terminal).every((d: any) => !d.shown && d.act === null) &&
            revived.shown && /Bash/.test(revived.text) &&
            idle.shown && idle.text === idleWant && !idleDone.shown && idleDone.act === null,
          { first: first.text, running, kept, done, stale, terminal, revived, idle, idleWant, idleDone },
        ),
      );
    }

    // ⑤④ 셸: 빈 화면에 리퍼 통지 하나 → 서버 시작·끝 · 설명 라벨 · 뒤에 온 빈 통지가 지우지 않는다 · 기존 DOM 그대로
    {
      const S = BASE - 5 * 60000;
      R(`setBgSessionScope("all")`); // 소속 미상 셸(리퍼 통지)은 «현재 대화» 범위에서 숨는다
      R(`handleShellExited({ shellId: "rz", command: "npm run dev", cwd: "/w", status: "killed", startedAt: ${S}, finishedAt: ${S + 60000}, description: "개발 서버 띄우기" }, "")`);
      R(`setShellsFilter("done")`);
      const card = (id: string) => `document.querySelector('#bg-shells-list .shell-card[data-shell-id="${id}"]')`;
      const read = (id: string) => R(`(() => { const c = ${card(id)}; if (!c) return null; return {
        label: c.querySelector(".shell-card-label") ? c.querySelector(".shell-card-label").textContent : null,
        cmd: c.querySelector(".shell-card-command").textContent,
        el: c.querySelector(".agent-card-elapsed").textContent,
        top: [...c.querySelector(".agent-card-top").children].map((x) => x.className.split(" ")[0]),
        kids: [...c.children].map((x) => x.className),
      }; })()`);
      const r1 = read("rz");
      await clock.advance(7000);
      R(`handleShellExited({ shellId: "rz", command: "npm run dev", cwd: "/w", status: "killed" }, "")`); // 설명·시각 없는 통지(옛 페이로드·stale)
      seedShells = [{ shellId: "rz", command: "npm run dev", cwd: "/w", status: "killed", startedAt: S }];
      R(`window.resyncShells()`);
      await clock.advance(30);
      R(`renderShellsView()`);
      const r2 = read("rz");
      R(`handleShellExited({ shellId: "plain", command: "ls", cwd: "/w", status: "exited", exitCode: 0, startedAt: ${S}, finishedAt: ${S + 2000} }, "")`);
      R(`renderShellsView()`);
      const plain = read("plain");
      const fed = R(`(() => { let got = null; window.resourceStore.resource("bg-shells").subscribe((v) => { got = (v || []).find((x) => x.shellId === "rz"); }); return got; })()`);
      out.push(
        assert(
          "★★셸: 빈 화면에 종료 통지 하나로 생긴 카드도 서버 `finishedAt − startedAt`(종전엔 받은 시각을 시작으로 써 0s) · 맨 윗줄 첫 칸에 설명 · 명령 줄은 그대로 · 설명·시각 없는 통지·시드가 와도 안 지워지고 안 자란다",
          r1?.label === "개발 서버 띄우기" && r1?.cmd === "npm run dev" && r1?.el === fmt(60000) && r1?.top[0] === "shell-card-label" &&
            r2?.label === "개발 서버 띄우기" && r2?.el === fmt(60000),
          { r1, r2 },
        ),
      );
      out.push(
        assert(
          "★보존: 설명 없는 셸 카드는 지금 DOM 그대로(라벨 칸 없음 · 줄 순서·클래스 동일) · 설명 있는 카드는 그 앞에 한 칸만 더해진다 · 리소스(위젯)에 설명이 실린다",
          plain?.label === null && JSON.stringify(plain?.top) === JSON.stringify(["agent-card-kind", "agent-card-status", "shell-card-session"]) &&
            JSON.stringify(plain?.kids) === JSON.stringify(["agent-card-top", "agent-card-name shell-card-command", "shell-card-cwd", "agent-card-meta", "shell-card-tailline", "shell-card-controls"]) &&
            JSON.stringify(r1?.top.slice(1)) === JSON.stringify(["agent-card-kind", "agent-card-status", "shell-card-session"]) && JSON.stringify(r1?.kids) === JSON.stringify(plain?.kids) &&
            fed?.description === "개발 서버 띄우기",
          { plain, r1top: r1?.top, fed },
        ),
      );
      // 새로고침 시드로만 아는 끝난 셸 — 서버 `finishedAt` 에서 멈춘다(10-23 싱크 전 적대 검토 B 의 미확증 변이 «시드가 끝 시각을 버림» 을
      //  전체 회귀로 확증: 위 단언은 통지가 먼저 끝 시각을 준 카드라 시드의 끝 시각을 안 봤다 — 그 변이에 카드는 `10s` 대신 새로고침 시각까지 자랐다).
      seedShells = [{ shellId: "seeded", command: "npm test", cwd: "/w", status: "completed", exitCode: 0, startedAt: S, finishedAt: S + 10000 }]; // 서버 목록의 상태 이름(`completed`)
      R(`window.resyncShells()`);
      await clock.advance(30);
      R(`renderShellsView()`);
      const s1 = read("seeded");
      await clock.advance(5000);
      R(`renderShellsView()`);
      const s2 = read("seeded");
      out.push(
        assert(
          "★★셸: 새로고침 시드로만 아는 끝난 셸도 서버 `finishedAt − startedAt` 에서 멈춘다(시드의 끝 시각을 버리면 새로고침 시각까지 자란 값이 보인다)",
          s1?.el === fmt(10000) && s2?.el === fmt(10000),
          { s1: s1?.el, s2: s2?.el, want: fmt(10000) },
        ),
      );
    }

    // ② 패널: 위젯 경로는 안 펼친다 · 프로젝트 상세는 펼친다 · 윗변 정렬 · 따라가기 붙잡기 · 셸 읽던 자리
    {
      R(`setBgFilter("running"); setShellsFilter("running"); setBgSessionScope("all")`);
      for (const id of ["p1", "p2", "p3"]) R(`handleWorkerEvent({ jobId: "${id}", status: "running", kind: "worker", label: "${id}", task: "할 일", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default", startedAt: ${BASE} }, "")`);
      const list = `document.getElementById("bg-list")`;
      R(`window.EV = (type) => ({ type, bubbles: false, _stopped: false, defaultPrevented: false, stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; } })`);
      // 미니 DOM 의 정적 요소는 id 만 갖는다 — 실제 마크업(index.html)의 스크롤 칸 클래스를 붙인다(정렬은 `.bg-list` 조상을 찾는다).
      R(`${list}.classList.add("bg-list"); document.getElementById("bg-shells-list").classList.add("bg-list")`);
      R(`(() => { const l = ${list}; l.rect = { left: 0, right: 400, top: 100, bottom: 400, width: 400, height: 300 }; l.scrollTop = 0; l.scrollHeight = 2000; l.clientHeight = 300;
        jobCards.get("p2").el.rect = { left: 0, right: 400, top: 520, bottom: 700, width: 400, height: 180 }; })()`);
      R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "job", id: "p2" } }))`);
      await clock.advance(30);
      const widgetOpen = R(`jobCards.get("p2").el.classList.contains("open")`);
      const aligned = R(`${list}.scrollTop`);
      // 끝 쪽: 프로그램 스크롤이 «바닥 근처» 를 만들어도 따라가기를 다시 켜지 않는다 → 손(휠)이 풀어 준 뒤에만
      R(`(() => { const l = ${list}; l.scrollTop = 1700; l.dispatchEvent(window.EV("scroll")); })()`);
      const heldStick = R(`bgStick`);
      R(`(() => { const l = ${list}; l.dispatchEvent(window.EV("wheel")); l.dispatchEvent(window.EV("scroll")); })()`);
      const afterWheel = R(`bgStick`);
      R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "job", id: "p3" } }))`);
      await clock.advance(30);
      R(`document.getElementById("bg-jump").click()`);
      const afterJump = { stick: R(`bgStick`), hold: R(`bgRevealHold`) };
      R(`window.focusBgJob("p1")`);
      await clock.advance(30);
      const projectOpen = R(`jobCards.get("p1").el.classList.contains("open")`);
      R(`upsertShellEntry("sopen", { command: "a", status: "running", threadKey: "dashboard:default", ownerTk: "dashboard:default", expanded: true }, { visible: true }); renderShellsView();`);
      R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "shell", id: "sopen" } }))`);
      await clock.advance(30);
      const shellKept = R(`shellRegistry.get("sopen").expanded`);
      R(`shellRegistry.delete("sopen"); renderShellsView();`);
      out.push(
        assert(
          "★★위젯 경로는 카드를 **안 펼친다**(이미 펼친 셸은 펼친 채) · 프로젝트 상세(`focusBgJob`)는 지금처럼 펼친다 · 카드 윗변을 그 칸 윗변 + 8px 로(520 − 100 − 8 = 412)",
          widgetOpen === false && projectOpen === true && shellKept === true && aligned === 412,
          { widgetOpen, projectOpen, shellKept, aligned },
        ),
      );
      out.push(
        assert(
          "★★이동 뒤 프로그램 스크롤이 바닥 근처를 만들어도 따라가기가 다시 안 켜진다(끝 쪽 카드가 새 카드에 끌려 올라가던 것) · 사용자 손(휠) 뒤엔 지금 판정 · «↓ 최신» 은 붙잡기를 풀고 즉시 켠다",
          heldStick === false && afterWheel === true && afterJump.stick === true && afterJump.hold === false,
          { heldStick, afterWheel, afterJump },
        ),
      );

      // 셸 목록 읽던 자리 — 카드마다 높이 100, 칸 윗변 100 인 가짜 배치(레이아웃 없는 미니 DOM 에 위치 함수만 끼운다)
      R(`(() => {
        const g = document.getElementById("bg-shells-list");
        g.getBoundingClientRect = () => ({ top: 100, bottom: 400, left: 0, right: 400, height: 300, width: 400 });
        const proto = Object.getPrototypeOf(document.createElement("div"));
        if (!proto.__bguxRect) {
          proto.__bguxRect = proto.getBoundingClientRect;
          proto.getBoundingClientRect = function () {
            if (this.classList && this.classList.contains("shell-card") && this.parentNode === g) {
              const i = [...g.querySelectorAll(".shell-card")].indexOf(this);
              const top = 100 + i * 100 - g.scrollTop;
              return { top, bottom: top + 100, left: 0, right: 400, height: 100, width: 400 };
            }
            return proto.__bguxRect.call(this);
          };
        }
        for (const [id, t] of [["sa", 1], ["sb", 2], ["sc", 3]]) upsertShellEntry(id, { command: id, status: "running", startedAt: ${BASE} + t, threadKey: "dashboard:default", ownerTk: "dashboard:default" }, { visible: true });
        renderShellsView();
        g.scrollTop = 150;
      })()`);
      const relB = () => R(`(() => { const g = document.getElementById("bg-shells-list"); const c = [...g.querySelectorAll(".shell-card")].find((x) => x.dataset.shellId === "sb"); return c.getBoundingClientRect().top - 100; })()`);
      const before = relB();
      R(`handleShellExited({ shellId: "sa", command: "sa", status: "exited", startedAt: ${BASE} + 1, finishedAt: ${BASE} + 2 }, ""); renderShellsView();`);
      const after = relB();
      const top0 = R(`(() => { const g = document.getElementById("bg-shells-list"); g.scrollTop = 0; renderShellsView(); return g.scrollTop; })()`);
      out.push(
        assert(
          "★셸 목록을 통째로 다시 그려도 읽던 카드의 자리를 지킨다 — 위의 셸이 끝나 «실행 중» 에서 빠져도(종전엔 100px 밀림) · 맨 위에선 손대지 않는다",
          before === -50 && after === -50 && top0 === 0,
          { before, after, top0 },
        ),
      );
    }

    // ── ① 위젯: 세션별 기본 ─────────────────────────────────────────────────────
    {
      const now = Date.now();
      const names: Record<string, string> = { "dashboard:a": "에이", "dashboard:b": "비" };
      const ls = new Map<string, string>();
      const w = mountWidget(ls, { view: null, sessionName: (tk) => names[tk] ?? "" });
      w.push("running-work", [
        { jobId: "ja", label: "에이 매니저", status: "running", kind: "worker", startedAt: now - 30 * 60000, ownerThreadKey: "dashboard:a" },
        { jobId: "jb", label: "비 에이전트", status: "running", kind: "agent", startedAt: now - 50 * 60000, ownerThreadKey: "dashboard:b" },
        { jobId: "jz", label: "모름1", status: "running", kind: "worker", startedAt: now - 99 * 60000, ownerThreadKey: "dashboard:z" },
      ]);
      w.push("bg-shells", [
        { shellId: "sh-a", command: "npm run dev -- --port 5173", description: "개발 서버 띄우기", status: "running", startedAt: now - 3 * 60000, ownerThreadKey: "dashboard:a" },
        { shellId: "sh-y", command: "sleep 9", status: "running", startedAt: now - 60000, ownerThreadKey: "" },
      ]);
      w.push("bg-timers", [
        { id: 1, label: "빌드 확인", enabled: true, runAt: now + 5 * 60000, originThreadKey: "dashboard:a" },
        { id: 2, label: "타이머만", enabled: true, runAt: now + 2 * 60000, originThreadKey: "dashboard:t" },
      ]);
      names["dashboard:t"] = "티";
      w.push("bg-timers", [
        { id: 1, label: "빌드 확인", enabled: true, runAt: now + 5 * 60000, originThreadKey: "dashboard:a" },
        { id: 2, label: "타이머만", enabled: true, runAt: now + 2 * 60000, originThreadKey: "dashboard:t" },
      ]);
      const heads = w.text(".rw-sess .rw-title");
      const groupTitles = [KO["group.timers"], KO["group.jobs"], KO["group.shells"]];
      const kindTitles = w.text(".rw-title").filter((t) => groupTitles.includes(t)).length + w.text(".rw-session").length;
      const sec = (title: string) => w.root.querySelectorAll(".rw-sess").find((s: any) => s.querySelector(".rw-title").textContent === title);
      const rowsOf = (title: string) => (sec(title)?.querySelectorAll(".rw-row") ?? []).map((r: any) => ({ l: String(r.querySelector(".rw-label").textContent), br: r.classList.contains("rw-kind-break") }));
      const a = rowsOf("에이");
      const shellRow = sec("에이")?.querySelectorAll(".rw-row").find((r: any) => String(r.textContent).includes("개발 서버"));
      out.push(
        assert(
          "★★기본 = 세션별: 머리 줄은 대화만(종류 제목 줄 0) · 순서 = 잡·셸의 가장 이른 시작 → 타이머만 있는 대화 → «대화 미상» 끝 · 이름 모르는 대화 둘은 «대화 미상» 하나",
          JSON.stringify(heads) === JSON.stringify(["비", "에이", "티", KO["session.unknown"]]) && kindTitles === 0 && ls.get("rw.view.v1") === undefined,
          { heads, kindTitles },
        ),
      );
      out.push(
        assert(
          "★★종류는 아이콘 + **종류가 바뀌는 행에만** 얇은 선(대화 첫 행·한 종류뿐인 대화엔 없다) · 대화 안 순서 타이머 → 매니저/에이전트 → 셸 · 셸 이름 = description(툴팁에 명령도)",
          JSON.stringify(a) === JSON.stringify([{ l: "빌드 확인", br: false }, { l: "에이 매니저", br: true }, { l: "개발 서버 띄우기", br: true }]) &&
            JSON.stringify(rowsOf("비")) === JSON.stringify([{ l: "비 에이전트", br: false }]) &&
            JSON.stringify(rowsOf(KO["session.unknown"]).map((r) => r.br)) === JSON.stringify([false, true]) &&
            String(shellRow?.title) === "개발 서버 띄우기\nnpm run dev -- --port 5173",
          { a, b: rowsOf("비"), unknown: rowsOf(KO["session.unknown"]), tip: shellRow?.title },
        ),
      );
      // 메뉴 · 전환 · 기억 · 접기
      const m1 = w.menu().map((x) => x.label);
      w.root.querySelectorAll(".rw-sess .rw-head")[0]?.click(); // «비» 접기(메모리)
      const collapsedRows = w.text(".rw-row").length;
      w.menu()[2]?.run(); // 모두 접기(세션별)
      const allCollapsed = w.text(".rw-row").length;
      w.menu()[1]?.run(); // 종류별로
      const kindTitlesAfter = w.text(".rw-group > .rw-head .rw-title");
      const m2 = w.menu().map((x) => x.label);
      const w2 = mountWidget(ls, { view: null, sessionName: (tk) => names[tk] ?? "" }); // 같은 브라우저에서 다시 연다
      w2.push("running-work", []); w2.push("bg-shells", []); w2.push("bg-timers", [{ id: 1, label: "빌드 확인", enabled: true, runAt: now + 5 * 60000, originThreadKey: "dashboard:a" }]);
      const reopened = w2.text(".rw-sess").length === 0 && w2.text(".rw-session").length === 1;
      const wf = mountWidget(undefined, { writeFails: true, view: null, sessionName: (tk) => names[tk] ?? "" });
      wf.push("running-work", []); wf.push("bg-shells", []); wf.push("bg-timers", [{ id: 1, label: "빌드 확인", enabled: true, runAt: now + 5 * 60000, originThreadKey: "dashboard:a" }]);
      wf.menu()[1]?.run();
      const wfSwitched = wf.text(".rw-session").length === 1;
      out.push(
        assert(
          "★메뉴 = 패널 열기 · «종류별로 보기 (지금: 세션별)» · 모두 접기(지금 보기에 적용) — 전환하면 종류별(묶음 제목) · 다시 열어도 그 보기(`rw.view.v1`) · 저장이 실패해도 지금 화면은 바뀐다 · 세션 접기는 그 대화만",
          JSON.stringify(m1) === JSON.stringify([KO["menu.openPanel"], KO["menu.viewKind"], KO["menu.collapseAll"]]) &&
            collapsedRows === 6 && allCollapsed === 0 &&
            JSON.stringify(kindTitlesAfter) === JSON.stringify([KO["group.timers"], KO["group.jobs"], KO["group.shells"]]) &&
            m2[1] === KO["menu.viewSession"] && ls.get("rw.view.v1") === "kind" && reopened && wfSwitched,
          { m1, m2, collapsedRows, allCollapsed, kindTitlesAfter, saved: ls.get("rw.view.v1"), reopened, wfSwitched },
        ),
      );
      // 로딩·빈 상태 — 세션별 보기도 같은 판정
      const w4 = mountWidget(undefined, { view: null });
      const l0 = w4.text(".rw-idle");
      w4.push("running-work", []); w4.push("bg-shells", null);
      const l1 = w4.text(".rw-idle");
      w4.push("bg-shells", []); w4.push("bg-timers", []);
      const l2 = w4.text(".rw-idle");
      out.push(
        assert(
          "세션별 보기도 «불러오는 중»(하나라도 `null`) → «없음»(셋 다 빈 목록) 을 그대로 지난다",
          JSON.stringify(l0) === JSON.stringify([KO.loading]) && JSON.stringify(l1) === JSON.stringify([KO.loading]) && JSON.stringify(l2) === JSON.stringify([KO.idle]),
          { l0, l1, l2 },
        ),
      );
    }

    // ⑦ 셸 카드 맨 윗줄 자리 배분(app.css) — 설명이 있으면 세션 배지가 먼저 줄고(하한에서 멈춤) 설명은 그다음이다.
    //  미니 DOM 엔 레이아웃이 없어 선언으로 판정한다 — 폭 실측(1440·390)은 헤드리스로 했다.
    {
      const css = readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! }));
      const decl = (body: string, prop: string): string | undefined => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();
      const shrinkOf = (body: string): number | undefined => {
        const s = decl(body, "flex-shrink");
        if (s !== undefined) return Number(s);
        const f = decl(body, "flex")?.split(/\s+/);
        return f && f.length >= 2 ? Number(f[1]) : undefined;
      };
      const touches = (sel: string, cls: string) => sel.split(",").some((s) => new RegExp(`\\.${cls}(?![\\w-])`).test(s.trim().split(" ").pop() ?? ""));
      const labelRules = rules.filter((r) => touches(r.sel, "shell-card-label"));
      const sessRules = rules.filter((r) => touches(r.sel, "shell-card-session"));
      const withLabel = sessRules.filter((r) => /\.shell-card-label ~ \.shell-card-session/.test(r.sel));
      const plainLayout = sessRules.filter((r) => !/\.shell-card-label ~/.test(r.sel) && (shrinkOf(r.body) !== undefined || decl(r.body, "min-width") !== undefined || decl(r.body, "flex-basis") !== undefined));
      const labelShrink = labelRules.map((r) => shrinkOf(r.body)).find((v) => v !== undefined);
      const sessShrink = withLabel.map((r) => shrinkOf(r.body)).find((v) => v !== undefined);
      const sessMin = withLabel.map((r) => decl(r.body, "min-width")).find((v) => v !== undefined);
      // 하한은 «한글 네 글자쯤» — 0 이면 배지가 빈 알약이 되고, 크면 설명 자리를 도로 뺏는다(사냥 구멍 2: 400px 도 초록이었다).
      //  배지 글자 0.625rem(10px) 기준 px 로 환산해 40~70px 안이어야 한다(5.5em = 55px).
      const minPx = ((m) => (m ? Number(m[1]) * (m[2] === "px" ? 1 : 10) : NaN))(/^([\d.]+)(px|em|rem)$/.exec(sessMin ?? ""));
      const fixed = rules.filter((r) => /\.shell-card \.agent-card-kind/.test(r.sel) && /\.shell-card \.agent-card-status/.test(r.sel)).map((r) => shrinkOf(r.body));
      out.push(
        assert(
          "★셸 카드 맨 윗줄: 설명이 있으면 세션 배지가 설명보다 훨씬 먼저 줄고(줄임 비율 ≥ 10배) 최소 폭(한글 네 글자쯤, 40~70px)에서 멈춘다 · 설명 없는 카드엔 세션 배지 배치 규칙이 안 걸린다 · 셸 배지·상태는 줄지 않는다",
          labelShrink === 1 && typeof sessShrink === "number" && sessShrink >= 10 &&
            typeof sessMin === "string" && minPx >= 40 && minPx <= 70 && plainLayout.length === 0 &&
            fixed.length > 0 && fixed.every((v) => v === 0),
          { labelShrink, sessShrink, sessMin, minPx, plainLayout: plainLayout.map((r) => r.sel), fixed },
        ),
      );
    }
    return out;
  },
};

export default check;
