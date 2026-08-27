/**
 * 회귀: **스냅샷과 이벤트가 서로 순서를 안다** (2026-08-27, Phase 1).
 *
 * ★고친 사고가 아니라 **없던 계약**을 짓는 것이다. 감사 실측
 *  (`docs/decisions/2026-08-27-frontend-architecture.md` §A.4): 실시간 경로에
 *  `resource`·`revision`·`eventId` 가 **0곳**이었다. 스냅샷(`GET /worker-jobs`)과 이벤트
 *  (`worker.*`)가 서로 순서를 모르니, 화면이 재연결마다 손으로 병합해야 했고 그 대가가
 *  `sse.js`·`background-drawer.js` 의 **"재연결 replay 방어" 주석 6곳**이다 —
 *  중복 렌더 · 짝 없는 진행표시 · 과거 메시지가 바닥에 붙음 · 끝난 잡이 도는 것처럼 보임.
 *
 * 계약은 한 줄이다: **`event.revision === local.revision + 1` 일 때만 적용.**
 * 크면 스냅샷 재요청, 작거나 같으면 버림, 세대(epoch)가 다르면 스냅샷 재요청.
 *
 * ★이 검사가 지키는 것 셋:
 *  ① **판정이 맞는가** — 순수 함수를 실제로 부른다(진리표 전수).
 *  ② **둘이 같은 값을 말하는가** — 이벤트를 실제로 발행하고, 스냅샷 좌표와 대조한다.
 *     여기가 갈리면 화면은 영원히 스냅샷만 다시 받는다(조용한 성능 붕괴).
 *  ③ **기존 화면이 안 깨지는가** — 응답에서 `jobs` 키가 사라지면 지금 드로어가 죽는다.
 *
 * 등급: **동작 검사** — 리비전·판정은 직접 호출, 발행은 자식 프로세스에서 버스를 태운다
 * (`getPaths()` 메모이즈 때문에 홈을 바꾸려면 프로세스를 갈라야 한다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RUNNING_WORK,
  bumpRevision,
  currentRevision,
  decideApply,
  revisionEpoch,
  stampFor,
} from "../../core/resource-revision.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "resource-revision-contract",
  guards:
    "스냅샷과 실시간 이벤트가 서로 순서를 몰라 재연결마다 손으로 병합하던 것 — 중복 렌더·짝 없는 진행표시·끝난 잡이 다시 도는 것처럼 보이던 사고들이 각각 따로 막혀 있었다(방어 주석 6곳)",
  run: async (): Promise<Assertion[]> => {
    const E = revisionEpoch();
    const other = `${E}-other`;

    // ── ① 판정 진리표 — 전수 ──
    const cases: Array<[string, Parameters<typeof decideApply>[0], number, string]> = [
      ["스냅샷 전", null, 1, "resnapshot"],
      ["세대 다름", { epoch: other, revision: 5 }, 6, "resnapshot"],
      ["바로 다음", { epoch: E, revision: 5 }, 6, "apply"],
      ["같은 것 재수신", { epoch: E, revision: 5 }, 5, "ignore"],
      ["과거 replay", { epoch: E, revision: 5 }, 2, "ignore"],
      ["한 칸 건너뜀", { epoch: E, revision: 5 }, 7, "resnapshot"],
      ["멀리 건너뜀", { epoch: E, revision: 5 }, 999, "resnapshot"],
    ];
    const wrong = cases.filter(
      ([, local, rev, want]) => decideApply(local, { epoch: E, revision: rev }) !== want,
    );

    // ── 리비전 자체 ──
    const before = currentRevision(RUNNING_WORK);
    const a = bumpRevision(RUNNING_WORK);
    const b = bumpRevision(RUNNING_WORK);

    // ── ② 발행과 스냅샷이 같은 값을 말하는가 — 자식 프로세스에서 **실제로 발행**한다 ──
    const probe = `void (async () => {
      const rr = await import(${JSON.stringify(path.join(REPO, "src/core/resource-revision.ts"))});
      const { getEventBus } = await import(${JSON.stringify(path.join(REPO, "src/core/eventbus.ts"))});
      const seen = [];
      getEventBus().subscribe((e) => {
        if (typeof e.type === "string" && e.type.startsWith("worker.")) seen.push(e.payload);
      });
      const { initStore } = await import(${JSON.stringify(path.join(REPO, "src/store/sessions.ts"))});
      initStore();
      const wj = await import(${JSON.stringify(path.join(REPO, "src/core/worker-jobs.ts"))});
      // 실제 lifecycle 경로를 태운다(등록 → 완료). 내부 헬퍼를 직접 부르지 않는다.
      const id = wj.registerJob({ label: "probe", threadKey: "dashboard:probe", cwd: process.cwd() });
      wj.markDone(id, "ok");
      const snap = rr.stampFor(rr.RUNNING_WORK);
      console.log("__J__" + JSON.stringify({
        events: seen.map((p) => ({ resource: p.resource, epoch: p.epoch, revision: p.revision })),
        snapshot: snap,
      }));
    })();`;
    const r = spawnSync(path.join(REPO, "node_modules/.bin/tsx"), ["-e", probe], {
      cwd: REPO,
      env: { ...process.env },
      encoding: "utf8",
      timeout: 120_000,
    });
    const line = `${r.stdout ?? ""}`.split("\n").find((l) => l.startsWith("__J__"));
    const live = line === undefined
      ? undefined
      : (JSON.parse(line.slice(5)) as {
          events: Array<{ resource?: string; epoch?: string; revision?: number }>;
          snapshot: { resource: string; epoch: string; revision: number };
        });

    // ── ③ 배선 ──
    const bridge = readFileSync(path.join(REPO, "plugins/http-bridge/index.ts"), "utf8");
    const jobs = readFileSync(path.join(REPO, "src/core/worker-jobs.ts"), "utf8");

    const out: Assertion[] = [
      assert(
        "★적용 판정이 진리표대로다(적용·무시·재요청)",
        wrong.length === 0,
        wrong.length === 0
          ? `${cases.length}케이스 통과`
          : `★틀림: ${wrong.map(([n, , rev, want]) => `${n}(rev ${rev}, 기대 ${want})`).join(" / ")}`,
      ),
      assert(
        "★리비전은 단조 증가한다(같은 값이 두 번 나오지 않는다)",
        a === before + 1 && b === a + 1,
        `${before} → ${a} → ${b}`,
      ),
      assert(
        "★세대(epoch)는 부팅마다 다르다 — 재시작 뒤 옛 리비전이 '더 최신' 으로 오판되지 않게",
        /const EPOCH = /.test(
          readFileSync(path.join(REPO, "src/core/resource-revision.ts"), "utf8"),
        ) && revisionEpoch() !== "",
        `epoch=${revisionEpoch()}`,
      ),
      assert(
        "★프로브가 실제로 돌았다(0이면 아래는 미검사다)",
        live !== undefined && live.events.length > 0,
        live === undefined
          ? `★실패 — ${`${r.stderr ?? ""}`.slice(-220)}`
          : `이벤트 ${live.events.length}건`,
      ),
    ];
    if (live === undefined) return out;

    const stamped = live.events.filter(
      (e) => e.resource === RUNNING_WORK && typeof e.revision === "number" && e.epoch !== undefined,
    );
    const revs = live.events.map((e) => e.revision ?? -1);
    out.push(
      assert(
        "★lifecycle 이벤트가 **전부** 좌표를 싣는다(하나라도 빠지면 그 지점에서 순서가 끊긴다)",
        stamped.length === live.events.length,
        `${stamped.length}/${live.events.length}건`,
      ),
      assert(
        "★이벤트 리비전이 발행 순서대로 1씩 는다",
        revs.every((v, i) => i === 0 || v === (revs[i - 1] as number) + 1),
        JSON.stringify(revs),
      ),
      assert(
        "★★스냅샷과 마지막 이벤트가 **같은 값**을 말한다(갈리면 화면이 영원히 스냅샷만 받는다)",
        live.snapshot.revision === revs[revs.length - 1] &&
          live.snapshot.epoch === live.events[0]?.epoch,
        `스냅샷 rev=${live.snapshot.revision} · 마지막 이벤트 rev=${revs[revs.length - 1]} · epoch 일치=${live.snapshot.epoch === live.events[0]?.epoch}`,
      ),
      // ── 배선 ──
      assert(
        "★발행 자리에서 **정확히 한 번** 올린다(두 곳이면 헛된 재요청, 없으면 조용히 안 따라온다)",
        (jobs.match(/bumpRevision\(RUNNING_WORK\)/g) ?? []).length === 1,
        `bumpRevision 호출 ${(jobs.match(/bumpRevision\(/g) ?? []).length}곳`,
      ),
      assert(
        "★스냅샷 엔드포인트가 좌표를 싣는다 + **목록보다 먼저** 읽는다(잃어버린 갱신 방지)",
        /const stamp = stampFor\(RUNNING_WORK\);\n\s+const jobs = listJobs/.test(bridge) &&
          /writeJson\(res, 200, \{ \.\.\.stamp, items: jobs/.test(bridge),
        `먼저 읽음=${/const stamp = stampFor\(RUNNING_WORK\);\n\s+const jobs = listJobs/.test(bridge)}`,
      ),
      // ★기존 화면을 깨지 않는다 — 증분의 조건이다.
      assert(
        "★응답이 옛 키(`jobs`)를 그대로 유지한다(지금 드로어가 그걸 읽는다)",
        /items: jobs, jobs \}/.test(bridge),
        /jobs \}/.test(bridge) ? "jobs 유지" : "★옛 키를 지우면 백그라운드 뷰가 죽는다",
      ),
    );
    return out;
  },
};
