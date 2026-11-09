/** Time, thread and ancestor cutoffs must precede the bounded activity query. */
import { initStore, getDb, SESSION_STORAGE_CHANNEL } from "../../store/sessions.js";
import { insertEvent, listEvents } from "../../store/events.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

type Act = { threadKey: string; detail: string; output?: unknown; text?: string; audience?: string; file?: unknown; plan?: string; model?: string };

export const check: RegressionCheck = {
  name: "history-activity-query-window",
  guards: "LIMIT 전 시간·세션·조상 cutoff 적용: 창 밖 3001행이 대상 카드를 밀어내지 않는다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const { historyActivities: history } = await import(new URL("../../../plugins/http-bridge/history-activities.js", import.meta.url).href) as {
      historyActivities: (entries: { ts: number }[], scope?: string, bounded?: boolean) => Act[];
    };
    const out: Assertion[] = [];
    const db = getDb();
    // Roll back only this fixture's inserts, so the suite's shared isolated DB is unchanged.
    db.exec("SAVEPOINT history_query_window_fixture");
    try {
      let clock = Date.now() + 10_000_000;
      const next = () => (clock += 100_000);
      const put = (tk: string, ts: number, p: Record<string, unknown>) => insertEvent(ts, "llm.activity", JSON.stringify({ threadKey: tk, adapter: "codex", ...p }));
      const start = (detail: string, seq = 0) => ({ kind: "tool", seq, label: "Read", detail });
      const end = (output: string, seq = 0) => ({ kind: "tool", phase: "end", seq, output });
      const flood = (tk: string, ts: number) => db.transaction(() => {
        for (let i = 0; i < 3001; i++) put(tk, ts, start("outside", i));
      })();
      const fork = (child: string, parent: string, cutoff: number) => db.prepare(
        `INSERT INTO thread_lineage (channel, thread_key, parent_key, through_transcript_id, through_chat_id, through_ts, created_at) VALUES (?, ?, ?, 0, 0, ?, ?)`,
      ).run(SESSION_STORAGE_CHANNEL, child, parent, cutoff, cutoff + 100);

      {
        const t = next(), tk = "dashboard:window-past";
        put(tk, t, start("past")); put(tk, t + 1, end("past-output"));
        put(tk, t + 2, { kind: "text", seq: 1, text: "past-text", audience: "internal" });
        flood(tk, t + 3);
        const got = history([{ ts: t }, { ts: t + 2 }], tk, true);
        out.push(assert("past window survives 3001 later same-thread rows", got.length === 2 && got[0]?.output === "past-output" && got[1]?.text === "past-text" && got[1]?.audience === "internal", got));
        const all = history([{ ts: t }, { ts: t + 2 }], undefined, true);
        out.push(assert("unscoped past window also applies upper bound before LIMIT", all.length === 2 && all[0]?.output === "past-output", all));
      }
      {
        const t = next(), tk = "dashboard:window-scoped";
        put(tk, t, start("target")); put(tk, t, end("target-output"));
        flood("dashboard:window-other", t);
        const got = history([{ ts: t }], tk, true);
        out.push(assert("same-ms other session 3001 rows cannot occupy scoped LIMIT", got.length === 1 && got[0]?.output === "target-output", got));
      }
      {
        const t = next(), parent = "dashboard:window-parent", child = "dashboard:window-child";
        fork(child, parent, t + 1);
        put(parent, t, start("parent-before")); put(parent, t, end("before-output"));
        put(parent, t + 1, start("parent-at")); put(parent, t + 1, end("at-output"));
        flood(parent, t + 2);
        put(child, t + 3, start("child")); put(child, t + 3, end("child-output"));
        for (const bounded of [false, true]) {
          const got = history([{ ts: t }, { ts: t + 3 }], child, bounded);
          out.push(assert(`ancestor cutoff inclusive before LIMIT (${bounded ? "past" : "latest"})`, got.length === 3 && got.every(a => a.threadKey === child) && got.map(a => a.output).join() === "before-output,at-output,child-output", got));
        }
      }
      {
        const t = next(), g = "dashboard:window-grand", p = "dashboard:window-middle", c = "dashboard:window-leaf";
        fork(p, g, t + 4); fork(c, p, t + 2);
        put(g, t + 2, start("grand-at")); put(p, t + 2, start("parent-at"));
        put(g, t + 2, end("grand-output")); put(p, t + 2, end("parent-output"));
        put(g, t + 3, start("grand-after")); put(p, t + 3, start("parent-after"));
        put(c, t + 5, start("self-after")); put(c, t + 5, end("self-output"));
        const got = history([{ ts: t }], c);
        out.push(assert("multi-ancestor path minimum cutoff and raw-thread seq isolation", got.length === 3 && got.map(a => a.output).join() === "grand-output,parent-output,self-output" && got.every(a => a.threadKey === c), got));
      }
      {
        const t = next(), tk = "dashboard:window-live";
        put(tk, t + 1, { ...start("live"), file: { path: "fixture.txt" }, plan: "plan", model: "fixture-model" });
        put(tk, t + 1, end("live-output"));
        const got = history([{ ts: t }], tk);
        out.push(assert("latest has no global time ceiling; rich fields preserved", got.length === 1 && got[0]?.output === "live-output" && got[0]?.plan === "plan" && got[0]?.model === "fixture-model" && (got[0]?.file as { path: string })?.path === "fixture.txt" && history([{ ts: t }], tk, true).length === 0, got));
        out.push(assert("empty history returns no activities", history([], tk).length === 0, history([], tk)));
        out.push(assert("empty history scope means unscoped, not empty SQL scope", JSON.stringify(history([{ ts: t }], "")) === JSON.stringify(history([{ ts: t }])), history([{ ts: t }], "")));
      }
      {
        const t = next(), tk = "dashboard:window-ties";
        put(tk, t - 1, start("before"));
        put(tk, t, start("first")); put(tk, t, end("first-output"));
        put(tk, t, start("second")); put(tk, t, end("second-output"));
        put(tk, t + 1, start("after"));
        const got = history([{ ts: t }], tk, true);
        out.push(assert("inclusive bounds preserve distinct ids and same-ms start/end publication order", got.length === 2 && got[0]?.output === "first-output" && got[1]?.output === "second-output", got));
      }
      {
        const t = next(), tk = "dashboard:window-overflow";
        put(tk, t, start("trimmed-start"));
        put(tk, t, { kind: "turn", seq: 0 });
        put(tk, t, end("orphan-output"));
        db.transaction(() => { for (let i = 0; i < 2997; i++) put(tk, t, { kind: "text", seq: i + 1, text: `text-${i}` }); })();
        put(tk, t, start("last-pair", 2998)); put(tk, t, end("last-output", 2998));
        const all = listEvents({ types: ["llm.activity"], sinceTs: t, threadScopes: [{ threadKey: tk }], limit: 10000 });
        const raw = listEvents({ types: ["llm.activity"], sinceTs: t, threadScopes: [{ threadKey: tk }], limit: 3000 });
        const got = history([{ ts: t }], tk, true);
        out.push(assert("overflow keeps exactly latest 3000 ids even within a timestamp tie", all.length === 3002 && raw.length === 3000 && raw.every((r, i) => r.id === all[i]?.id), { all: all.length, raw: raw.length }));
        out.push(assert("cap-trimmed start is not recovered and orphan end is not attached", got.length === 2998 && got.filter(a => a.output !== undefined).length === 1 && got.find(a => a.detail === "last-pair")?.output === "last-output", { count: got.length, outputs: got.filter(a => a.output !== undefined) }));
      }
      {
        const t = next(), type = "regression.window.generic", tk = "dashboard:window-json-' OR 1=1 --";
        db.transaction(() => { for (let i = 0; i < 10001; i++) insertEvent(t + (i % 2), type, `raw-${i}`); })();
        const plain = listEvents({ types: [type] });
        const large = listEvents({ types: [type], limit: 10000 });
        out.push(assert("generic default100 / 5000 / 10000 / id DESC / original payload unchanged", plain.length === 100 && listEvents({ types: [type], limit: 5000 }).length === 5000 && large.length === 10000 && large.every((r, i) => i === 0 || r.id < large[i - 1].id) && plain[0]?.payload === "raw-10000" && listEvents({ types: [type], limit: 0 }).length === 100, { default: plain.length, large: large.length }));
        out.push(assert("no options retains default 100", listEvents().length === 100, listEvents().length));
        out.push(assert("generic since/until inclusive without JSON restriction", listEvents({ types: [type], sinceTs: t, untilTs: t, limit: 10000 }).length === 5001, listEvents({ types: [type], sinceTs: t, untilTs: t, limit: 10000 }).length));
        const jsonType = "regression.window.json";
        for (const payload of ["{", "null", "[]", "{}", '{"threadKey":123}', '{"threadKey":null}', '{"threadKey":true}', '{"threadKey":[]}', '{"threadKey":{}}', JSON.stringify({ threadKey: tk })]) insertEvent(t, jsonType, payload);
        const scoped = listEvents({ types: [jsonType], threadScopes: [{ threadKey: tk }] });
        out.push(assert("nested CASE safely excludes malformed/non-string JSON; threadKey bound as data", scoped.length === 1 && JSON.parse(scoped[0].payload).threadKey === tk && listEvents({ types: [jsonType], threadScopes: [{ threadKey: "123" }] }).length === 0 && listEvents({ types: [jsonType] }).length === 10, scoped));
        out.push(assert("explicit empty threadScopes never widens to all rows", listEvents({ threadScopes: [] }).length === 0, listEvents({ threadScopes: [] })));
        // Invalid payloads must not make scoped history's best-effort catch erase valid cards.
        for (const payload of ["{", "null", '{"threadKey":123}']) insertEvent(t, "llm.activity", payload);
        put(tk, t, start("valid")); put(tk, t, end("valid-output"));
        const got = history([{ ts: t }], tk);
        out.push(assert("scoped history survives malformed and non-object payloads", got.length === 1 && got[0]?.output === "valid-output", got));
      }
      return out;
    } finally {
      db.exec("ROLLBACK TO history_query_window_fixture; RELEASE history_query_window_fixture");
    }
  },
};
