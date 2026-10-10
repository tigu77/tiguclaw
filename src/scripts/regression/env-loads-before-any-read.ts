/**
 * 회귀: **`.env` 는 어떤 모듈이 env 를 읽기 전에 올라간다** (2026-10-09 전체 적대 검토).
 *
 * 사고: 진입점의 load-env import 에 «★가장 먼저» 라는 주석이 붙어 있었는데 실제로는 16번째 줄이었다. ESM 은 앞선
 *  import 를 의존성째 먼저 평가하므로 reply-command·slash-commands 가 끌고 온 worker-jobs·codex 압축·idle-timeout
 *  등이 모듈 상단에서 env 를 읽어 굳혔다 — 홈 `.env` 에 적은 `WORKER_TIMEOUT_MS`·`MCP_CALL_TIMEOUT_MS`·`CODEX_*`
 *  압축 12종 등 29개 키가 **아무 경고 없이** 무시됐다(셸 env 로 주면 먹으니 더 안 보였다).
 *
 * ★주석은 순서를 지키지 못한다 — 자식이 진입점의 import 를 **소스 순서대로** 실제로 올려, 로더가 돌기 전에 읽힌
 *  키를 센다(`_env-first-child.ts`). load-env 를 한 줄이라도 뒤로 밀면 그 앞 모듈의 상단 읽기가 그대로 잡힌다.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { tsxLoaderUrl } from "./_probe-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

export const check: RegressionCheck = {
  name: "env-loads-before-any-read",
  guards: "진입점에서 load-env 가 16번째 import 라 앞선 모듈들이 env 를 먼저 읽어 홈 .env 의 29개 키가 조용히 무시되던 것",
  run: async (): Promise<Assertion[]> => {
    const r = spawnSync(process.execPath, ["--import", tsxLoaderUrl(REPO) ?? "tsx", path.join(HERE, "_env-first-child.ts")], {
      encoding: "utf8",
      env: { ...process.env },
      timeout: 60_000,
    });
    let got: { boundarySeen?: boolean; imported?: string[]; early?: [string, string][] } = {};
    try {
      got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as typeof got;
    } catch {
      got = {};
    }
    const out: Assertion[] = [];
    out.push(
      assert(
        "자식이 진입점 import 를 실제로 올리고 로더 경계를 지났다(빈손 통과 금지)",
        got.boundarySeen === true && (got.imported?.length ?? 0) >= 1,
        got.boundarySeen === true
          ? `올린 모듈 ${got.imported?.length ?? 0}개 (${(got.imported ?? []).join(", ")})`
          : `★프로브 실패: ${(r.stderr ?? "").trim().slice(-300)}`,
      ),
    );
    const early = got.early ?? [];
    out.push(
      assert(
        "★.env 로드 전에 읽힌 env 키 0건(홈 .env 가 모든 설정을 덮을 수 있다)",
        got.boundarySeen === true && early.length === 0,
        early.length === 0
          ? `로드 전 읽기 0건 · 로더 앞 모듈 ${Math.max(0, (got.imported?.length ?? 1) - 1)}개`
          : `${early.length}건: ${early.slice(0, 8).map(([k, f]) => `${k} ← ${f.replace(/^at\s+/, "").replace(REPO, "")}`).join(" · ")}`,
      ),
    );
    return out;
  },
};
