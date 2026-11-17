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
 *  ④ 기존 목록(인자 없음·only_enabled) 계약 보존 + 행 모양 동일
 *  ⑤ 사고 모양 재현 — 큰 목록은 진입 제한에서 대상 원문을 잃고, 한 건 결과는 그대로 통과한다
 *  ⑥ 입력 스키마 — id 는 양의 정수만, 인자 없는 기존 호출은 그대로 통과
 *
 * ★범위: 한 건 자체가 결과 상한보다 긴 경우는 이 검사·수정의 대상이 아니다.
 * 등급: **동작**.
 */
import { listOutboundChannels } from "../../core/channel-outbound.js";
import { capToolOutputForEntry } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { initStore } from "../../store/sessions.js";
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
      const call = async (args: unknown) => JSON.parse(await raw(args)) as { ok: boolean; error?: string; items?: Array<Record<string, unknown>> };

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
      const all = await call({});
      const enabledOnly = await call({ only_enabled: true });
      const ids = (r: { items?: Array<Record<string, unknown>> }) => new Set((r.items ?? []).map((x) => x.id as number));
      const allIds = ids(all);
      const enIds = ids(enabledOnly);
      out.push(assert(
        "★인자 없는 목록은 전부(꺼진 것 포함), only_enabled 는 켜진 것만 — 기존 그대로",
        made.every((id) => allIds.has(id)) && !enIds.has(off) && [target, ...fillers].every((id) => enIds.has(id)),
        { 전체에_다있음: made.every((id) => allIds.has(id)), 활성에_꺼짐: enIds.has(off) },
      ));
      const fromList = (all.items ?? []).find((r) => r.id === target);
      out.push(assert(
        "한 건 결과의 행은 목록의 같은 행과 같다(필드·값)",
        fromList !== undefined && JSON.stringify(fromList) === JSON.stringify(one.items?.[0]),
        { 목록키: Object.keys(fromList ?? {}).join(","), 한건키: Object.keys(one.items?.[0] ?? {}).join(",") },
      ));

      // ⑤ 사고 모양 — 큰 목록은 진입 제한에서 대상 가운데를 잃고, 한 건은 그대로
      const listText = await raw({ only_enabled: true });
      const cappedList = capToolOutputForEntry(listText);
      const cappedOne = capToolOutputForEntry(oneText);
      out.push(assert(
        "★(재현) 25,000자 넘는 목록은 진입 제한에서 대상 원문 가운데가 빠진다",
        listText.length > 25_000 && listText.includes("TARGET-MID") && !cappedList.includes("TARGET-MID"),
        { 목록: listText.length, 제한후: cappedList.length, 제한후_대상중간: cappedList.includes("TARGET-MID") },
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
