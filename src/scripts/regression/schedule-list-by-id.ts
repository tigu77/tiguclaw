/**
 * 회귀: **예약 한 건의 저장된 지시문을 목록 전체 없이 읽는다** (2026-11-17 뉴돌쇠 관측).
 *
 * 사고: `list_schedules(only_enabled=true)` 결과가 14,849 → 25,602자로 커지자, 긴 도구 결과를 머리·꼬리만 남기는
 *  진입 제한(Codex `capToolOutputForEntry`)에 가운데가 빠져 대상 예약(#153, 약 3,546자)의 원문 대조를 끝내지 못했다.
 *  도구엔 id 필터가 없어 목록 전체를 다시 부르는 길밖에 없었다.
 *
 * 재는 것(진짜 저장소 + 진짜 도구 핸들러):
 *  ① id 를 주면 그 한 건만 — prompt 가 저장값과 바이트 동일, 다른 예약은 섞이지 않는다
 *  ② 없는 id 는 ok:false·not_found(빈 목록으로 «없음» 과 «꺼짐» 을 섞지 않는다)
 *  ③ id + only_enabled — 둘 다 만족해야 한다(꺼진 건은 빈 items, 켜진 건은 한 건) / id 만이면 꺼진 건도 돌려준다
 *  ④ 목록(인자 없음·only_enabled)의 포함 범위 계약 보존 + 목록 행 = 한 건 상세의 요약(원문 대신 길이·미리보기, 2026-11-19)
 *  ⑤ 사고 모양 — 원문을 싣던 목록은 진입 제한에서 대상 원문을 잃었다 → 지금 목록 페이지는 진입 상한 안이고 원문이 없다 ·
 *     한 건 결과는 그대로 통과한다(페이지 계약 자체는 `schedule-list-pages`)
 *  ⑥ 입력 스키마 — id 는 양의 정수만, 인자 없는 기존 호출은 그대로 통과
 *
 * ★범위: 한 건 자체가 결과 상한보다 긴 경우는 이 검사·수정의 대상이 아니다.
 * 등급: **동작**.
 */
import { listOutboundChannels } from "../../core/channel-outbound.js";
import { capToolOutputForEntry } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { initStore } from "../../store/sessions.js";
import { TOOL_OUTPUT_ENTRY_CAP } from "../../core/llm-runtime/tool-output-limits.js";
import { addSchedule, deleteSchedule, getSchedule, updateSchedule } from "../../store/schedules.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

type Tool = {
  handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }>;
  inputSchema?: { safeParse?: (v: unknown) => { success: boolean } };
};
type Tools = Record<string, Tool>;

export const check: RegressionCheck = {
  name: "schedule-list-by-id",
  guards:
    "예약 목록이 길어지면 도구 결과 진입 제한에 가운데가 빠져, 저장된 예약 한 건의 지시문을 끝내 대조하지 못하던 것(id 필터 없음)",
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
      const mcp = await loadPluginModule<{ createSchedulerMcpServer: (h?: unknown) => { instance: unknown } }>("../../../plugins/scheduler/src/mcp.js");
      const tools = (mcp.createSchedulerMcpServer({ turnSession: () => null }).instance as { _registeredTools: Tools })._registeredTools;
      const raw = async (args: unknown): Promise<string> => (await tools.list_schedules!.handler(args, {})).content[0]!.text;
      const call = async (args: unknown) => JSON.parse(await raw(args)) as { ok: boolean; error?: string; items?: Array<Record<string, unknown>>; next_after_id?: number; complete?: boolean };
      // 목록 전체 — 페이지를 끝까지 이어 읽는다(2026-11-19 페이지 계약).
      const callAll = async (args: Record<string, unknown>) => {
        const items: Array<Record<string, unknown>> = [];
        for (let after = 0, n = 0; n < 100; n++) {
          const p = await call({ ...args, after_id: after });
          items.push(...(p.items ?? []));
          if (p.complete === true || p.next_after_id === undefined) return { ok: p.ok, items };
          after = p.next_after_id;
        }
        return { ok: false, items };
      };

      // 대상 — 약 3,546자(관측 크기), 앞·가운데·끝에 표식. 주변에 긴 예약들을 둬 목록을 25,000자 넘게 키운다.
      const body = "아침 글 지시문 본문 ".repeat(320);
      // 앞뒤 공백·개행과 분해형 유니코드(e + 결합 악센트)도 싣는다 — 조회가 다듬거나 정규화하면 «저장값 그대로» 가 깨진다
      //  (2026-11-17 독립 변이 사냥: 행 매핑의 `trim()`·`normalize("NFC")` 가 초록으로 살아남던 구멍).
      const targetPrompt = `\n  TARGET-HEAD ${body.slice(0, 1700)} TARGET-MID café ${body.slice(0, 1780)} TARGET-TAIL \t\n`;
      const fillers: number[] = [];
      for (let i = 0; i < 4; i++) fillers.push(mk(`regr-byid-앞${i}`, `FILLER-A${i} ${"x".repeat(3000)}`));
      const target = mk("regr-byid-대상", targetPrompt);
      for (let i = 0; i < 4; i++) fillers.push(mk(`regr-byid-뒤${i}`, `FILLER-B${i} ${"y".repeat(3000)}`));
      const off = mk("regr-byid-꺼짐", "OFF-MARKER 꺼 둔 예약");
      updateSchedule(off, { enabled: false });

      // ① 한 건 — 저장값과 동일, 다른 예약 비혼입
      const oneText = await raw({ id: target });
      const one = JSON.parse(oneText) as { ok: boolean; items?: Array<Record<string, unknown>> };
      const stored = getSchedule(target)?.prompt;
      out.push(assert(
        "★id 를 주면 그 한 건만 — prompt 가 저장값과 바이트 동일",
        one.ok === true && one.items?.length === 1 && one.items[0]!.id === target && one.items[0]!.prompt === stored && stored === targetPrompt,
        { ok: one.ok, n: one.items?.length, id: one.items?.[0]?.id, 길이: String(one.items?.[0]?.prompt ?? "").length, 저장: stored?.length },
      ));
      out.push(assert(
        "다른 예약은 섞이지 않는다(채움·꺼진 예약 표식 0)",
        !/FILLER-|OFF-MARKER/.test(oneText),
        oneText.match(/FILLER-[AB]\d|OFF-MARKER/g) ?? [],
      ));

      // ② 없는 id
      const missingId = Math.max(...made) + 1000;
      const missing = await call({ id: missingId });
      out.push(assert(
        "★없는 id 는 ok:false·not_found(빈 목록과 구분)",
        missing.ok === false && missing.error === "not_found" && missing.items === undefined,
        missing,
      ));

      // ③ id + only_enabled 조합
      const offOnlyEnabled = await call({ id: off, only_enabled: true });
      const offPlain = await call({ id: off });
      const onOnlyEnabled = await call({ id: target, only_enabled: true });
      out.push(assert(
        "★id + only_enabled=true — 꺼진 건은 빈 items(ok:true), 켜진 건은 한 건",
        offOnlyEnabled.ok === true && offOnlyEnabled.items?.length === 0 && onOnlyEnabled.items?.length === 1 && onOnlyEnabled.items[0]!.id === target,
        { 꺼짐: offOnlyEnabled.items?.length, 켜짐: onOnlyEnabled.items?.length },
      ));
      out.push(assert(
        "id 만이면 꺼진 건도 돌려준다(enabled:false 로 보인다)",
        offPlain.ok === true && offPlain.items?.length === 1 && offPlain.items[0]!.enabled === false,
        offPlain.items?.map((r) => ({ id: r.id, enabled: r.enabled })),
      ));

      // ④ 기존 목록 계약 보존 + 행 모양 동일
      const all = await callAll({});
      const enabledOnly = await callAll({ only_enabled: true });
      const ids = (r: { items?: Array<Record<string, unknown>> }) => new Set((r.items ?? []).map((x) => x.id as number));
      const allIds = ids(all);
      const enIds = ids(enabledOnly);
      out.push(assert(
        "★인자 없는 목록은 전부(꺼진 것 포함), only_enabled 는 켜진 것만 — 기존 그대로",
        made.every((id) => allIds.has(id)) && !enIds.has(off) && [target, ...fillers].every((id) => enIds.has(id)),
        { 전체에_다있음: made.every((id) => allIds.has(id)), 활성에_꺼짐: enIds.has(off) },
      ));
      const fromList = (all.items ?? []).find((r) => r.id === target);
      const full = one.items?.[0] ?? {};
      const { prompt: _p, last_error: _e, ...sameFields } = full;
      out.push(assert(
        "★목록 행 = 한 건 상세의 요약 — prompt 원문 없음 · prompt_chars = 저장 원문 길이 · 미리보기 한 줄 · 나머지 필드·값 같음",
        fromList !== undefined && !("prompt" in fromList) && fromList.prompt_chars === stored?.length &&
          typeof fromList.prompt_preview === "string" && !/\n/.test(fromList.prompt_preview as string) && (fromList.prompt_preview as string).length <= 81 &&
          Object.entries(sameFields).every(([k, v]) => JSON.stringify(fromList[k]) === JSON.stringify(v)),
        { 목록키: Object.keys(fromList ?? {}).join(","), 한건키: Object.keys(full).join(","), chars: fromList?.prompt_chars },
      ));

      // ⑤ 사고 모양 — 원문을 싣던 목록(종전 25,000자+)은 진입 제한에서 대상 가운데를 잃었다. 지금 목록 페이지는 상한 안·원문 없음.
      const listText = await raw({ only_enabled: true });
      const cappedList = capToolOutputForEntry(listText);
      const cappedOne = capToolOutputForEntry(oneText);
      out.push(assert(
        "★목록 페이지는 진입 제한을 그대로 통과한다(원문 없음 — 대상 머리·가운데·끝 표식 0, 대상 id 는 있음)",
        cappedList === listText && listText.length <= TOOL_OUTPUT_ENTRY_CAP && !/TARGET-(MID|TAIL)|FILLER-[AB]\d \w{100}/.test(listText) &&
          (JSON.parse(listText) as { items?: Array<{ id: number }> }).items?.some((r) => r.id === target) === true,
        { 목록: listText.length, 같음: cappedList === listText },
      ));
      out.push(assert(
        "★한 건 결과는 진입 제한을 그대로 통과한다(머리·가운데·끝 표식 모두)",
        cappedOne === oneText && ["TARGET-HEAD", "TARGET-MID", "TARGET-TAIL"].every((m) => cappedOne.includes(m)),
        { 한건: oneText.length, 같음: cappedOne === oneText },
      ));

      // ⑥ 입력 스키마
      const schema = tools.list_schedules!.inputSchema;
      const parse = (v: unknown): boolean | null => (schema?.safeParse === undefined ? null : schema.safeParse(v).success);
      const verdicts = { 빈: parse({}), 활성만: parse({ only_enabled: true }), id: parse({ id: 5 }), 영: parse({ id: 0 }), 음수: parse({ id: -1 }), 소수: parse({ id: 1.5 }), 문자: parse({ id: "5" }) };
      out.push(assert(
        "입력 스키마 — 기존 호출·양의 정수 id 는 통과, 0·음수·소수·문자 id 는 거절",
        verdicts.빈 === true && verdicts.활성만 === true && verdicts.id === true && verdicts.영 === false && verdicts.음수 === false && verdicts.소수 === false && verdicts.문자 === false,
        verdicts,
      ));
    } finally {
      for (const id of made) deleteSchedule(id);
    }
    return out;
  },
};
