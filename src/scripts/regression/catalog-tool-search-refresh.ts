/**
 * 회귀: **도구 검색 지원이 철회되면 캐시의 true 도 사라진다** (2026-10-19, 아스트라 추가 검토 2번).
 *
 * 사고(재현): 카탈로그 갱신이 새로 온 키만 **병합**해서, 성공한 `/models` 응답에서 `supports_search_tool` 이 사라져도 예전 true 가 남았다 —
 *  «부재 = 모름 = 펼침» 계약과 달리 지원이 철회된 모델에 접힌 요청을 계속 보낸다(공급자가 거절하면 400 안전망이 매 턴 요청을 하나 더 만든다).
 * 본다(실제 `refreshModelCatalog` · 가짜 네트워크): true→필드 없음 = 모름 · true→false = false · 다른 공급자 키 보존 · **디스크에도 반영**
 *  (재시작 뒤 옛 true 가 돌아오지 않게) · 조회 실패면 직전 값 보존.
 * 등급: **실행**(자식 프로세스).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_catalog-refresh-child.ts");
type J = { m1?: boolean | null; m2?: boolean | null; other?: boolean | null; disk?: Record<string, boolean>; error?: string };
const run = async (mode: string): Promise<J> => {
  const r = await spawnWithin(60_000, `catalog-refresh(${mode})`, ["--import", "tsx", CHILD, mode], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  return line === undefined ? { error: r.err.slice(-200) } : (JSON.parse(line) as J);
};

export const check: RegressionCheck = {
  name: "catalog-tool-search-refresh",
  guards: "도구 검색 지원 필드가 사라져도 캐시의 true 가 남아 지원이 철회된 모델에 접힌 요청을 계속 보내던 것 — 갱신이 병합만 했다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const ok = await run("ok");
    const fail = await run("fail");
    return [
      assert("★조회 성공 — 필드가 사라진 모델은 «모름»(undefined) · 명시적 false 는 false",
        ok.m1 === null && ok.m2 === false, JSON.stringify(ok)),
      assert("★디스크에도 반영 — 재시작 뒤 옛 true 가 돌아오지 않는다 · 다른 공급자 키는 그대로",
        ok.disk !== undefined && !("codex:m1" in ok.disk) && ok.disk["codex:m2"] === false && ok.disk["other:x"] === true && ok.other === true, JSON.stringify(ok.disk)),
      assert("조회 실패면 직전 값을 보존한다(한 번 흔들렸다고 아는 것을 잃지 않는다)",
        fail.m1 === true && fail.m2 === true && fail.other === true, JSON.stringify(fail)),
    ];
  },
};
