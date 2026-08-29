/**
 * 회귀: **"끌 수 없는 모듈" 은 손 목록이 아니라 선언이다** (2026-08-26).
 *
 * ★종전엔 이 판정이 **손 목록 두 벌**이었다:
 *   - `plugins/http-bridge/index.ts` 의 `CRITICAL_MODULE_NAMES = {dashboard, http-bridge}`
 *   - 그것을 베낀 `packages/dashboard/js/view-providers.js` 의 미러 — 그 주석이 **스스로**
 *     *"이 미러가 드리프트된 경우 대비"* 라고 적고 있었다([[feedback_hand_maintained_lists]]).
 *
 * 이제 manifest `tiguclaw.core` 선언을 인벤토리가 실어주고, 토글 경로가 그걸 읽는다.
 *
 * ★**유효성은 선언이 아니라 위치로 판정한다** — 레포 `plugins/` 만 본다. 설치된 플러그인이
 *  `core:true` 를 적어도 코어가 되지 않는다(자기 선언은 검증할 수 없다). 그래서
 *  `isCoreModule` 은 **이름이 번들에 없으면 무조건 false** 다.
 *
 * ★그리고 코어는 경고가 아니라 **거절**이다. 브리지를 끄면 대시보드가 죽는 것보다 더 나쁜
 *  일이 있다 — 다시 켤 경로(`setModuleDisabled` 호출부)가 브리지 하나뿐이라 **제품 안에서
 *  되돌릴 수 없게 된다.**
 *
 * 등급: 동작 검사 — 진짜 매니페스트를 읽는 `isCoreModule` 과 인벤토리 수집을 부른다.
 */
import { probeInterpreter } from "./_probe-helpers.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCoreModule } from "../../core/plugins/inventory.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "module-core-is-declared",
  guards:
    "끌 수 없는 모듈이 백엔드·프런트 손 목록 두 벌로 관리돼 드리프트하던 것(미러 주석이 스스로 그 위험을 적고 있었다) + 브리지를 끄면 다시 켤 경로가 사라져 제품 안에서 되돌릴 수 없게 되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 선언 — 번들 매니페스트를 직접 읽어 "코어라고 적힌 것" 집합을 만든다.
    const dirs = (
      await fs.readdir(path.join(REPO, "plugins"), { withFileTypes: true })
    )
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const declared: string[] = [];
    for (const d of dirs) {
      const raw = await fs.readFile(
        path.join(REPO, "plugins", d, "package.json"),
        "utf8",
      );
      const m = (JSON.parse(raw) as { tiguclaw?: { name?: string; core?: boolean } })
        .tiguclaw;
      if (m?.core === true && typeof m.name === "string") declared.push(m.name);
    }

    out.push(
      assert(
        "★코어로 선언된 번들은 http-bridge 하나다",
        declared.length === 1 && declared[0] === "http-bridge",
        JSON.stringify(declared),
      ),
    );

    // ② 판정 — 선언이 실제로 판정 함수까지 흐르는가(선언만 있고 아무도 안 읽으면 죽은 계약).
    out.push(
      assert(
        "isCoreModule 이 선언을 읽는다",
        isCoreModule("http-bridge"),
        `isCoreModule("http-bridge")=${String(isCoreModule("http-bridge"))}`,
      ),
    );
    out.push(
      assert(
        "코어 아닌 번들은 false — 전부 코어가 되지 않는다",
        !isCoreModule("scheduler") && !isCoreModule("telegram-channel"),
        `scheduler=${String(isCoreModule("scheduler"))} telegram=${String(
          isCoreModule("telegram-channel"),
        )}`,
      ),
    );
    out.push(
      assert(
        "★번들에 없는 이름은 무조건 false(자기 선언으로 코어가 될 수 없다)",
        !isCoreModule("some-installed-plugin"),
        `isCoreModule("some-installed-plugin")=${String(
          isCoreModule("some-installed-plugin"),
        )}`,
      ),
    );

    // ③ 손 목록이 되살아나지 않았는가 — 미러가 다시 생기면 드리프트도 다시 생긴다.
    const front = await fs.readFile(
      path.join(REPO, "packages/dashboard/js/view-providers.js"),
      "utf8",
    );
    out.push(
      assert(
        "프런트가 http-bridge 를 이름으로 하드코딩하지 않는다",
        !/["']http-bridge["']/.test(front),
        /["']http-bridge["']/.test(front) ? "하드코딩 발견" : "하드코딩 0건",
      ),
    );
    out.push(
      assert(
        "프런트가 선언(item.core)으로 토글을 가른다",
        front.includes("provider.core !== true"),
        front.includes("provider.core !== true") ? "게이트 있음" : "게이트 없음",
      ),
    );

    // ④ 되돌림 — 켜는 경로가 여전히 브리지 하나뿐인지 센다. 하나뿐이라는 사실이 곧
    //    "코어를 끄면 안 되는" 이유이므로, 이 수가 늘면 그때 정책을 다시 본다.
    const bridge = await fs.readFile(
      path.join(REPO, "plugins/http-bridge/index.ts"),
      "utf8",
    );
    out.push(
      assert(
        "★코어를 끄려는 요청은 거절된다(경고가 아니라)",
        bridge.includes("isCoreModule(name)"),
        bridge.includes("isCoreModule(name)") ? "거절 가드 있음" : "가드 없음",
      ),
    );

    // ── ⑤ ★**엔드포인트를 건너뛰어도 코어는 안 꺼진다** (v0.40.0 적대 검토 F2) ────────────
    //  종전엔 보호가 ④(HTTP 엔드포인트)에만 있었고 로더는 `isModuleDisabled` 만 봤다.
    //  그래서 `settings.json` 에 한 줄 쓰면 브리지가 안 뜨고, **다시 켤 경로가 그 브리지
    //  하나뿐이라** 제품 안에서 되돌릴 수 없었다. 그리고 이 경로는 이론이 아니다 —
    //  설정을 쓰는 도구를 비서에게 준 적이 없어 비서는 JSON 을 직접 고칠 수밖에 없다.
    //
    //  ★**실행해서 본다.** ④는 문자열 grep 이라 거절을 경고로 강등해도 통과한다(F3).
    //   격리 홈에 진짜 `settings.json` 을 쓰고 `loadPlugins` 를 **부른다**.
    //
    //  ★**자식 프로세스여야 한다.** 첫 판은 이 프로세스 안에서 `process.env.TIGUCLAW_HOME`
    //   을 바꿨는데, `getPaths()` 가 **메모이즈**돼 있어(paths.ts `cached`) 앞선 검사가 이미
    //   홈을 고정한 뒤였다 — **단독 실행은 초록, 스위트 안에선 빨강**인 순서 의존 검사가
    //   됐다. 검사가 자기 순서에 따라 답이 달라지면 그건 검사가 아니다.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tgc-core-"));
    let loaded: string[] = [];
    let active: Record<string, boolean> = {};
    try {
      await fs.writeFile(
        path.join(tmp, "settings.json"),
        JSON.stringify({ modules: { disabled: ["http-bridge", "scheduler"] } }),
        "utf8",
      );
      // ★`tsx -e` 는 cjs 로 내보내서 **최상위 await 이 안 된다**(첫 판이 그걸로 죽었다).
      //  async IIFE 로 감싼다.
      const probe = `void (async () => {
        const { loadPlugins } = await import(${JSON.stringify(path.join(REPO, "src/core/plugins/loader.ts"))});
        const { isModuleActive } = await import(${JSON.stringify(path.join(REPO, "src/core/plugins/inventory.ts"))});
        const names = (await loadPlugins(${JSON.stringify(path.join(REPO, "plugins"))})).map((p) => p.manifest.name);
        console.log("__J__" + JSON.stringify({ loaded: names,
          active: { "http-bridge": isModuleActive("http-bridge"), scheduler: isModuleActive("scheduler") } }));
      })();`;
      const r = spawnSync(probeInterpreter(REPO), ["-e", probe], {
        cwd: tmp, // ★프로젝트 레이어도 임시 디렉터리로 — 레포의 `.tiguclaw/` 가 안 섞이게.
        env: { ...process.env, TIGUCLAW_HOME: tmp },
        encoding: "utf8",
        timeout: 120_000,
      });
      const line = `${r.stdout ?? ""}`.split("\n").find((l) => l.startsWith("__J__"));
      const parsed = line === undefined
        ? undefined
        : (JSON.parse(line.slice(5)) as { loaded: string[]; active: Record<string, boolean> });
      loaded = parsed?.loaded ?? [];
      active = parsed?.active ?? {};
      out.push(
        assert(
          "★프로브가 실제로 돌았다(0이면 아래는 미검사다)",
          parsed !== undefined && loaded.length > 0,
          parsed === undefined
            ? `★프로브 실패 — ${`${r.stderr ?? ""}`.slice(-200)}`
            : `로드 ${loaded.length}개`,
        ),
        assert(
          "★코어는 `disabled` 목록에 있어도 뜬다(엔드포인트를 건너뛴 경로)",
          loaded.includes("http-bridge"),
          loaded.includes("http-bridge")
            ? "http-bridge 생존"
            : `★settings.json 한 줄로 꺼졌다 — 되돌릴 경로가 없다. 로드됨: ${loaded.join(", ")}`,
        ),
        assert(
          "★그렇다고 전부 못 끄는 건 아니다(비코어는 여전히 꺼진다)",
          !loaded.includes("scheduler") && loaded.length > 0,
          `scheduler 꺼짐=${!loaded.includes("scheduler")} · 로드 ${loaded.length}개: ${loaded.join(", ")}`,
        ),
        assert(
          "★화면과 실제가 같은 함수를 쓴다(인벤토리 `enabled` == 로더 판정)",
          active["http-bridge"] === loaded.includes("http-bridge") &&
            active.scheduler === loaded.includes("scheduler"),
          `active(bridge)=${String(active["http-bridge"])}/로드=${loaded.includes("http-bridge")} · ` +
            `active(scheduler)=${String(active.scheduler)}/로드=${loaded.includes("scheduler")}`,
        ),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }

    return out;
  },
};
