/**
 * 회귀: **파일 감시가 실행 중에 온 이벤트를 버리지 않는다** (2026-10-09 전체 적대 검토 P3).
 *
 * 사고(검토 재현): overlap 가드(같은 감시의 동시 턴 금지)가 겹친 이벤트를 «overlap skip» 로그 한 줄로 **영구히**
 * 버렸다 — .pdf 3개를 한꺼번에 떨구면 runClaude 1회, 나머지 2개는 아무도 처리하지 않았다.
 *
 * 재는 것 — 진짜 `registerWatcher` + 진짜 chokidar 에 진짜 파일 3개를 동시에 만들고, 첫 runClaude 를 붙잡아 둔다:
 *  ① 세 파일 전부가 어느 턴엔가 넘어간다(유실 0)
 *  ② 동시 턴은 여전히 없다(가드의 목적) · 몰린 것은 한 턴에 묶인다(추가 턴 1회)
 *
 * 등급: **동작**(진짜 fs·chokidar, LLM 은 가짜 runClaude).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

interface Bus {
  publish: (e: unknown) => void;
  subscribe: () => () => void;
  history: () => unknown[];
}
type WatcherMod = {
  registerWatcher: (row: Record<string, unknown>, bus: Bus, deps: Record<string, unknown>) => void;
  unregisterWatcher: (id: number) => void;
};
// ★src 밖은 계산된 지정자로 — 리터럴이면 `npm run build`(rootDir=src)가 TS6059 로 죽는다.
const loadWatcher = async (): Promise<WatcherMod> =>
  (await import(new URL("../../../plugins/file-watch/src/watcher.ts", import.meta.url).href)) as WatcherMod;

export const check: RegressionCheck = {
  name: "file-watch-overlap-not-lost",
  guards: "파일 감시가 실행 중에 온 이벤트(.pdf 3개 동시 → 1회만 처리)를 «overlap skip» 로그만 남기고 영구히 버리던 것",
  run: async (): Promise<Assertion[]> => {
    const { registerWatcher, unregisterWatcher } = await loadWatcher();
    const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-overlap-"));
    const id = 990_001;
    const texts: string[] = [];
    let dispatched = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const firstHeld = new Promise<void>((r) => (release = r));
    try {
      registerWatcher(
        {
          id, label: "regr", path: dir, pattern: ".pdf", recursive: false, debounceMs: 50, eventFilter: "add",
          prompt: "처리: {path}", destChannel: "regr", destTarget: null, enabled: true,
          createdAt: 0, updatedAt: 0, lastFiredAt: null, lastPath: null, lastEvent: null, lastStatus: null, lastError: null,
        },
        { publish: () => {}, subscribe: () => () => {}, history: () => [] },
        {
          cwd: dir,
          recordFiring: () => {},
          // 배달 자체는 `file-watch-delivers-result` 몫 — 여기선 이어서 쏜 턴의 결과도 배달되는지(두 수정의 상호작용)만 센다.
          dispatch: async () => { dispatched++; },
          runClaude: async (input: { text: string }) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            texts.push(input.text);
            if (texts.length === 1) await firstHeld; // 첫 턴을 붙잡아 나머지가 «실행 중» 에 오게 한다
            concurrent--;
            return { text: `결과 ${texts.length}` };
          },
        },
      );
      await new Promise((r) => setTimeout(r, 400)); // chokidar 준비
      for (const n of ["a.pdf", "b.pdf", "c.pdf"]) writeFileSync(path.join(dir, n), n);
      // 첫 턴이 시작되고 나머지 두 이벤트가 도착할 때까지
      for (let i = 0; i < 50 && texts.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 800));
      release();
      for (let i = 0; i < 50 && texts.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
      const covered = ["a.pdf", "b.pdf", "c.pdf"].filter((n) => texts.some((t) => t.includes(n)));
      return [
        assert(
          "★동시에 떨어진 세 파일이 전부 어느 턴엔가 넘어간다(유실 0)",
          covered.length === 3,
          `넘어간 파일 ${covered.join(",")} · 턴 ${texts.length}회 ${JSON.stringify(texts.map((t) => t.replace(dir, "<dir>")))}`,
        ),
        assert(
          "동시 턴은 없다(가드의 목적) · 몰린 것은 한 턴에 묶인다",
          maxConcurrent === 1 && texts.length === 2,
          `최대 동시 ${maxConcurrent} · 턴 ${texts.length}회`,
        ),
        assert(
          "이어서 쏜 턴의 결과도 목적지로 배달된다(겹침 처리 × 배달)",
          dispatched === texts.length && dispatched === 2,
          `배달 ${dispatched}회 · 턴 ${texts.length}회`,
        ),
      ];
    } finally {
      release();
      unregisterWatcher(id);
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
