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
import {
  CONTEXT_WINDOWS,
  contextPressureLabel,
  lookupContextWindow,
} from "../../core/llm-runtime/context-windows.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/**
 * ★**관측 증거 앵커** (2026-08-21). 종전 검사는 "해석되는가" 만 봤고, 표가 200K 로 **틀린**
 *  동안에도 멀쩡히 초록이었다 — 틀린 값도 해석은 되니까.
 *
 *  여기 적는 건 추정이 아니라 **성공한 호출의 실측**이다: 이 크기의 입력이 `ok=true` 로
 *  끝났으므로 그 모델의 윈도우는 **최소한** 이만큼이다. 추측을 박아두는 게 아니라
 *  반증 불가능한 하한을 박아둔다 — 그래서 이 목록은 올라가기만 하고 내려가지 않는다.
 *  (출처: 회사돌쇠 `llm.turn_done`, 2026-08-21. 200K 창이면 물리적으로 불가능한 값들.)
 */
const OBSERVED_MIN: ReadonlyArray<{ model: string; input: number; when: string }> = [
  { model: "claude-opus-5", input: 241_088, when: "2026-08-21 회사돌쇠" },
];

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
      // ★① 실측이 표를 반증하지 않는가 — 성공한 호출보다 윈도우가 작으면 표가 틀렸다.
      ...OBSERVED_MIN.map(({ model, input, when }) => {
        const win = lookupContextWindow(model);
        return assert(
          `★${model} 윈도우가 실측 성공 입력(${input.toLocaleString()})보다 크다 — 작으면 표가 틀린 것`,
          win !== undefined && win >= input,
          win === undefined
            ? `★미해석(${when})`
            : `${win.toLocaleString()} ≥ ${input.toLocaleString()} (${when})`,
        );
      }),
      // ★② 구체 키가 세대 폴백을 이긴다 — 지면 새 값이 영영 안 쓰인다(죽은 설정).
      ...(() => {
        const keys = Object.keys(CONTEXT_WINDOWS);
        const shadowed = keys.filter((k) =>
          keys.some((other) => other !== k && k.startsWith(other)) &&
          lookupContextWindow(`${k}-20260101`) !== CONTEXT_WINDOWS[k],
        );
        return [
          assert(
            "★더 구체적인 키가 세대 폴백보다 우선한다(가장 긴 접두 매칭)",
            shadowed.length === 0,
            shadowed.length === 0
              ? "폴백에 가려진 키 0개"
              : `★가려짐: ${shadowed.join(", ")}`,
          ),
        ];
      })(),
      // ★③ 100% 를 넘겼는데 "거의 참"이라고 말하지 않는가 — 그건 /clear 를 유도해
      //  멀쩡한 맥락을 지우게 만든다. 초과는 컨텍스트가 아니라 **우리 표**의 문제다.
      assert(
        "★100% 초과를 '거의 참'으로 말하지 않는다(사용자에게 /clear 를 시키지 않는다)",
        !contextPressureLabel(106).includes("거의 참") &&
          !contextPressureLabel(106).includes("`/clear` 고려") &&
          contextPressureLabel(90).includes("거의 참") &&
          contextPressureLabel(75).includes("여유") &&
          contextPressureLabel(20) === "",
        `106%→"${contextPressureLabel(106).trim()}"`,
      ),
    ];
  },
};
