/**
 * 회귀: **파일 감시에 이름 필터를 줘도 이벤트가 온다** — 필터는 파일에만, 폴더는 순회한다 (2026-10-08 외부 검토 F4).
 *
 * 사고(검토 재현): `add_watch(pattern: ".txt", recursive)` 의 chokidar `ignored` 가 경로 전체에 패턴을 걸어, 감시 루트·중간 폴더가
 * `.txt` 를 안 담으니 순회에서 통째로 빠졌다 — 필터 없는 감시는 add 1, `.txt` 필터 감시는 0. 필터를 준 감시는 아무것도 못 받았다.
 *
 * 등급: **동작** — 제품이 만드는 옵션(`chokidarOptionsFor`)을 **실제 chokidar** 에 넣고 진짜 파일을 만든다.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { watch } from "chokidar";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

// ★src 밖은 계산된 지정자로 — 리터럴이면 `npm run build`(rootDir=src)가 TS6059 로 죽는다(`src-stays-inside-src`).
type WatcherMod = {
  chokidarOptionsFor: (row: { path: string; recursive: boolean; debounceMs: number; pattern: string | null }) => Parameters<typeof watch>[1];
};
const loadWatcher = async (): Promise<WatcherMod> =>
  (await import(new URL("../../../plugins/file-watch/src/watcher.ts", import.meta.url).href)) as WatcherMod;

const collect = async (dir: string, pattern: string | null): Promise<string[]> => {
  const { chokidarOptionsFor } = await loadWatcher();
  const seen: string[] = [];
  const w = watch(dir, chokidarOptionsFor({ path: dir, recursive: true, debounceMs: 50, pattern }));
  // ★여기서 다시 거르지 않는다 — 제품의 `ignored` 만으로 걸러지는지 본다(검사가 필터를 스스로 걸면 제품 필터를 지워도 초록이었다).
  w.on("add", (p) => { seen.push(path.relative(dir, p).split(path.sep).join("/")); });
  await new Promise<void>((r) => w.once("ready", () => r()));
  writeFileSync(path.join(dir, "a.txt"), "a");
  writeFileSync(path.join(dir, "b.log"), "b");
  writeFileSync(path.join(dir, "sub", "c.txt"), "c");
  for (let i = 0; i < 40 && seen.length < (pattern === null ? 3 : 2); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 400)); // 늦게 오는 잘못된 이벤트까지 본다
  await w.close();
  return seen.sort();
};

export const check: RegressionCheck = {
  name: "file-watch-pattern-reaches-files",
  guards: "파일 감시에 이름 필터(.txt 등)를 주면 감시 루트·폴더까지 제외돼 아무 이벤트도 안 오던 것",
  run: async (): Promise<Assertion[]> => {
    const root = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-"));
    try {
      // 루트 폴더 이름에 패턴이 들어 있다 — 절대경로에 걸면 필터가 무력해진다
      const filtered = path.join(root, "notes.txt-dir");
      const plain = path.join(root, "plain");
      for (const d of [filtered, plain]) mkdirSync(path.join(d, "sub"), { recursive: true });
      const withPattern = await collect(filtered, ".txt");
      const without = await collect(plain, null);
      return [
        assert("★필터(.txt)를 준 감시가 루트와 하위 폴더의 .txt 를 받고 .log 는 안 받는다", withPattern.join(",") === "a.txt,sub/c.txt", withPattern),
        assert("필터 없는 감시는 전부 받는다(대조군)", without.join(",") === "a.txt,b.log,sub/c.txt", without),
      ];
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
};
