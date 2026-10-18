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
  // ★«ready» 는 «운영체제 감시가 켜졌다» 가 아니다 (2026-10-17 실측) — 맥에서 chokidar 가 ready 를 낸 뒤에도 그 아래 감시가 아직
  //  안 켜졌을 수 있고, 부하가 있으면 그 틈이 길어진다. 그 틈에 만든 파일은 운영체제가 아예 안 알린다(`raw` 0건 — 나중 변경 때 폴더를
  //  다시 훑어야 보인다). 전체 스위트에서 가끔 빨갛던 원인이 이것이다(프로세스 8개 동시 실행으로 재현: ready 직후 쓰면 3/8 빠짐 ·
  //  300ms 뒤 쓰면 8/8). 그래서 **루트와 하위 폴더 각각에서 운영체제 알림이 실제로 오는 것을 확인한 뒤** 시험 파일을 한 번 쓴다.
  //  재시도로 통과시키지 않는다 — 시험 파일은 한 번만 쓰고, 필터가 폴더를 빼는 원래 결함이면 여전히 아무것도 안 온다.
  const probes = new Map([[path.join(dir, "zz-live.probe"), false], [path.join(dir, "sub", "zz-live.probe"), false]]);
  // 알림의 «감시 폴더 + 이벤트 경로» 가 표지 파일이면 그 자리가 켜진 것이다. ★감시 폴더만 비교하지 않는다 — 윈도우는 루트 하나로
  //  하위까지 재귀 감시해서(감시 폴더가 늘 루트·이벤트 경로가 `sub\…`) 하위 표지가 영영 안 맞아 시한까지 기다렸다(실측 18.5초 · 맥 1.6초).
  w.on("raw", (_e, evPath, details) => {
    const watched = (details as { watchedPath?: string } | undefined)?.watchedPath;
    if (watched === undefined || typeof evPath !== "string") return;
    const hit = path.resolve(watched, evPath);
    for (const f of probes.keys()) if (hit === f || (path.dirname(f) === watched && path.basename(evPath) === path.basename(f))) probes.set(f, true);
  });
  for (let i = 0; i < 40 && [...probes.values()].includes(false); i++) {
    for (const [f, live] of probes) if (!live) writeFileSync(f, String(i));
    await new Promise((r) => setTimeout(r, 200));
  }
  writeFileSync(path.join(dir, "a.txt"), "a");
  writeFileSync(path.join(dir, "b.log"), "b");
  writeFileSync(path.join(dir, "sub", "c.txt"), "c");
  for (let i = 0; i < 40 && seen.length < (pattern === null ? 3 : 2); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 400)); // 늦게 오는 잘못된 이벤트까지 본다
  await w.close();
  // 표지 파일은 시험 대상이 아니다(필터 판정과 무관한 이름) — 시험 파일 셋만 본다.
  return seen.filter((f) => !f.endsWith("zz-live.probe")).sort();
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
