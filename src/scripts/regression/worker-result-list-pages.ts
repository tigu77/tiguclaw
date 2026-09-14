/**
 * 회귀: **보관 중인 자식은 전부 «발견» 된다 — 목록이 30개에서 끊기지 않는다** (2026-09-14)
 *
 * 잡는 사고(외부 재현 실측): 같은 부모 아래 자식 8개를 만들고 그 뒤 30개를 더 만든 다음
 * 복구용 목록을 조회했더니 **처음 8개가 0/8 발견**됐다. `all.slice(0, 30)` 이라 목록에
 * 페이지가 없었다. 원문은 멀쩡히 남아 있는데 **UUID 를 잃으면 되찾을 길이 없다** —
 * 컨텍스트 압축이 바로 그 UUID 를 치우는 기제다.
 *
 * ★고칠 때 «30 을 300 으로» 는 답이 아니다. 그건 같은 벽을 뒤로 미는 것이고, 응답 크기
 *  제한과 정면으로 부딪힌다. **발견 가능 범위 = 조회 가능 범위**가 되어야 한다.
 *
 * ★그리고 **offset 이 아니라 커서**다. 최신순 목록에 새 자식이 끼면 offset 은 한 칸씩 밀려
 *  이미 본 것을 다시 주거나 못 본 것을 건너뛴다. 키는 `(startedAt, jobId)` — 한 루프에서
 *  띄운 자식들은 `Date.now()` 가 **같은 값**이라 시각만으로는 동점이 서로를 가린다.
 *
 * 등급: **동작 검사** — 제품 핸들러(`read_worker_result`)를 실제로 부르고, 목록 응답에서
 * 얻은 UUID 로만 원문을 읽는다. 모델 호출 0.
 */
import { createSpawnAgentMcpServer } from "../../core/llm-runtime/capabilities/agent-registry.js";
import { compactOldToolOutputs } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { packJoinResponse } from "../../core/llm-runtime/capabilities/join-response.js";
import {
  __resetJobsForTest,
  getJobResultChannel,
  listJobs,
  markDone,
  registerJob,
  setJobResultChannel,
} from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

interface ToolReg {
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const CURSOR = /read_worker_result\(cursor="([^"]+)"\)/;

export const check: RegressionCheck = {
  name: "worker-result-list-pages",
  guards:
    "복구용 자식 목록이 최근 30개에서 끊겨, 그보다 오래된 자식은 원문이 남아 있는데도 UUID 를 잃으면 되찾을 길이 없던 것 — 외부 재현 실측(2026-09-14): 처음 만든 8개가 0/8 발견",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    __resetJobsForTest();

    const mkParent = (n: string): string => {
      const id = registerJob({
        kind: "worker", label: `매니저 ${n}`, task: "거둔다",
        threadKey: `dashboard:${n}`, channel: "dashboard", channelUserId: "u",
      } as never);
      setJobResultChannel(id, createSteeringChannel());
      return id;
    };
    const parent = mkParent("A");
    const other = mkParent("B");
    const spawn = (p: string, label: string, body: string): string => {
      const id = registerJob({
        kind: "agent", label, task: "리뷰",
        threadKey: `worker:${p}`, channel: "dashboard", channelUserId: "u",
      } as never);
      markDone(id, body);
      return id;
    };
    const srv = createSpawnAgentMcpServer({
      text: "거둬라", threadKey: `worker:${parent}`, channel: "dashboard", workerDepth: 1,
    } as never) as unknown as { instance: { _registeredTools: Record<string, ToolReg> } };
    const read = srv.instance._registeredTools["read_worker_result"];
    const wait = srv.instance._registeredTools["wait_for_worker"];
    if (read === undefined || wait === undefined) throw new Error("핸들러를 못 찾음");

    /** 목록을 **끝까지 따라간다** — 제품 응답이 알려주는 cursor 만 쓴다. */
    const walk = async (): Promise<{ ids: string[]; pages: number; texts: string[] }> => {
      const ids: string[] = [];
      const texts: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const t = textOf(await read.handler(cursor === undefined ? {} : { cursor }, {}));
        texts.push(t);
        // ★머리줄의 안내(cursor 값)에도 UUID 가 섞이므로 **항목 줄에서만** 거둔다.
        for (const line of t.split("\n")) {
          if (!line.startsWith("· ")) continue;
          for (const m of line.match(UUID) ?? []) ids.push(m);
        }
        const next = CURSOR.exec(t);
        if (next === null) return { ids, pages: guard + 1, texts };
        cursor = next[1];
      }
      return { ids, pages: 99, texts };
    };

    // ── ① 38개: 처음 8개(오래된 것)를 **목록을 따라가서** 찾는다 ────────────────────
    const first8 = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      spawn(parent, `초기 ${i}`, `OLD_${i}_BEGIN|${"가".repeat(200)}|OLD_${i}_END`),
    );
    const later30 = Array.from({ length: 30 }, (_, i) => spawn(parent, `이후 ${i}`, `NEW_${i}`));
    spawn(other, "남의 자식", "OTHER");

    const first = textOf(await read.handler({}, {}));
    const walked = await walk();
    const unique = new Set(walked.ids);
    out.push(
      // ★**«처음 만든 8개» 로 잴 수 없다** — 한 루프에서 띄우면 `startedAt` 이 같은 밀리초라
      //  순서가 생성 순서와 일치하지 않는다(동점은 jobId 로 깬다). 그래서 «누가» 가 아니라
      //  **«첫 쪽 밖에 몇 개가 남나»** 로 잰다 — 이게 고치기 전 증상(0/8 발견)의 성질이다.
      assert(
        "★첫 쪽은 30건뿐이고 **8건이 첫 쪽 밖**에 남는다 — 다음 쪽이 없으면 그 8건은 영영 못 찾는다",
        [...first8, ...later30].filter((id) => !first.includes(id)).length === 8 &&
          (first.match(/^· /gm) ?? []).length === 30,
        `첫 쪽 ${(first.match(/^· /gm) ?? []).length}건 · 밖에 남은 것 ${[...first8, ...later30].filter((id) => !first.includes(id)).length}건`,
      ),
      assert(
        "★★페이지를 끝까지 따라가면 **38개를 중복·누락 없이** 발견한다",
        unique.size === 38 && walked.ids.length === 38,
        `쪽 ${walked.pages} · 수집 ${walked.ids.length} · 고유 ${unique.size} (기대 38)`,
      ),
      assert(
        "★★처음 8개가 **전부** 목록에서 나온다 — 원문이 남아 있는데 못 찾던 것이 이 사고다",
        first8.every((id) => unique.has(id)),
        `${first8.filter((id) => unique.has(id)).length}/8`,
      ),
      assert(
        "★다른 부모의 자식은 섞이지 않는다",
        !walked.texts.join("\n").includes("남의 자식"),
        `타 부모 유입=${walked.texts.join("\n").includes("남의 자식")}`,
      ),
      assert(
        "★«보관 중 전체» 건수를 함께 낸다 — «퇴거됐다» 와 «다음 쪽에 있다» 를 가를 수 있어야 한다",
        first.includes("보관 중 전체 38건"),
        first.split("\n")[0]?.slice(0, 60) ?? "",
      ),
    );

    // ── ② 목록에서 얻은 UUID **만으로** 원문을 읽는다 (테스트가 아는 id 를 쓰지 않는다) ──
    {
      const fromList = walked.ids.filter((id) => first8.includes(id));
      let okCount = 0;
      for (const id of fromList) {
        const t = textOf(await read.handler({ job_id: id }, {}));
        const i = first8.indexOf(id);
        if (t.includes(`OLD_${i}_BEGIN`) && t.includes(`OLD_${i}_END`)) okCount += 1;
      }
      out.push(
        assert(
          "★★목록에서 얻은 UUID 로 **원문까지** 읽힌다 — 발견과 조회의 범위가 같다",
          okCount === 8,
          `${okCount}/8`,
        ),
      );
    }

    // ── ③ 경계: 0·1·30·31·60·61 에서 종료 여부와 다음 쪽이 정확하다 ──────────────────
    {
      const sizes = [0, 1, 30, 31, 60, 61];
      const wrong: string[] = [];
      for (const n of sizes) {
        __resetJobsForTest();
        const p = mkParent(`size${n}`);
        const srvN = createSpawnAgentMcpServer({
          text: "x", threadKey: `worker:${p}`, channel: "dashboard", workerDepth: 1,
        } as never) as unknown as { instance: { _registeredTools: Record<string, ToolReg> } };
        const readN = srvN.instance._registeredTools["read_worker_result"] as ToolReg;
        for (let i = 0; i < n; i++) spawn(p, `자식 ${i}`, `B_${i}`);
        const ids: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        for (let guard = 0; guard < 50; guard++) {
          const t = textOf(await readN.handler(cursor === undefined ? {} : { cursor }, {}));
          pages += 1;
          for (const line of t.split("\n")) {
            if (line.startsWith("· ")) for (const m of line.match(UUID) ?? []) ids.push(m);
          }
          const next = CURSOR.exec(t);
          if (next === null) break;
          cursor = next[1];
        }
        const expectPages = n === 0 ? 1 : Math.ceil(n / 30);
        if (new Set(ids).size !== n || ids.length !== n || pages !== expectPages) {
          wrong.push(`${n}건→${ids.length}개/${pages}쪽(기대 ${n}/${expectPages})`);
        }
      }
      out.push(
        assert(
          "★★경계(0·1·30·31·60·61)에서 쪽 수와 항목 수가 정확하다",
          wrong.length === 0,
          wrong.length === 0 ? "전부 일치" : wrong.join(" · "),
        ),
      );
    }

    // ── ④ 훑는 중 새 자식이 생겨도 **기존 대상이 누락되지 않는다** ────────────────────
    {
      __resetJobsForTest();
      const p = mkParent("live");
      const srvL = createSpawnAgentMcpServer({
        text: "x", threadKey: `worker:${p}`, channel: "dashboard", workerDepth: 1,
      } as never) as unknown as { instance: { _registeredTools: Record<string, ToolReg> } };
      const readL = srvL.instance._registeredTools["read_worker_result"] as ToolReg;
      const base = Array.from({ length: 45 }, (_, i) => spawn(p, `기존 ${i}`, `L_${i}`));
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const t = textOf(await readL.handler(cursor === undefined ? {} : { cursor }, {}));
        for (const line of t.split("\n")) {
          if (line.startsWith("· ")) for (const m of line.match(UUID) ?? []) seen.push(m);
        }
        // ★첫 쪽을 읽은 **직후** 새 자식이 들어온다 — offset 방식이면 여기서 한 칸 밀린다.
        if (guard === 0) for (let k = 0; k < 5; k++) spawn(p, `난입 ${k}`, `X_${k}`);
        const next = CURSOR.exec(t);
        if (next === null) break;
        cursor = next[1];
      }
      const missed = base.filter((id) => !seen.includes(id));
      out.push(
        assert(
          "★★훑는 도중 새 자식이 끼어도 **기존 45개가 하나도 안 빠진다**(offset 이었으면 밀린다)",
          missed.length === 0 && new Set(seen).size === seen.length,
          `누락 ${missed.length}건 · 중복 ${seen.length - new Set(seen).size}건`,
        ),
      );
    }

    // ── ④-b ★**시각이 같고 jobId 가 작은 새 자식이 끼어도** 기존 항목은 안 흔들린다.
    //  (2026-09-14 외부 검토가 짚은 경계 — 이때는 새 자식이 뒤쪽 쪽에 «나올 수» 있다.
    //   그건 손상이 아니다. 지켜야 하는 것은 **기존 항목의 누락·중복 0** 이다.)
    {
      __resetJobsForTest();
      const p = mkParent("tie");
      const srvT = createSpawnAgentMcpServer({
        text: "x", threadKey: `worker:${p}`, channel: "dashboard", workerDepth: 1,
      } as never) as unknown as { instance: { _registeredTools: Record<string, ToolReg> } };
      const readT = srvT.instance._registeredTools["read_worker_result"] as ToolReg;
      const base = Array.from({ length: 45 }, (_, i) => spawn(p, `기존 ${i}`, `T_${i}`));
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const t = textOf(await readT.handler(cursor === undefined ? {} : { cursor }, {}));
        for (const line of t.split("\n")) {
          if (line.startsWith("· ")) for (const m of line.match(UUID) ?? []) seen.push(m);
        }
        // ★같은 밀리초에 태어난 자식을 첫 쪽 직후에 넣는다 — 커서와 시각이 같아 jobId 비교로만
        //  갈리는 자리다(한 루프에서 띄우면 실제로 늘 이 모양이다).
        if (guard === 0) for (let k = 0; k < 5; k++) spawn(p, `동점 ${k}`, `TIE_${k}`);
        const next = CURSOR.exec(t);
        if (next === null) break;
        cursor = next[1];
      }
      const missed = base.filter((id) => !seen.includes(id));
      out.push(
        assert(
          "★★시각이 같은 새 자식이 끼어도 **기존 45개의 누락·중복이 0** 이다",
          missed.length === 0 && new Set(seen).size === seen.length,
          `누락 ${missed.length}건 · 중복 ${seen.length - new Set(seen).size}건 · 수집 ${seen.length}`,
        ),
      );
    }

    // ── ⑤ C1 압축 뒤 종단: 안내 → 목록 끝까지 → 오래된 원문 읽기 ─────────────────────
    {
      __resetJobsForTest();
      const p = mkParent("e2e");
      const srvE = createSpawnAgentMcpServer({
        text: "x", threadKey: `worker:${p}`, channel: "dashboard", workerDepth: 1,
      } as never) as unknown as { instance: { _registeredTools: Record<string, ToolReg> } };
      const readE = srvE.instance._registeredTools["read_worker_result"] as ToolReg;
      const oldest = spawn(p, "가장 오래된", `E2E_BEGIN|${"다".repeat(300)}|E2E_END`);
      for (let i = 0; i < 40; i++) spawn(p, `뒤 ${i}`, `E_${i}`);
      // 합류 응답 → 압축 → 안내만 남는다.
      const packed = packJoinResponse([
        { jobId: oldest, label: "가장 오래된", status: "✅ 완료", body: "x".repeat(3000) },
      ]);
      const arr: Array<{ type: string; call_id: string; output: string }> = [
        { type: "function_call_output", call_id: "j", output: packed },
      ];
      for (let i = 0; i < 4; i++) {
        arr.push({ type: "function_call_output", call_id: `t${i}`, output: `읽음 ${i}` });
      }
      compactOldToolOutputs(arr as never);
      const notice = arr[0]?.output ?? "";
      // 안내가 알려주는 것만 들고 목록을 끝까지 따라간다.
      const found: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const t = textOf(await readE.handler(cursor === undefined ? {} : { cursor }, {}));
        for (const line of t.split("\n")) {
          if (line.startsWith("· ")) for (const m of line.match(UUID) ?? []) found.push(m);
        }
        const next = CURSOR.exec(t);
        if (next === null) break;
        cursor = next[1];
      }
      const body = found.includes(oldest)
        ? textOf(await readE.handler({ job_id: oldest }, {}))
        : "";
      out.push(
        assert(
          "★안내가 **다음 쪽이 있다는 사실**까지 말한다 — 첫 쪽에 없으면 거기서 멈춰버린다",
          notice.includes("read_worker_result") && notice.includes("cursor"),
          `남은 안내 ${notice.length}자 · cursor 언급=${notice.includes("cursor")}`,
        ),
        assert(
          "★★압축 안내 → 목록 탐색 → **가장 오래된 원문**까지 이어진다(종단)",
          body.includes("E2E_BEGIN") && body.includes("E2E_END"),
          `목록에서 발견=${found.includes(oldest)} · 원문=${body.includes("E2E_BEGIN")}`,
        ),
      );
    }

    // ── ⑥ 반복 목록 조회는 아무것도 바꾸지 않는다 ───────────────────────────────────
    {
      const before = listJobs().length;
      const a = textOf(await read.handler({}, {}));
      const b = textOf(await read.handler({}, {}));
      out.push(
        assert(
          "★반복 목록 조회가 새 작업을 만들지 않고 결과함도 안 먹는다(읽기 전용)",
          a === b && listJobs().length === before &&
            getJobResultChannel(parent)?.drain().length === 0,
          `동일=${a === b} · 잡 ${before}→${listJobs().length}`,
        ),
      );
    }
    return out;
  },
};
