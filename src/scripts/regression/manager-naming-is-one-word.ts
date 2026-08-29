/**
 * 회귀: **사람에게는 「매니저」, 코드에는 `worker`** — 한 개념에 두 어휘가 안 생기게 (2026-08-29).
 *
 * 2026-07-29 에 개명했다. 이름이 능력 서열과 **반대**였기 때문이다 — 매니저가 서브에이전트보다
 * 유능한데 옛 한국어 이름은 더 하찮게 들리는 말이었다. 그때 정한 선은 이랬다:
 *
 *  | 어디 | 뭐라고 부르나 |
 *  |---|---|
 *  | 화면·모델이 읽는 글·로그·주석 | **매니저** |
 *  | DB(`worker_jobs`)·이벤트(`worker.*`)·도구명 | `worker` 그대로 |
 *
 * ★이 파일엔 옛 한국어 이름이 **한 글자도 없다** — 런타임에 조립한다(아래 `OLD`).
 *
 * ★그런데 **한국어 주석 450건이 개명을 안 따라왔다**(2026-08-29 정태님이 잡음). 화면은
 *  매니저라 하고 코드 주석은 옛 이름 그대로라, 읽는 사람마다 다른 어휘를 갖는다 — 그리고
 *  그 어휘가 다시 화면으로 새어 나오는 게 시간 문제였다.
 *
 * ★**식별자는 일부러 안 바꾼다.** 마이그레이션이 이름값을 못 한다 — 테이블·이벤트를 개명하면
 *  옛 레코드·옛 구독자가 조용히 갈리는데 얻는 건 영문 단어 하나다. 그래서 이 검사는
 *  **양방향**이다: 한국어에서 옛 이름이 사라져야 하고, **동시에** 식별자는 `worker` 로 남아 있어야
 *  한다. 한쪽만 보면 다음 사람이 "일관성" 이라며 테이블을 개명한다.
 *
 * ★`docs/decisions/` 는 **대상이 아니다** — 그날의 기록이고, 고치면 이력을 고쳐 쓰는 것이다
 *  ([[project_hotpath_bound_preserve_record]]: 레코드는 안 지운다).
 *
 * 등급: 소스 대조 — 지키려는 성질이 **글자** 자체다(동작이 아니라 어휘).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** 사는 코드 — `docs/decisions/`(기록)는 뺀다. */
const ROOTS = ["src", "plugins", "packages", "skills", "agents"];
const EXT = /\.(ts|js|md)$/;

/**
 * 찾는 옛 이름 — **런타임에 조립한다.**
 *
 * ★리터럴로 두면 이 파일이 그 단어를 담게 되어 **자기 자신을 잡는다**. 그리고 예외 목록을
 *  만들어 빼는 순간 그건 손으로 관리하는 목록이 된다([[feedback_hand_maintained_lists]]).
 *  조립하면 목록이 필요 없다 — 파일에 그 글자가 아예 없으므로.
 */
const OLD = ["\uc6cc", "\ucee4"].join("");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
};

export const check: RegressionCheck = {
  name: "manager-naming-is-one-word",
  guards:
    "2026-07-29 개명이 화면·모델까지만 닿고 한국어 주석 450건은 옛 이름으로 남아, 같은 개념을 읽는 사람마다 다르게 부르던 것(그 어휘가 화면으로 새는 건 시간 문제였다) + 그걸 고치다 반대로 DB 테이블·이벤트·도구명까지 개명해 옛 레코드·옛 구독자가 조용히 갈리는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 한국어에서 옛 이름이 사라졌다 ───────────────────────────────────────
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const f of walk(path.join(REPO, root))) {
        scanned += 1;
        const src = readFileSync(f, "utf8");
        const n = src.split(OLD).length - 1;
        if (n > 0) offenders.push(`${path.relative(REPO, f)}(${String(n)})`);
      }
    }
    out.push(
      assert(
        `★★사는 코드의 한국어에 「${OLD}」가 없다 — 화면·모델은 「매니저」라 부르는데 주석만 옛 이름이면 읽는 사람마다 어휘가 갈리고, 그 어휘는 결국 화면으로 샌다(${String(scanned)}개 파일 검사)`,
        offenders.length === 0,
        offenders.length === 0
          ? `${String(scanned)}개 파일 · 0건`
          : `★${String(offenders.length)}개 파일: ${offenders.slice(0, 6).join(", ")}`,
      ),
    );

    // ── ② 식별자는 `worker` 그대로 ──────────────────────────────────────────
    // ★반대편을 같이 지킨다. 이게 없으면 다음 사람이 "일관성" 이라며 테이블을 개명하고,
    //  그 순간 옛 레코드가 조용히 사라진다.
    const kept: Array<[string, string, boolean]> = [
      [
        "DB 테이블 `worker_jobs`",
        "src/store/sessions.ts",
        readFileSync(path.join(REPO, "src/store/sessions.ts"), "utf8").includes("worker_jobs"),
      ],
      [
        "이벤트 `worker.started`",
        "src/core/worker-jobs.ts",
        readFileSync(path.join(REPO, "src/core/worker-jobs.ts"), "utf8").includes("worker.started"),
      ],
    ];
    for (const [what, where, ok] of kept) {
      out.push(
        assert(
          `★${what} 은 **개명하지 않는다** — 마이그레이션이 이름값을 못 한다(옛 레코드·옛 구독자가 조용히 갈리는데 얻는 건 영문 단어 하나)`,
          ok,
          ok ? `${where} 에 그대로 있음` : `★사라짐 — 개명했다면 되돌려라`,
        ),
      );
    }
    const toolNames = ["run_in_background", "steer_worker", "cancel_worker", "list_workers"];
    const toolSrc = readFileSync(
      path.join(REPO, "src/core/llm-runtime/capabilities/worker-registry.ts"),
      "utf8",
    );
    const missing = toolNames.filter((n) => !toolSrc.includes(n));
    out.push(
      assert(
        "★도구 이름도 `worker` 그대로 — 도구명은 모델이 부르는 **식별자**다. 바꾸면 옛 대화의 도구 호출이 안 맞는다",
        missing.length === 0,
        missing.length === 0 ? `${String(toolNames.length)}개 전부 있음` : `★없음: ${missing.join(", ")}`,
      ),
    );

    // ── ③ 규칙이 **한 곳에** 적혀 있다 ───────────────────────────────────────
    const home = readFileSync(path.join(REPO, "src/core/worker-jobs.ts"), "utf8");
    out.push(
      assert(
        "★이 갈림의 근거가 개념의 집(`worker-jobs.ts` 머리말)에 적혀 있다 — 규칙만 있고 이유가 없으면 다음 사람이 둘 중 아무 쪽으로나 통일한다",
        home.includes("사람에게는 「매니저」, 코드에는") && home.includes("worker_jobs"),
        home.includes("사람에게는 「매니저」, 코드에는") ? "머리말에 표로 있음" : "★근거 없음",
      ),
    );

    return out;
  },
};
