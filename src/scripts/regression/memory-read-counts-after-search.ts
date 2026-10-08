/**
 * 회귀: **자동 검색에 걸린 메모리도 그날 직접 읽으면 한 번 센다** (2026-10-08 외부 검토 F8).
 *
 * 사고(검토 재현): 자동 검색(`searchMemories`)이 `last_accessed` 를 오늘로 찍고, 직접 읽기(`getMemory`)의 하루 1회 집계가 같은 칸으로
 * «오늘 이미 셌나» 를 판정해 — 검색에 걸린 메모리는 그날 직접 읽어도 0이었다(직접 읽기 1 / 검색 뒤 읽기 0). 이 카운터가 인덱스
 * 상주 순서(hot-first)를 정하므로, 자주 검색에 걸리면서 실제로 쓰이는 메모리가 거꾸로 밀렸다.
 *
 * 등급: **동작** — 격리 홈의 실제 DB 에 실제 검색·읽기를 돌린다.
 */
import { getDb, initStore } from "../../store/sessions.js";
import { addMemory, getMemory, searchMemories } from "../../store/memory.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "memory-read-counts-after-search",
  guards: "자동 검색에 걸린 메모리를 그날 직접 읽어도 읽은 횟수가 안 오르던 것(검색과 직접 읽기가 같은 날짜 칸을 썼다)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const db = getDb();
    const tag = `regrcount${Date.now()}`;
    addMemory({ type: "user", name: `${tag}-direct`, description: `${tag} 직접만 읽는 것`, body: "본문" });
    addMemory({ type: "user", name: `${tag}-searched`, description: `${tag} 검색에 걸리는 것 zebraquokka`, body: "본문" });
    const hits = searchMemories("zebraquokka");
    getMemory(`${tag}-direct`);
    getMemory(`${tag}-searched`);
    getMemory(`${tag}-searched`); // 같은 날 두 번째 — 하루 1회로 접힌다
    const count = (name: string): number =>
      (db.prepare(`SELECT access_count AS c FROM memories WHERE name = ?`).get(name) as { c: number }).c;
    const direct = count(`${tag}-direct`);
    const searched = count(`${tag}-searched`);
    db.prepare(`DELETE FROM memories WHERE name LIKE ?`).run(`${tag}-%`);
    return [
      assert("전제 — 검색이 그 메모리를 실제로 찾았다", hits.some((m) => m.name === `${tag}-searched`), hits.map((m) => m.name)),
      assert("★검색에 걸린 메모리도 그날 직접 읽으면 한 번 센다(직접만 읽은 것과 같다) · 같은 날 두 번은 한 번", direct === 1 && searched === 1, { direct, searched }),
    ];
  },
};
