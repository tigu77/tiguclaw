/**
 * 회귀: **예약 목록은 요약 행 + 크기 제한 페이지 — 전체 id 를 누락·중복 없이** (2026-11-19 뉴돌쇠).
 *
 * 사고: `list_schedules(only_enabled=true)` 가 행마다 지시문 원문을 실어 22,735자가 됐고, Codex 진입 상한(16,000자)에 가운데 행들이
 *  빠져 «오늘 다른 게시 예약이 없는지» 를 확인하지 못해 게시가 보류됐다(11-18·11-19 연속). 진단의 «행 300자면 100건도 상한 안» 은
 *  산술 오류였다(30,000자) — 간결한 목록만으로는 전체 조회를 보장할 수 없어 페이지가 필요하다.
 *  설계: docs/decisions/2026-11-19-tool-output-recovery-design.md §3-2.
 *
 * 재는 것(진짜 저장소 + 진짜 도구 핸들러):
 *  ① 사고 모양(활성 예약 수십 건·지시문 1,200자)에서 페이지마다 응답이 진입 상한 안 · 원문 없음
 *  ② 페이지를 끝까지 이으면 조건에 맞는 id 가 정확히 한 번씩(누락·중복 0) · 끝은 complete:true · total 일치
 *  ③ 이어 읽는 도중 변경 — 읽는 내내 있던 행은 정확히 한 번 · 새 행은 뒤 페이지에 · 지운/끈 미독 행은 안 나옴 · total 변화로 신호
 *  ④ 이스케이프가 많은 라벨·오류(따옴표·역슬래시·제어문자)에서도 응답 JSON 이 상한 안 · 예산이 아주 작아도 한 행씩 진행
 *  ⑤ 단건 상세(id)는 원문 포함 종전 모양 · 입력 스키마(after_id 0 이상 정수)
 * 등급: **동작**.
 */
import { listOutboundChannels } from "../../core/channel-outbound.js";
import { TOOL_OUTPUT_ENTRY_CAP } from "../../core/llm-runtime/tool-output-limits.js";
import { initStore } from "../../store/sessions.js";
import { addSchedule, deleteSchedule, getSchedule, listSchedules, recordFiring, updateSchedule, type ScheduleRow } from "../../store/schedules.js";
import { assert, assertIsolated, loadPluginModule, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

type Tool = {
  handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }>;
  inputSchema?: { safeParse?: (v: unknown) => { success: boolean } };
};
type Page = { ok: boolean; total?: number; returned?: number; items?: Array<Record<string, unknown>>; next_after_id?: number; complete?: boolean; error?: string };

export const check: RegressionCheck = {
  name: "schedule-list-pages",
  guards:
    "예약 목록이 행마다 지시문 원문을 실어 진입 상한(16,000자)을 넘고 가운데 행이 빠져, 다른 예약이 없음을 확인하지 못해 게시가 보류되던 것(11-18·11-19)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];
    const made: number[] = [];
    const dest = listOutboundChannels()[0] ?? "http-bridge";
    const mk = (label: string, prompt: string): number => {
      const row = addSchedule({ label, cronExpr: "0 8 * * *", timezone: "Asia/Seoul", prompt, destChannel: dest, destTarget: null });
      made.push(row.id);
      return row.id;
    };
    try {
      const mcp = await loadPluginModule<{
        createSchedulerMcpServer: (h?: unknown) => { instance: unknown };
        scheduleListPage: (rows: readonly ScheduleRow[], afterId: number, budget: number) => Page;
      }>("../../../plugins/scheduler/src/mcp.js");
      const tools = (mcp.createSchedulerMcpServer({ turnSession: () => null }).instance as { _registeredTools: Record<string, Tool> })._registeredTools;
      const raw = async (args: unknown): Promise<string> => (await tools.list_schedules!.handler(args, {})).content[0]!.text;
      const call = async (args: unknown): Promise<{ text: string; page: Page }> => { const text = await raw(args); return { text, page: JSON.parse(text) as Page }; };

      // ① 사고 모양 — 활성 40건 · 꺼진 5건 · 지시문 1,200자(가운데에 표식)
      const body = "오늘 게시 규칙 확인 후 이불 글을 올린다 ".repeat(40);
      for (let i = 0; i < 45; i++) mk(`regr-pages-${i}`, `${body.slice(0, 600)} PROMPT-MID-${i} ${body.slice(0, 590)}`);
      const off = made.slice(10, 15);
      for (const id of off) updateSchedule(id, { enabled: false });
      const enabledIds = listSchedules({ onlyEnabled: true }).map((r) => r.id);
      const oldStyleChars = JSON.stringify({ ok: true, items: listSchedules({ onlyEnabled: true }).map((r) => ({ id: r.id, prompt: r.prompt })) }).length;

      const pages: { text: string; page: Page }[] = [];
      for (let after = 0, n = 0; n < 200; n++) {
        const p = await call({ only_enabled: true, ...(after > 0 ? { after_id: after } : {}) });
        pages.push(p);
        if (p.page.complete === true || p.page.next_after_id === undefined) break;
        after = p.page.next_after_id;
      }
      const seen = pages.flatMap((p) => (p.page.items ?? []).map((r) => r.id as number));
      out.push(assert(
        "재현 조건: 원문을 싣던 모양이면 진입 상한을 넘는 목록이다",
        oldStyleChars > TOOL_OUTPUT_ENTRY_CAP && enabledIds.length >= 40,
        { 종전모양: oldStyleChars, 활성: enabledIds.length },
      ));
      out.push(assert(
        "★① 페이지마다 응답 JSON 이 진입 상한 안이고 지시문 원문(가운데 표식)이 없다 · 여러 페이지로 나뉜다",
        pages.length >= 2 && pages.every((p) => p.text.length <= TOOL_OUTPUT_ENTRY_CAP && !/PROMPT-MID-\d+/.test(p.text)),
        { 페이지: pages.length, 크기: pages.map((p) => p.text.length) },
      ));
      out.push(assert(
        "★② 끝까지 이으면 활성 id 가 정확히 한 번씩(누락·중복 0) · 꺼진 건 없음 · 마지막은 complete:true · total = 활성 수",
        JSON.stringify(seen) === JSON.stringify(enabledIds) && pages[pages.length - 1]!.page.complete === true &&
          pages.slice(0, -1).every((p) => p.page.complete !== true && typeof p.page.next_after_id === "number") &&
          pages.every((p) => p.page.total === enabledIds.length && p.page.returned === p.page.items?.length) && !seen.some((id) => off.includes(id)),
        { seen: seen.length, enabled: enabledIds.length, dup: seen.length - new Set(seen).size, last: pages[pages.length - 1]?.page.complete },
      ));
      // 단건 상세로 원문을 읽을 수 있다(목록은 미리보기·길이만)
      const firstRow = pages[0]!.page.items![0]!;
      const detail = await call({ id: firstRow.id });
      out.push(assert(
        "목록 행은 prompt_chars·prompt_preview, 상세는 저장 원문 그대로",
        typeof firstRow.prompt_chars === "number" && firstRow.prompt_chars === getSchedule(firstRow.id as number)?.prompt.length &&
          detail.page.items?.[0]?.prompt === getSchedule(firstRow.id as number)?.prompt && !("prompt" in firstRow),
        { chars: firstRow.prompt_chars, preview: firstRow.prompt_preview },
      ));

      // ③ 이어 읽는 도중 변경 — 첫 페이지를 읽은 뒤: 읽은 행 하나 삭제 · 안 읽은 행 하나 삭제 · 안 읽은 행 하나 끄기 · 새 행 추가
      const p1 = (await call({ only_enabled: true })).page;
      const read1 = (p1.items ?? []).map((r) => r.id as number);
      const unread = enabledIds.filter((id) => !read1.includes(id));
      const delRead = read1[0]!, delUnread = unread[0]!, offUnread = unread[1]!;
      deleteSchedule(delRead);
      deleteSchedule(delUnread);
      updateSchedule(offUnread, { enabled: false });
      const added = mk("regr-pages-new", "NEW 새로 생긴 예약");
      const restIds: number[] = [];
      const totals: number[] = [p1.total ?? -1];
      for (let after = p1.next_after_id ?? 0, n = 0; n < 200; n++) {
        const p = (await call({ only_enabled: true, after_id: after })).page;
        restIds.push(...(p.items ?? []).map((r) => r.id as number));
        totals.push(p.total ?? -1);
        if (p.complete === true || p.next_after_id === undefined) break;
        after = p.next_after_id;
      }
      const all = [...read1, ...restIds];
      const throughout = enabledIds.filter((id) => ![delRead, delUnread, offUnread].includes(id));
      out.push(assert(
        "★③ 도중 변경: 읽는 내내 있던 행은 정확히 한 번 · 새 행은 뒤에서 나옴 · 지운/끈 미독 행은 안 나옴 · 이미 읽은 삭제 행은 첫 페이지에만",
        throughout.every((id) => all.filter((x) => x === id).length === 1) && all.filter((x) => x === added).length === 1 &&
          !restIds.includes(delUnread) && !restIds.includes(offUnread) && all.filter((x) => x === delRead).length === 1 && all.length === new Set(all).size,
        { 누락: throughout.filter((id) => !all.includes(id)), 중복: all.length - new Set(all).size, 새행: all.includes(added) },
      ));
      out.push(assert(
        "③ 페이지 사이 total 이 달라져 변경이 있었음을 알 수 있다",
        totals[0] !== totals[totals.length - 1],
        totals,
      ));

      // ④ 이스케이프가 많은 행 + 예산 경계(순수 함수)
      const nasty = "\"\\\u0001".repeat(30);
      const esc: number[] = [];
      for (let i = 0; i < 30; i++) {
        const id = mk(`${nasty}${i}`.slice(0, 120), `${nasty}${"\u0002".repeat(100)}`);
        recordFiring(id, { ok: false, error: nasty.repeat(10) });
        esc.push(id);
      }
      const escPages: string[] = [];
      for (let after = 0, n = 0; n < 200; n++) {
        const { text, page } = await call({ after_id: after });
        escPages.push(text);
        if (page.complete === true || page.next_after_id === undefined) break;
        after = page.next_after_id;
      }
      const escSeen = escPages.flatMap((t) => ((JSON.parse(t) as Page).items ?? []).map((r) => r.id as number));
      out.push(assert(
        "★④ 이스케이프가 많은 라벨·오류·미리보기에서도 페이지마다 JSON 이 상한 안이고 전체 id 가 한 번씩",
        escPages.every((t) => t.length <= TOOL_OUTPUT_ENTRY_CAP) && escPages.some((t) => t.includes('"last_status":"error"')) && esc.every((id) => escSeen.filter((x) => x === id).length === 1) &&
          JSON.stringify(escSeen) === JSON.stringify(listSchedules().map((r) => r.id)),
        { 페이지: escPages.length, 크기최대: Math.max(...escPages.map((t) => t.length)), 오류실림: escPages.some((t) => t.includes('"last_status":"error"')) },
      ));
      const rows = listSchedules();
      const tiny = mcp.scheduleListPage(rows, 0, 10); // 한 행도 안 들어가는 예산 — 그래도 한 행씩 진행한다
      const tiny2 = mcp.scheduleListPage(rows, tiny.next_after_id ?? 0, 10);
      const last = mcp.scheduleListPage(rows, rows[rows.length - 1]!.id, 10);
      out.push(assert(
        "④ 예산이 한 행보다 작아도 한 행씩 진행(멈춤 없음) · 마지막 id 뒤는 빈 complete",
        tiny.returned === 1 && tiny.next_after_id === rows[0]!.id && tiny2.returned === 1 && tiny2.items?.[0]?.id === rows[1]!.id &&
          last.returned === 0 && last.complete === true,
        { tiny: [tiny.returned, tiny.next_after_id], tiny2: tiny2.items?.[0]?.id, last: [last.returned, last.complete] },
      ));

      // ⑤' 새 설치의 첫 예약(id 1)이 인자 없는 첫 페이지에 나온다 — 빈 DB 가 필요해 자식 프로세스로(독립 변이 사냥 M04)
      {
        const { mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { fileURLToPath } = await import("node:url");
        const home = mkdtempSync(`${tmpdir()}/tiguclaw-regression-sched-first-`);
        const child = await spawnWithin(60_000, "첫 예약 목록", ["--import", "tsx", fileURLToPath(new URL("./_schedule-first-id-child.ts", import.meta.url))], { env: { ...process.env, TIGUCLAW_HOME: home } })
          .finally(() => rmSync(home, { recursive: true, force: true }));
        const line = child.out.split(/\r?\n/).find((l) => l.startsWith("FIRST_ID_RESULT "));
        const F = (line === undefined ? {} : JSON.parse(line.slice("FIRST_ID_RESULT ".length))) as { id?: number; ids?: number[]; complete?: boolean; total?: number };
        out.push(assert("★새 설치의 첫 예약(id 1)이 인자 없는 목록 첫 페이지에 나온다(complete·total 1)",
          F.id === 1 && JSON.stringify(F.ids) === "[1]" && F.complete === true && F.total === 1, { F, err: child.err.slice(-300) }));
      }

      // ⑤ 입력 스키마
      const schema = tools.list_schedules!.inputSchema;
      const parse = (v: unknown): boolean | null => (schema?.safeParse === undefined ? null : schema.safeParse(v).success);
      const v = { 영: parse({ after_id: 0 }), 양: parse({ after_id: 7 }), 음수: parse({ after_id: -1 }), 소수: parse({ after_id: 1.5 }), 문자: parse({ after_id: "3" }) };
      out.push(assert(
        "⑤ after_id 는 0 이상 정수만",
        v.영 === true && v.양 === true && v.음수 === false && v.소수 === false && v.문자 === false,
        v,
      ));
    } finally {
      for (const id of made) deleteSchedule(id);
    }
    return out;
  },
};
