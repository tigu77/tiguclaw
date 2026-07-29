/**
 * 회귀: **settings.json 풀의 모든 모델이 컨텍스트 윈도우로 해석된다** (2026-07-30).
 *
 * 사고: `CONTEXT_WINDOWS` 가 손으로 관리하는 목록이라 실물과 갈라졌다. 실측 — 실사용 상위가
 * `claude-opus-5`(84턴)·`claude-sonnet-5`(36턴)인데 표엔 `claude-opus-4-7` 등만 있었고(각 0턴)
 * 접두 매칭도 실패 → `lookupContextWindow`=undefined → `/status` 가 "(윈도우 미상)" 만 찍고
 * **70%/85% "거의 참" 경고가 claude 백엔드에선 한 번도 안 떴다**(그 120턴 내내).
 *
 * ★그리고 그 표 주석에 "회귀 `context-window-coverage` 가 지킨다" 라고 적어놨는데 **그 검사가
 *  존재하지 않았다**(원칙 검토가 잡음). 없는 주석보다 나쁘다 — 다음 사람이 믿는다. 이 파일이
 *  그 문장을 사실로 만든다.
 */
import { lookupContextWindow } from "../../core/llm-runtime/context-windows.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 실사용 모델(llm.turn_done 실측 2026-07-30) + 프로파일 풀에 등장하는 형태. */
const IN_USE = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
];

/** settings.json 의 프로파일 풀에서 모델명만 추출(`provider:model` → model). */
const poolModels = async (): Promise<string[]> => {
  const { readFile } = await import("node:fs/promises");
  const home = process.env.TIGUCLAW_HOME ?? "";
  for (const p of [`${home}/settings.json`, "tiguclaw-dev/settings.json"]) {
    try {
      const raw = JSON.parse(await readFile(p, "utf8")) as {
        models?: { profiles?: Record<string, { pool?: string[] }> };
      };
      const out = new Set<string>();
      for (const prof of Object.values(raw.models?.profiles ?? {})) {
        for (const spec of prof.pool ?? []) {
          const m = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
          if (m !== "") out.add(m);
        }
      }
      if (out.size > 0) return [...out];
    } catch {
      /* 다음 후보 */
    }
  }
  return []; // 설정 없음(격리 홈) — 아래 IN_USE 단언이 본체를 지킨다.
};

export const check: RegressionCheck = {
  name: "context-window-coverage",
  guards: "모델 표가 실물과 갈라져 컨텍스트 경고가 아예 안 뜨던 것",
  run: async (): Promise<Assertion[]> => {
    const missing = IN_USE.filter((m) => lookupContextWindow(m) === undefined);
    const pool = await poolModels();
    const poolMissing = pool.filter((m) => lookupContextWindow(m) === undefined);
    return [
      assert(
        "★실사용 모델 전부가 윈도우로 해석된다",
        missing.length === 0,
        missing.length === 0 ? `${IN_USE.length}개 전부 OK` : `미해석=[${missing.join(",")}]`,
      ),
      assert(
        "★settings.json 프로파일 풀의 모델도 전부 해석된다(설정 드리프트 감지)",
        poolMissing.length === 0,
        pool.length === 0 ? "(설정 없음 — 스킵)" : `풀 ${pool.length}개 중 미해석=[${poolMissing.join(",")}]`,
      ),
      assert(
        "미상 모델은 undefined 를 준다(오탐 대신 정직)",
        lookupContextWindow("brand-new-model-xyz") === undefined,
        "정직한 미상",
      ),
      assert(
        "빈 값 방어",
        lookupContextWindow("") === undefined && lookupContextWindow(null) === undefined,
        "null·빈문자",
      ),
    ];
  },
};
