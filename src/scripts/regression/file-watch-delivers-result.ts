/**
 * 회귀: **파일 감시의 결과가 dest_channel 로 실제로 간다** (2026-10-09 사용자 결정).
 *
 * 사고: `fireWatch` 가 runClaude 결과를 버리고 `file-watch.fired` 이벤트만 냈다 — 결과를 보내는 `dispatcher.ts` 는 아무도
 * 안 불렀다(«V1 = 발화 자체가 의도»). 그런데 `add_watch` 는 dest_channel 을 필수로 받고 README 예시도 «요약해서 cli/텔레그램으로»
 * 였다. 사용자는 아무것도 못 받는데 기록은 ok.
 *
 * 재는 것 — 진짜 `registerWatcher` + 진짜 chokidar 에 진짜 파일을 만들고:
 *  ① 결과 텍스트가 그 감시의 dest_channel/dest_target 으로 배달 함수에 넘어간다 · 기록 ok
 *  ② 배달이 실패하면 기록이 ok:false(`dispatch: …` — 내용 생성됨·전달 실패, 스케줄러와 같은 모양)
 *  ③ 빈 결과면 보내지 않는다(ok)
 *  ④ ★실제 dispatcher: 등록 안 된 채널이면 throw 해서 ok:false 가 된다(deliverOutbound 는 조용히 delivered:false 를 준다)
 *
 * 등급: **동작**(진짜 fs·chokidar, LLM 은 가짜 runClaude).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

type Firing = { ok: boolean; error?: string };
type Sent = { destChannel: string; destTarget: string | null; text: string };
type WatcherMod = {
  registerWatcher: (row: Record<string, unknown>, bus: unknown, deps: Record<string, unknown>) => void;
  unregisterWatcher: (id: number) => void;
};
// ★src 밖은 계산된 지정자로 — 리터럴이면 `npm run build`(rootDir=src)가 TS6059 로 죽는다.
const loadWatcher = async (): Promise<WatcherMod> =>
  (await import(new URL("../../../plugins/file-watch/src/watcher.ts", import.meta.url).href)) as WatcherMod;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 감시 하나를 띄우고 파일 하나를 만든 뒤 기록이 남을 때까지 기다린다. */
const fireOnce = async (
  mod: WatcherMod,
  id: number,
  opts: { result: string; destChannel: string; destTarget: string | null; dispatch?: (i: Sent) => Promise<void> },
): Promise<{ firings: Firing[] }> => {
  const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-deliver-"));
  const firings: Firing[] = [];
  try {
    mod.registerWatcher(
      {
        id, label: `regr-${id}`, path: dir, pattern: null, recursive: false, debounceMs: 50, eventFilter: "add",
        prompt: "요약: {path}", destChannel: opts.destChannel, destTarget: opts.destTarget, enabled: true,
        createdAt: 0, updatedAt: 0, lastFiredAt: null, lastPath: null, lastEvent: null, lastStatus: null, lastError: null,
      },
      { publish: () => {}, subscribe: () => () => {}, history: () => [] },
      {
        cwd: dir,
        recordFiring: (_id: number, r: Firing) => firings.push({ ok: r.ok, ...(r.error !== undefined ? { error: r.error } : {}) }),
        runClaude: async () => ({ text: opts.result }),
        ...(opts.dispatch !== undefined ? { dispatch: opts.dispatch } : {}),
      },
    );
    await sleep(400); // chokidar 준비
    writeFileSync(path.join(dir, "new.txt"), "x");
    for (let i = 0; i < 80 && firings.length === 0; i++) await sleep(50);
    return { firings };
  } finally {
    mod.unregisterWatcher(id);
    rmSync(dir, { recursive: true, force: true });
  }
};

export const check: RegressionCheck = {
  name: "file-watch-delivers-result",
  guards:
    "파일 감시가 runClaude 결과를 버리고 이벤트만 내 dest_channel 이 장식이던 것 — 사용자는 아무것도 못 받는데 기록은 ok",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const mod = await loadWatcher();

    // ── ① 결과가 목적지로 ────────────────────────────────────────────
    {
      const sent: Sent[] = [];
      const { firings } = await fireOnce(mod, 990_101, {
        result: "새 파일 요약입니다",
        destChannel: "telegram",
        destTarget: "12345",
        dispatch: async (i) => { sent.push({ destChannel: i.destChannel, destTarget: i.destTarget, text: i.text }); },
      });
      out.push(
        assert(
          "★결과 텍스트가 그 감시의 dest_channel/dest_target 으로 넘어가고 기록은 ok",
          sent.length === 1 && sent[0]!.destChannel === "telegram" && sent[0]!.destTarget === "12345" &&
            sent[0]!.text === "새 파일 요약입니다" && firings.length === 1 && firings[0]!.ok,
          `배달 ${JSON.stringify(sent)} · 기록 ${JSON.stringify(firings)}`,
        ),
      );
    }

    // ── ② 배달 실패 = ok:false(내용 생성됨·전달 실패) ─────────────────────
    {
      const { firings } = await fireOnce(mod, 990_102, {
        result: "보낼 내용",
        destChannel: "telegram",
        destTarget: "12345",
        dispatch: async () => { throw new Error("telegram 502"); },
      });
      out.push(
        assert(
          "★배달이 실패하면 기록이 ok:false 이고 사유가 dispatch 로 갈린다",
          firings.length === 1 && !firings[0]!.ok && (firings[0]!.error ?? "").startsWith("dispatch: ") && (firings[0]!.error ?? "").includes("502"),
          `기록 ${JSON.stringify(firings)}`,
        ),
      );
    }

    // ── ③ 빈 결과면 안 보낸다 ─────────────────────────────────────────
    {
      let calls = 0;
      const { firings } = await fireOnce(mod, 990_103, {
        result: "   ",
        destChannel: "telegram",
        destTarget: "12345",
        dispatch: async () => { calls++; },
      });
      out.push(
        assert(
          "빈 결과는 보내지 않는다(기록은 ok)",
          calls === 0 && firings.length === 1 && firings[0]!.ok,
          `배달 ${calls}회 · 기록 ${JSON.stringify(firings)}`,
        ),
      );
    }

    // ── ④ 실제 dispatcher — 미등록 채널이면 조용한 성공이 아니다 ─────────────
    {
      const { firings } = await fireOnce(mod, 990_104, {
        result: "보낼 내용",
        destChannel: "regr-nonexistent-channel",
        destTarget: null,
      });
      out.push(
        assert(
          "★실제 배달 경로: 등록 안 된 채널이면 ok:false(deliverOutbound 의 delivered:false 를 삼키지 않는다)",
          firings.length === 1 && !firings[0]!.ok && (firings[0]!.error ?? "").includes("Watch delivery failed"),
          `기록 ${JSON.stringify(firings)}`,
        ),
      );
    }
    return out;
  },
};
