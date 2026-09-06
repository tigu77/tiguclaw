/**
 * 회귀: **정리 도구는 묶음을 받는다** — `archive_memory`·`delete_memory` 가 이름 배열을
 * 한 번에 처리한다 (2026-09-04).
 *
 * 왜: `memory-tidy` 는 한 판에 «상위 25건» 을 다루는데(스킬 §3) 도구가 이름을 하나만
 * 받으면 그 한 판이 호출 수십 번이 된다 — 왕복도 승인도 건별이고, 중간에 턴이 끊기면
 * «절반만 정리된» 상태가 남는다. 배열을 받는 것까지는 스키마가 강제하지만, **핸들러가
 * 첫 건만 처리하고 ok:true 를 돌려주는** 모양은 스키마가 못 막는다(그게 이 검사의 변이다).
 *
 * ★도구를 **실제 MCP 경로로 부른다** — 내부 함수 직접 호출이 아니라 모델이 지나는 그 길
 *  (브리지 → 서버 → 핸들러). 스키마가 배열을 거부하면 여기서 바로 걸린다.
 * ★아카이브는 **삭제가 아니라는 성질**도 같이 지킨다(인덱스에서만 내려가고 검색은 도달).
 *  묶음 처리로 바꾸면서 이 성질이 새면 정리 스킬의 하드룰이 무너진다.
 */
import { initStore, getDb } from "../../store/sessions.js";
import { addMemory, listMemoriesForIndex, searchMemories } from "../../store/memory.js";
import { createMemoryMcpServer } from "../../core/memory-mcp.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const NAMES = ["batch-alpha", "batch-beta", "batch-gamma"];

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  initStore();
  const db = getDb();
  db.prepare(`DELETE FROM memories`).run();
  for (const name of NAMES) {
    addMemory({
      type: "user",
      name,
      description: `묶음 정리 대상 ${name}`,
      body: `본문 ${name} — 아카이브해도 검색으로 찾혀야 한다.`,
    });
  }

  const server = await adaptClaudeMcpServer(createMemoryMcpServer(), "memory");
  const call = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const content = (await server.callTool(tool, args)) as Array<{
      type?: string;
      text?: string;
    }>;
    return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
  };
  const indexNames = (): string[] =>
    listMemoriesForIndex(64 * 1024).lines.flatMap((l) => {
      const m = /\] ([a-z0-9-]+):/.exec(l);
      return m === null ? [] : [m[1] as string];
    });

  // ── ① 한 번의 호출이 셋 다 내린다 (변이: 첫 건만 처리) ────────────────────
  {
    const res = await call("archive_memory", { names: NAMES });
    const left = indexNames();
    const stillThere = NAMES.filter((n) => left.includes(n));
    out.push(
      assert(
        "★한 번의 archive_memory 호출이 준 이름 전부를 인덱스에서 내린다",
        stillThere.length === 0 && res["changed"] === NAMES.length,
        stillThere.length === 0
          ? `changed=${String(res["changed"])}`
          : `★남아 있다: ${stillThere.join(",")} (changed=${String(res["changed"])})`,
      ),
    );
    const results = res["results"] as Array<{ name: string; found: boolean }> | undefined;
    out.push(
      assert(
        "건별 결과를 돌려준다(무엇이 바뀌었는지 모델이 알 수 있게)",
        Array.isArray(results) &&
          results.length === NAMES.length &&
          results.every((r) => r.found),
        JSON.stringify(results),
      ),
    );
  }

  // ── ② 아카이브는 삭제가 아니다 — 묶음으로 해도 검색은 도달한다 ──────────────
  {
    // ★`includeArchived: true` 로 묻는다 (2026-09-06). 기본이 «제외» 로 바뀌었다 —
    //  매 턴 자동 검색에 아카이브가 나올 이유가 없어서다. 여기서 확인하려는 성질은
    //  «아카이브는 삭제가 아니다 = **찾으면 나온다**» 이므로 명시적으로 찾는 게 맞다.
    const hits = searchMemories("batch-beta", 8, { includeArchived: true }).map((m) => m.name);
    out.push(
      assert(
        "★묶음 아카이브 뒤에도 검색으로 도달한다(삭제가 아니다)",
        hits.includes("batch-beta"),
        hits.join(",") || "(없음)",
      ),
    );
  }

  // ── ③ restore 도 묶음이다 ────────────────────────────────────────────────
  {
    await call("archive_memory", { names: NAMES, restore: true });
    const back = indexNames();
    const missing = NAMES.filter((n) => !back.includes(n));
    out.push(
      assert(
        "restore:true 도 준 이름 전부를 되돌린다",
        missing.length === 0,
        missing.length === 0 ? `${NAMES.length}건 복귀` : `★못 돌아온 것: ${missing.join(",")}`,
      ),
    );
  }

  // ── ④ 없는 이름이 섞여도 멱등이고, 셈은 정직하다 ──────────────────────────
  {
    const res = await call("archive_memory", { names: ["batch-alpha", "존재하지-않음"] });
    const results = res["results"] as Array<{ name: string; found: boolean }> | undefined;
    const found = results?.find((r) => r.name === "존재하지-않음")?.found;
    out.push(
      assert(
        "없는 이름은 실패가 아니라 found:false 로 보고한다(부분 실패가 호출 전체를 죽이지 않게)",
        res["ok"] === true && found === false && res["changed"] === 1,
        `ok=${String(res["ok"])} changed=${String(res["changed"])} found=${String(found)}`,
      ),
    );
  }

  // ── ⑤ delete_memory 도 묶음이다 — 그리고 중복은 한 번만 센다 ──────────────
  {
    const res = await call("delete_memory", {
      names: ["batch-beta", "batch-gamma", "batch-beta"],
    });
    const rows = db
      .prepare(`SELECT name FROM memories WHERE name IN ('batch-beta','batch-gamma')`)
      .all() as Array<{ name: string }>;
    out.push(
      assert(
        "★한 번의 delete_memory 호출이 준 이름 전부를 지운다",
        rows.length === 0,
        rows.length === 0 ? "0건 잔존" : `★남아 있다: ${rows.map((r) => r.name).join(",")}`,
      ),
    );
    out.push(
      assert(
        "같은 이름을 두 번 줘도 한 건으로 센다(«몇 건 지웠나» 가 부풀지 않게)",
        res["deleted"] === 2,
        `deleted=${String(res["deleted"])}`,
      ),
    );
  }

  await server.close();
  db.prepare(`DELETE FROM memories`).run();
  return out;
};

export const check: RegressionCheck = {
  name: "memory-batch-tools",
  guards:
    "정리 도구(archive_memory·delete_memory)가 이름 묶음을 한 번에 처리하는 것 — 첫 건만 " +
    "처리하고 성공을 보고하면 정리가 조용히 절반만 된다",
  run,
};
