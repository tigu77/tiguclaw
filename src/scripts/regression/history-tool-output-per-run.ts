/**
 * 회귀: **새로고침한 이력에서 도구 출력은 그 출력을 낸 턴의 스텝에만 붙는다** (2026-10-26).
 *
 * 사고(개발 인스턴스 대화 1건, 공식 `/api/chat-history` 실측): 활동 66건 중 `seq 0` 30건이 전부 같은 `project_capabilities` 출력을,
 *  `seq 1` 19건이 전부 `run_in_background` 출력을 달고 나왔다 — 다른 턴의 도구 스텝은 물론 텍스트 세그먼트에까지. 운영 인스턴스 재현:
 *  `echo HIST_B` 스텝을 새로고침하면 앞 턴의 «HIST_A» 출력이 보였다.
 *
 *  뿌리: 이력 투영이 끝 이벤트의 출력을 `대화|어댑터|seq` 전역 맵으로 찾았는데, `seq` 는 계약상 **run() 지역 카운터**라
 *  턴마다 0부터 다시 센다(`types.ts` RegionAActivityPayload.seq). 맵엔 가장 오래된 것이 남았고, 붙이는 루프는 텍스트까지 돌았다.
 *
 * 지키는 것 — ①턴마다 같은 seq 라도 제 출력 · 텍스트엔 출력 없음 ②끝 없이 버려진 시작 뒤 다음 턴의 같은 seq 는 다음 턴 것
 *  ③완료 뒤 시작·끝을 연달아 내는 도구(codex 내장 검색 — 실행시간이 두 이벤트 간격보다 길다)도 출력 보존
 *  ④시작을 못 찾은 끝(창 밖·앞 턴)은 어디에도 안 붙는다 ⑤그리지 않는 활동("turn", openai 바닥)이 섞여도 짝이 맞고 그 행은 안 나온다.
 */
import { initStore } from "../../store/sessions.js";
import { insertEvent } from "../../store/events.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

type Act = { seq: number; kind?: string; label: string; detail: string; text?: string; output?: unknown };

export const check: RegressionCheck = {
  name: "history-tool-output-per-run",
  guards:
    "새로고침한 대시보드 이력에서 도구 출력이 다른 턴의 같은 번호 스텝·텍스트 세그먼트에 붙던 것(seq 가 턴마다 0부터라 전역 키가 겹쳤다)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const { historyActivities } = (await import(new URL("../../../plugins/http-bridge/history-activities.js", import.meta.url).href)) as {
      historyActivities: (e: { ts: number }[], tk?: string) => Act[];
    };
    const out: Assertion[] = [];
    let base = Date.now() - 3_600_000;
    const scenario = (name: string, events: Array<[number, Record<string, unknown>]>, adapter = "codex"): Act[] => {
      const tk = `dashboard:regr-hist-out-${name}`;
      const t0 = (base += 100_000);
      for (const [dt, p] of events) insertEvent(t0 + dt, "llm.activity", JSON.stringify({ threadKey: tk, adapter, ...p }));
      return historyActivities([{ ts: t0 }], tk);
    };
    const outText = (a: Act | undefined): string | null => {
      const o = a?.output as { text?: unknown } | undefined;
      return o === undefined ? null : typeof o.text === "string" ? o.text : "★형식 다름";
    };
    const byDetail = (acts: Act[], d: string): Act | undefined => acts.find((a) => a.detail === d);
    const tool = (seq: number, label: string, detail: string) => ({ kind: "tool", seq, label, detail });
    const end = (seq: number, label: string, text: string, durationMs = 100) => ({ kind: "tool", seq, label, phase: "end", durationMs, output: { text } });
    const txt = (seq: number, text: string) => ({ kind: "text", seq, label: "text", text });

    // ① 사고 그대로 — 세 턴, 같은 seq 가 턴마다 다시 나온다.
    {
      const acts = scenario("three-turns", [
        [1000, tool(0, "project_capabilities", "턴1-도구")], [1400, end(0, "project_capabilities", "출력-턴1")], [1500, txt(1, "턴1 답")],
        [5000, txt(0, "턴2 서두")], [5100, tool(1, "run_in_background", "턴2-도구")], [5300, end(1, "run_in_background", "출력-턴2")],
        [9000, tool(0, "Read", "턴3-도구")], [9200, end(0, "Read", "출력-턴3")],
      ]);
      const got = { t1: outText(byDetail(acts, "턴1-도구")), t2: outText(byDetail(acts, "턴2-도구")), t3: outText(byDetail(acts, "턴3-도구")),
        texts: acts.filter((a) => a.kind === "text").map((a) => outText(a)) };
      out.push(assert(
        "★★턴마다 같은 seq 여도 출력은 그 턴의 스텝에만 · 텍스트 세그먼트엔 출력이 없다",
        got.t1 === "출력-턴1" && got.t2 === "출력-턴2" && got.t3 === "출력-턴3" && got.texts.length === 2 && got.texts.every((t) => t === null),
        got,
      ));
    }
    // ② 끝 없이 버려진 시작(멈춘 턴) 뒤 다음 턴의 같은 seq·같은 도구.
    {
      const acts = scenario("abandoned", [
        [1000, tool(0, "Bash", "멈춘-턴")],
        [6000, tool(0, "Bash", "다음-턴")], [6500, end(0, "Bash", "다음-턴-출력")],
      ]);
      const got = { stopped: outText(byDetail(acts, "멈춘-턴")), next: outText(byDetail(acts, "다음-턴")) };
      out.push(assert("★멈춘 턴의 스텝은 출력 없이 남고, 다음 턴의 같은 seq 출력은 다음 턴 스텝에 붙는다", got.stopped === null && got.next === "다음-턴-출력", got));
    }
    // ③ 완료 뒤 시작·끝을 같은 ms 에 연달아 — 실행시간(3초)이 두 이벤트 간격(0)보다 길다.
    {
      const acts = scenario("search", [
        [1000, tool(0, "Read", "앞-도구")], [1100, end(0, "Read", "앞-출력")],
        [5000, { ...tool(1, "web_search", "검색"), phase: "start" }], [5000, end(1, "web_search", "출처-목록", 3000)],
      ]);
      const got = { search: outText(byDetail(acts, "검색")), before: outText(byDetail(acts, "앞-도구")) };
      out.push(assert("완료 뒤 시작·끝을 한꺼번에 내는 도구(내장 검색)도 출력이 남는다", got.search === "출처-목록" && got.before === "앞-출력", got));
    }
    // ④ 시작을 못 찾은 끝 — 이 턴에 그 seq 시작이 없으면, 앞 턴의 열린 같은 seq 시작에 붙이지 않는다.
    {
      const acts = scenario("orphan-end", [
        [1000, tool(0, "Bash", "앞-턴-열린")],
        [6000, txt(0, "다음 턴 텍스트")], [6100, end(0, "Bash", "주인-없는-출력")],
      ]);
      const got = { prev: outText(byDetail(acts, "앞-턴-열린")), text: outText(acts.find((a) => a.kind === "text")) };
      out.push(assert("★시작을 못 찾은 끝의 출력은 어디에도 안 붙는다(앞 턴의 열린 스텝·텍스트 모두)", got.prev === null && got.text === null, got));
    }
    // ④′ 구간은 **마지막** seq 로 끊는다 — 앞 턴이 0·5 까지 갔고 다음 턴이 3 에서 시작하면 새 턴이다(첫 seq 로만 보면 3 > 0 이라 같은 턴으로 본다).
    {
      const acts = scenario("last-seq", [
        [1000, tool(0, "Bash", "앞-0")], [1100, tool(5, "Bash", "앞-5")],
        [6000, tool(3, "Bash", "다음-3")], [6100, end(0, "Bash", "주인-없는-0")], [6200, end(3, "Bash", "다음-3-출력")],
      ]);
      const got = { a0: outText(byDetail(acts, "앞-0")), a5: outText(byDetail(acts, "앞-5")), b3: outText(byDetail(acts, "다음-3")), steps: acts.length };
      out.push(assert("★구간은 직전 seq 로 끊는다 — 다음 턴의 주인 없는 끝 0 이 앞 턴의 열린 0 에 안 붙고, 다음 턴 3 은 제 출력", got.steps === 3 && got.a0 === null && got.a5 === null && got.b3 === "다음-3-출력", got));
    }
    // ④″ 그리지 않는 활동("turn")도 같은 카운터라 구간을 끊는다 — 앞 턴의 열린 1 뒤 다음 턴 turn 0 → 시작 없는 끝 1 은 버린다.
    {
      const acts = scenario("turn-boundary", [
        [1000, { kind: "turn", seq: 0, label: "턴" }], [1100, tool(1, "Bash", "앞-턴-열린-1")],
        [6000, { kind: "turn", seq: 0, label: "턴" }], [6100, end(1, "Bash", "주인-없는-1")],
      ], "openai");
      const got = { prev: outText(byDetail(acts, "앞-턴-열린-1")), steps: acts.length };
      out.push(assert("★«turn» 활동도 턴 경계를 센다 — 다음 턴의 시작 없는 끝은 앞 턴의 열린 같은 seq 스텝에 안 붙는다", got.steps === 1 && got.prev === null, got));
    }
    // ⑥ 두 대화가 같은 어댑터로 **동시에** 돈다(대화끼리는 줄이 다르다) — 구간은 대화마다 따로. 전체 활동 화면(대화 지정 없음)과 대화 화면 둘 다.
    //  (10-26 변이 사냥: 구간 키에서 대화를 빼도 전체 초록이었다 — 그러면 전체 활동에서 B 스텝에 A 출력이 보인다.)
    {
      const t0 = (base += 100_000);
      const A = "dashboard:regr-hist-out-par-a", Bk = "dashboard:regr-hist-out-par-b";
      const put = (dt: number, tk: string, p: Record<string, unknown>) => insertEvent(t0 + dt, "llm.activity", JSON.stringify({ threadKey: tk, adapter: "codex", ...p }));
      put(1000, A, tool(0, "Bash", "A-도구")); put(1100, Bk, tool(0, "Bash", "B-도구"));
      put(1200, A, end(0, "Bash", "A-출력")); put(1300, Bk, end(0, "Bash", "B-출력"));
      const all = historyActivities([{ ts: t0 }]);
      const onlyA = historyActivities([{ ts: t0 }], A);
      const got = { allA: outText(byDetail(all, "A-도구")), allB: outText(byDetail(all, "B-도구")), aView: outText(byDetail(onlyA, "A-도구")) };
      out.push(assert("★두 대화가 같은 어댑터로 섞여 돌아도 출력은 제 대화의 스텝에 — 전체 활동·대화 화면 모두", got.allA === "A-출력" && got.allB === "B-출력" && got.aView === "A-출력", got));
    }
    // ⑦ 한 턴 안에서 도구 둘이 **동시에 열린다**(병렬 도구 호출 — 시작 둘 뒤에 끝 둘). 새 시작이 같은 구간의 열린 스텝을 버리면 앞 도구 출력이 사라진다.
    //  (10-26 dev 싱크 적대 검토: 구간 교체 술어를 «시작마다» 로 넓혀도 ①~⑥ 이 초록이었다.)
    {
      const acts = scenario("concurrent-open", [
        [1000, tool(0, "Read", "A-동시")], [1010, tool(1, "Grep", "B-동시")],
        [1200, end(0, "Read", "A-동시-출력")], [1300, end(1, "Grep", "B-동시-출력")],
      ]);
      const got = { a: outText(byDetail(acts, "A-동시")), b: outText(byDetail(acts, "B-동시")), steps: acts.length };
      out.push(assert("★같은 턴에 동시에 열린 도구 둘 — 끝이 늦게 와도 각자 제 출력(새 시작이 열린 스텝을 버리지 않는다)", got.steps === 2 && got.a === "A-동시-출력" && got.b === "B-동시-출력", got));
    }
    // ⑤ 그리지 않는 활동("turn")이 섞인 openai 턴.
    {
      const acts = scenario("turn-floor", [
        [1000, { kind: "turn", seq: 0, label: "턴" }], [1100, tool(1, "Bash", "앞-턴")],
        [6000, { kind: "turn", seq: 0, label: "턴" }], [6100, tool(1, "Bash", "다음-턴")], [6300, end(1, "Bash", "다음-턴-출력")],
      ], "openai");
      const got = { prev: outText(byDetail(acts, "앞-턴")), next: outText(byDetail(acts, "다음-턴")), turnRows: acts.filter((a) => a.kind === "turn").length };
      out.push(assert("«turn» 활동이 섞인 턴도 짝이 맞고(앞 턴의 같은 seq 스텝엔 안 붙음) turn 행은 이력에 안 나온다", got.prev === null && got.next === "다음-턴-출력" && got.turnRows === 0, got));
    }
    return out;
  },
};
