/**
 * 회귀: **파일감시 이어 발화는 한 번까지 — 턴이 감시 폴더에 쓰면 끝없이 돌던 것** (2026-10-09 수정분 재검토).
 *
 * 겹친 이벤트를 버리지 않고 끝난 뒤 이어서 발화하게 고쳤더니(`file-watch-overlap-not-lost`), 프롬프트가 결과를 **감시 폴더 안에**
 * 쓰면(«요약해서 같은 폴더에 저장») 그 쓰기가 다음 발화를 부르고, 그 턴이 또 쓰고… 9초에 9턴이 돌았다. 결과 배달까지 붙어
 * 돌 때마다 사용자에게 메시지가 갔다. 그리고 실행 중에 감시를 지웠을 때 대기분을 버리는 가드에 그물이 없었다.
 *
 * 지키는 것:
 *  ① 턴이 감시 폴더에 결과를 써도 발화는 2턴(원래 + 이어서 한 번)에서 멈춘다
 *  ② 실행 중에 감시를 지우면 대기분으로 턴을 더 돌리지 않는다
 *  ③ 이어 발화 도중 쌓인 것은 버리지 않고 보류했다가 다음 변경과 함께 처리한다(정당한 파일 유실 0)
 *  ④ 대기가 많으면 경로 50개 + «외 N건» 으로 넘긴다
 *
 * 등급: **동작**(진짜 fs·chokidar, LLM 은 가짜 runClaude).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type Bus = { publish: (e: unknown) => void; subscribe: () => () => void; history: () => unknown[] };
interface WatcherMod {
  registerWatcher: (row: Record<string, unknown>, bus: Bus, deps: Record<string, unknown>) => void;
  unregisterWatcher: (id: number) => void;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const row = (id: number, dir: string, pattern: string): Record<string, unknown> => ({
  id, label: "regr", path: dir, pattern, recursive: false, debounceMs: 50, eventFilter: "add,change",
  prompt: "처리: {path}", destChannel: "regr", destTarget: null, enabled: true,
  createdAt: 0, updatedAt: 0, lastFiredAt: null, lastPath: null, lastEvent: null, lastStatus: null, lastError: null,
});
const bus: Bus = { publish: () => {}, subscribe: () => () => {}, history: () => [] };

export const check: RegressionCheck = {
  name: "file-watch-follow-up-bounded",
  guards: "파일감시 이어 발화가 턴이 감시 폴더에 쓴 자기 출력을 끝없이 다시 먹던 것 · 실행 중 지운 감시의 대기분 처리",
  run: async (): Promise<Assertion[]> => {
    const { registerWatcher, unregisterWatcher } = (await import(
      new URL("../../../plugins/file-watch/src/watcher.ts", import.meta.url).href
    )) as WatcherMod;
    const out: Assertion[] = [];

    // ① 턴이 감시 폴더에 결과를 쓴다
    const loopDir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-loop-"));
    const loopId = 990_101;
    let turns = 0;
    try {
      registerWatcher(row(loopId, loopDir, ".md"), bus, {
        cwd: loopDir,
        recordFiring: () => {},
        dispatch: async () => {},
        runClaude: async () => {
          turns++;
          await sleep(150);
          writeFileSync(path.join(loopDir, `summary-${String(turns)}.md`), "요약"); // 일하는 도중 감시 폴더에 쓴다
          await sleep(500);
          return { text: "완료" };
        },
      });
      await sleep(400);
      writeFileSync(path.join(loopDir, "note.md"), "원본");
      await sleep(4500);
      out.push(assert("① 턴이 감시 폴더에 결과를 써도 2턴(원래 + 이어서 한 번)에서 멈춘다", turns === 2, `4.5초 동안 턴 ${String(turns)}회`));
    } finally {
      unregisterWatcher(loopId);
      rmSync(loopDir, { recursive: true, force: true });
    }

    // ② 실행 중에 감시를 지운다
    const delDir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-del-"));
    const delId = 990_102;
    let delTurns = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    try {
      registerWatcher(row(delId, delDir, ".pdf"), bus, {
        cwd: delDir,
        recordFiring: () => {},
        dispatch: async () => {},
        runClaude: async () => {
          delTurns++;
          if (delTurns === 1) await held;
          return { text: "완료" };
        },
      });
      await sleep(400);
      writeFileSync(path.join(delDir, "a.pdf"), "a");
      for (let i = 0; i < 40 && delTurns === 0; i++) await sleep(50);
      writeFileSync(path.join(delDir, "b.pdf"), "b"); // 실행 중 → 대기
      await sleep(600);
      unregisterWatcher(delId);
      release();
      await sleep(600);
      out.push(assert("② 실행 중에 지운 감시는 대기분으로 턴을 더 돌리지 않는다", delTurns === 1, `턴 ${String(delTurns)}회`));
    } finally {
      release();
      unregisterWatcher(delId);
      rmSync(delDir, { recursive: true, force: true });
    }
    // ③ 이어 발화가 도는 동안 사용자가 떨군 **정당한** 파일은 버리지 않고 다음 변경 때 함께 처리한다(재확인 검토: c.pdf 가 영구히 빠졌다)
    const keepDir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-keep-"));
    const keepId = 990_103;
    const keepTexts: string[] = [];
    try {
      registerWatcher(row(keepId, keepDir, ".pdf"), bus, {
        cwd: keepDir,
        recordFiring: () => {},
        dispatch: async () => {},
        runClaude: async (input: { text: string }) => {
          keepTexts.push(input.text);
          await sleep(900);
          return { text: "완료" };
        },
      });
      await sleep(400);
      writeFileSync(path.join(keepDir, "a.pdf"), "a"); // 턴1
      await sleep(300);
      writeFileSync(path.join(keepDir, "b.pdf"), "b"); // 턴1 중 → 이어 발화(턴2)
      for (let i = 0; i < 60 && keepTexts.length < 2; i++) await sleep(50);
      await sleep(200);
      writeFileSync(path.join(keepDir, "c.pdf"), "c"); // 턴2(이어 발화) 중 → 상한 → 보류
      await sleep(1800);
      writeFileSync(path.join(keepDir, "d.pdf"), "d"); // 다음 변경 — 보류분과 함께
      for (let i = 0; i < 60 && !keepTexts.some((t) => t.includes("d.pdf")); i++) await sleep(50);
      await sleep(200);
      const lastHasBoth = keepTexts.some((t) => t.includes("c.pdf") && t.includes("d.pdf"));
      out.push(assert("③ 이어 발화 중 떨군 파일은 보류됐다가 다음 변경과 함께 처리된다(유실 0)", lastHasBoth, keepTexts.map((t) => t.replace(keepDir, "<dir>").replace(/\n/g, " | "))));
    } finally {
      unregisterWatcher(keepId);
      rmSync(keepDir, { recursive: true, force: true });
    }

    // ④ 대기가 많으면 경로 50개 + «외 N건» 으로 넘긴다(폴더 통째 복사가 거대한 프롬프트 한 턴이 되지 않게)
    const bulkDir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-bulk-"));
    const bulkId = 990_104;
    const bulkTexts: string[] = [];
    let releaseBulk!: () => void;
    const bulkHeld = new Promise<void>((r) => (releaseBulk = r));
    try {
      registerWatcher(row(bulkId, bulkDir, ".pdf"), bus, {
        cwd: bulkDir,
        recordFiring: () => {},
        dispatch: async () => {},
        runClaude: async (input: { text: string }) => {
          bulkTexts.push(input.text);
          if (bulkTexts.length === 1) await bulkHeld;
          return { text: "완료" };
        },
      });
      await sleep(400);
      writeFileSync(path.join(bulkDir, "first.pdf"), "x");
      for (let i = 0; i < 40 && bulkTexts.length === 0; i++) await sleep(50);
      for (let i = 0; i < 60; i++) writeFileSync(path.join(bulkDir, `f${String(i)}.pdf`), "x");
      await sleep(1200);
      releaseBulk();
      for (let i = 0; i < 60 && bulkTexts.length < 2; i++) await sleep(50);
      const second = bulkTexts[1] ?? "";
      const lines = second.split("\n").filter((l) => l.includes(".pdf")).length;
      out.push(assert("④ 대기 60건은 경로 50개 + «외 10건» 으로 넘긴다", lines === 50 && second.includes("외 10건"), { 경로줄: lines, 꼬리: second.slice(-30) }));
    } finally {
      releaseBulk();
      unregisterWatcher(bulkId);
      rmSync(bulkDir, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
