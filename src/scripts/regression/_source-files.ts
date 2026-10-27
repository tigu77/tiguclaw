import { readdirSync } from "node:fs";
import path from "node:path";

/** 검사 대상 — 배포되는 코드와 개발 스크립트 전부. 폴더에서 **유도**한다(손 목록 금지). */
// gitignored 라는 이유만으로 검사에서 빼지 않는다.
export const SOURCE_ROOTS = ["src", "plugins", "packages", "bin", "_workspace"];

/** mutation-hunt 의 복제본 전용 자리. 보존 증거(_workspace/hunt)는 여기에 넣지 않는다. */
export const CLONE_CONTAINER = "_workspace/clones";

/** 두 소스 검사의 동일한 순회·제외 정책을 한 곳에서 적용한다. */
export const listSourceFiles = (repoRoot: string): string[] => {
  const cloneContainer = path.resolve(repoRoot, CLONE_CONTAINER);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // ★`rt-*` 는 적대 검토가 만든 **트리 사본**이다 — 원본을 고치면 같이 사라지므로 센다면
      //  같은 결함을 두 번 세게 된다. `node_modules`·`dist` 는 우리 코드가 아니다.
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith("rt-")) continue;
        // 이름이 같은 다른 폴더가 아니라 레포 루트의 전용 컨테이너 하나만 제외한다.
        if (full === cloneContainer) continue;
        walk(full);
      } else if (e.name.endsWith(".ts") || e.name.endsWith(".mts") || e.name.endsWith(".mjs")) {
        out.push(full);
      }
    }
  };
  for (const root of SOURCE_ROOTS) walk(path.resolve(repoRoot, root));
  return out;
};
