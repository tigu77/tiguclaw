/**
 * 회귀: **«빠름» 이 어댑터를 가리지 않는다** (2026-09-11).
 *
 * 사고 전 상태: v0.52.0 이 «빠름» 을 내보내면서 **계약·파서·화면·codex 번역**까지 전부
 * 내보내고 **claude 어댑터 번역 한 줄만** 빠뜨렸다. 그래서 같은 `settings.json` 의 같은
 * 설정이 어댑터마다 다르게 굴렀고([[feedback_every_feature_llm_agnostic]] 위반), 화면은
 * 그걸 «이 provider 는 안 읽음» 이라고 **provider 탓**으로 적었다.
 *
 * ★실측으로 **끝까지 확인했다**(격리 프로브, 2026-09-11, 구독 OAuth 경로):
 *
 *     미지정                          → off · 사유 sdk_opt_in_required
 *     settings.fastMode (추가사용량 off) → off · 사유 extra_usage_disabled
 *     settings.fastMode (추가사용량 on)  → **on · 사유 없음**
 *
 *  «사유 없음» 은 SDK 정의상 «아무것도 안 막는다» 다. 장벽은 계정의 추가 사용량 하나뿐이었고
 *  그 뒤엔 없었다 — `not_first_party`·`free`·`model_not_allowed` 중 어느 것도 아니었다.
 * ★그런데도 이 검사는 «켜진다» 를 **일부러 단언하지 않는다.** 그건 계정 설정에 달린 값이라,
 *  단언하면 추가 사용량을 안 켠 사람의 기계에서 빨개지는 **환경 의존 그물**이 된다(같은 날
 *  `skill-drop-is-not-silent` 가 정확히 그 병을 앓았다). 여기서 재는 것은
 *  **«우리가 켜달라고 보낸다»** 이고, 켜졌는지는 로그가 사유로 말한다.
 *
 * ★판정을 함수로 떼어 **동작으로** 잰다. 어댑터 안 한 줄로 두면 «그 줄이 있나» 를 grep
 *  으로밖에 못 재는데, 오늘만 그 부류로 두 번 데었다(죽은 브리지 그물이 지워도 초록 ·
 *  드로어 그물이 변이 4종을 통과).
 *
 * ★**세 번째 어댑터까지 왔다** (2026-09-12 N6). `openai` 어댑터는 «못 하는 게 아니라 안 한»
 *  상태로 남아 있었다 — 계약 주석이 그걸 «parity 잔여» 라고 적어 두고 있었다. 그런데 이
 *  어댑터는 **다대일**이라(openai·ollama·google·사용자 정의) 축이 하나 더 는다: «어댑터가
 *  읽는가» 만으로는 부족하고 «이 연결이 그 손잡이를 갖는가» 까지 가른다. 그래서 규칙을
 *  `_openai-speed.ts` 한 곳에 두고 **운반(어댑터)과 표시(화면)가 같은 함수**를 부르게 했다 —
 *  둘이 각자 판정하면 갈리고, 갈린 방향이 «안 읽는다면서 돈은 나간다» 면 최악이다(P1).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import ts from "typescript";
import { readSourceSync, stripComments, callArgTexts } from "./_wiring.js";

/**
 * `runClaude` 의 `options: Options = { … }` 리터럴이 **직접** `...claudeSpeedSettings(input.speed)`
 * 를 펼치는가 — **AST 로** 본다.
 *
 * ★정규식을 안 쓰는 이유(2026-09-11 적대 검토 G1). 소스에 그 문자열이 있는지만 보면
 *  레드팀이 실제로 뚫은 두 변이를 통과시킨다: ①호출을 감싸 결과를 버리기
 *  (`...({u:claudeSpeedSettings(input.speed)}.u === null ? {} : {})`) ②호출을 `env` 같은
 *  엉뚱한 옵션으로 옮기기. 둘 다 «claude 턴이 영원히 표준 속도» 인데 문자열은 그대로다.
 * ★«이 판정의 정확한 값이 이미 있나?» — 있다. **파서**다. 근사치를 쓰는 것 자체가 결함이다.
 */
const spreadsSpeedIntoOptions = (): boolean => {
  const src = ts.createSourceFile(
    "claude-agent-sdk.ts",
    readSourceSync("src/core/llm-runtime/adapters/claude-agent-sdk.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "options" &&
      n.initializer !== undefined &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      // ★뒤에 `settings:` 를 직접 놓으면 스프레드가 **덮인다**(2026-09-11 G2). SDK 의
      //  `ultracode`·`effortLevel` 같은 다른 flag setting 을 쓰는 날 «빠름» 이 조용히
      //  죽는다. 그 리터럴에 `settings` **직접 지정이 0개**여야 한다.
      const directSettings = n.initializer.properties.filter(
        (pr) => ts.isPropertyAssignment(pr) && pr.name.getText() === "settings",
      ).length;
      if (directSettings > 0) return; // found 를 안 세운다 = 빨강
      for (const prop of n.initializer.properties) {
        if (!ts.isSpreadAssignment(prop)) continue;
        const e = prop.expression;
        // 스프레드의 **최상위**가 그 호출이어야 한다 — 감싸면 여기서 걸린다.
        const arg = ts.isCallExpression(e) ? e.arguments[0] : undefined;
        if (
          ts.isCallExpression(e) &&
          ts.isIdentifier(e.expression) &&
          e.expression.text === "claudeSpeedSettings" &&
          e.arguments.length === 1 &&
          arg !== undefined &&
          // ★인자는 «`input` 의 `speed` 를 읽는가» 로 본다 — `input.speed` 문자열 동일성에
          //  묶으면 `input?.speed` 같은 **동작이 같은 리팩터**에 빨개진다(2026-09-11 N4).
          //  좁힘 방향 오탐은 옳은 수정을 막고, 그러면 다음 사람이 리팩터를 피한다.
          /^input\??\.speed$/.test(arg.getText())
        ) {
          found = true;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
};


/**
 * fast-mode 사유 로그가 **도달 가능한가** — AST 로 본다.
 *
 * ★소스에 `fast-mode` 문자열이 있는지로 재면 `if (false && …)` 한 글자에 뚫린다
 *  (2026-09-11 적대 검토 G3 이 실제로 그렇게 뚫었다). 게이트 조건이 **정확히**
 *  `input.speed === "fast"` 인지를 본다 — 죽은 조건이 앞에 붙으면 `BinaryExpression`
 *  모양이 달라져 걸린다.
 * ★then-분기를 `parseFastMode` 로 찾는다 — N2·N3 수정으로 판정·접기가 `fast-mode-view.ts`
 *  순수 모듈로 나갔다(그래야 접는 규칙을 돌려서 잰다). 접는 규칙 자체는 형제 검사
 *  `fast-mode-log-answers-the-question` 이 실행으로 잰다.
 */
/**
 * ★**여기서는 «있는가» 만 본다** (2026-09-11 P6). 종전엔 이 함수가 배선의 모양까지 제 손으로
 *  확인했다 — `if (input.speed === "fast")` 안에 `parseFastMode` 가 있나. 그 술어가 형제
 *  `fast-mode-log-answers-the-question` 과 **두 벌**이었고, 그쪽이 배선을 한 줄로 내리자
 *  여기만 낡아 빨간불이 났다. 같은 것을 두 곳에서 재면 반드시 한쪽이 먼저 낡는다.
 *  ★덤: 종전 순회는 매 매치마다 `ok` 를 **덮어써서** 마지막 매치가 이겼다 — 형제 파일이
 *   같은 버그로 뚫렸던 바로 그 모양이다(적대 검토가 여기 남은 것을 짚었다). 존재 판정으로
 *   바꾸면서 그 문제도 같이 사라진다.
 */
const speedLogIsReachable = (): boolean => {
  const src = ts.createSourceFile(
    "claude-agent-sdk.ts",
    readSourceSync("src/core/llm-runtime/adapters/claude-agent-sdk.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "reportFastMode"
    ) {
      found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
};


/**
 * openai 어댑터가 «빠름» 을 **정말 모델 설정에 싣는가** — AST 로 본다 (2026-09-12 N6).
 *
 * ★claude 쪽(`spreadsSpeedIntoOptions`)과 같은 이유로 AST 다: 번역 함수(`openaiSpeedSettings`)
 *  자체는 순수해서 **돌려서** 재지만, «그 결과가 SDK 까지 가는가» 는 라이브 턴 없이는 못 돈다.
 *  그 자리가 이 레포가 반복해 뚫린 곳이라 모양이라도 **정확히** 본다.
 *
 * 셋을 본다 — 셋 다 «기능은 죽는데 문자열은 그대로» 인 변이를 막는다:
 *  ① `modelSettings` 객체가 **최상위 스프레드**로 그 번역을 편다(감싸서 결과를 버리면 걸린다).
 *  ② 형제 `reasoning` 이 **같은 객체 안에** 있다 — 한 고리를 고치다 옆을 빠뜨리는 것이 이
 *     레포의 반복 사고고(2026-08-15 에 이 어댑터만 강도를 안 읽었다), 그 축엔 그물이 0이었다.
 *  ③ `new Agent({…})` 리터럴이 그걸 **스프레드로만** 받는다. 직접 `modelSettings:` 를 뒤에
 *     놓으면 통째로 덮인다 — claude 옵션 리터럴의 `settings:` 와 같은 모양의 사고다.
 */
const openaiWiresSpeed = (): { spread: boolean; sibling: boolean; agent: boolean } => {
  const src = ts.createSourceFile(
    "openai-agents-sdk.ts",
    readSourceSync("src/core/llm-runtime/adapters/openai-agents-sdk.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  const out = { spread: false, sibling: false, agent: false };
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "modelSettings" &&
      n.initializer !== undefined &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      for (const prop of n.initializer.properties) {
        if (!ts.isSpreadAssignment(prop)) continue;
        const e = prop.expression;
        // ① 최상위가 그 호출이어야 한다.
        const arg = ts.isCallExpression(e) ? e.arguments[0] : undefined;
        if (
          ts.isCallExpression(e) &&
          ts.isIdentifier(e.expression) &&
          e.expression.text === "openaiSpeedSettings" &&
          arg !== undefined &&
          /^input\??\.speed$/.test(arg.getText())
        ) {
          out.spread = true;
        }
        // ② 형제 강도 — 조건부 스프레드 안에 `reasoning:` 이 있으면 된다(모양은 자유).
        if (/reasoning\s*:/.test(e.getText())) out.sibling = true;
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Agent") {
      const lit = n.arguments?.[0];
      if (lit !== undefined && ts.isObjectLiteralExpression(lit)) {
        const direct = lit.properties.filter(
          (pr) => ts.isPropertyAssignment(pr) && pr.name.getText() === "modelSettings",
        ).length;
        const spread = lit.properties.some(
          (pr) => ts.isSpreadAssignment(pr) && /\bmodelSettings\b/.test(pr.expression.getText()),
        );
        // ③ 직접 지정이 **0개**여야 한다 — 뒤에 놓으면 스프레드를 덮는다.
        if (direct === 0 && spread) out.agent = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
};


/**
 * `index.ts` 가 `/models` 렌더에 **진짜 해석기**를 꽂는가 — AST 로 본다.
 *
 * ★이게 없으면 P1 수정이 통째로 무효가 된다(2026-09-11 적대 검토 G1). `() => undefined`
 *  로 바꾸면 화면의 **모든 행**이 «이 provider 는 안 읽음» 이 되는데, 그물이 0이라 초록이었다.
 * ★검사 본문은 렌더러에 **자기가 만든 해석기**를 주입해 돌린다 — 그건 렌더러의 판정을 재지
 *  제품이 무엇을 꽂는지는 안 본다. 그 자리를 여기서 본다.
 * ★형제 `caps` 도 같은 구멍이었다(G1b) — `models-view-shows-caps` 가 «배선까지 잰다» 고
 *  적어 놓고 `modelCapsFor` → `undefined` 변이에 초록이었다. 그래서 **둘 다** 본다.
 */
const modelsRenderGetsRealLookups = (): { adapterOf: boolean; caps: boolean } => {
  // 6번째 = caps, 7번째 = 대가 키 해석기 (필수 인자이므로 자리로 센다).
  const args = callArgTexts("src/index.ts", "renderModelProfiles")[0] ?? [];
  return {
    caps: args[5] === "modelCapsFor",
    // ★해석기는 **런타임과 같은 함수**여야 한다 (2026-09-12 N6). 종전엔 «`parseModelSpec` 을
    //  부르는 클로저인가» 를 봤는데, 그 모양이면 호출부가 자기 판정을 새로 조립할 수 있다 —
    //  그리고 실제로 그러면 운반(어댑터)과 표시(화면)가 갈린다. 이름 하나로 못박으면
    //  판정이 한 곳에 남고, 그 함수의 옳음은 검사 본문이 **돌려서** 잰다.
    adapterOf: args[6] === "speedCostKeyFor",
  };
};

export const check: RegressionCheck = {
  name: "speed-tier-is-adapter-agnostic",
  guards:
    "«빠름» 이 어댑터를 가리던 것 — 계약·파서·화면은 다 나갔는데 claude 번역이 빠져 같은 " +
    "설정이 어댑터마다 다르게 굴었고(화면은 그걸 provider 탓으로 적었다), openai 어댑터는 " +
    "아예 안 읽었다. 그리고 그 어댑터는 다대일이라 compat 백엔드로 벤더 낱말이 새거나 " +
    "없는 비용이 화면에 뜨는 반대 사고가 같이 걸린다",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { claudeSpeedSettings, SPEED_TIER_COST } = await import(
      "../../core/llm-runtime/types.js"
    );
    const { poolToSpecs, adapterInputFor, speedCostKeyFor } = await import(
      "../../core/llm-runtime/index.js"
    );
    const { openaiSpeedSettings } = await import(
      "../../core/llm-runtime/adapters/_openai-speed.js"
    );
    const { resolveProviderConn } = await import("../../core/llm-runtime/provider-registry.js");

    // ── ⓪ **프로파일에 적은 «빠름» 이 어댑터 낱말까지 도달하는가** — 전 구간 연쇄 ────────
    //
    // ★이 축이 통째로 비어 있었다 (2026-09-12, 외부 사냥 #3·#4). 두 자리를 `...({})` 로
    //  바꾸면 **빠름이 어댑터에 아예 안 실리는데**(기능 0·로그 0) 전체 스위트가 초록이었다:
    //    `poolToSpecs`  — 프로파일 → spec (메인 턴·세션 프로파일·폴백 체인이 전부 탄다)
    //    `adapterInputFor` — spec → 턴 입력 (어댑터가 받는 최종 모양)
    //  아래 ①~② 는 «어댑터가 그 값을 낱말로 옮기나» 를 재고 있었다 — 즉 **값이 거기까지
    //  오는가** 는 아무도 안 봤다. 번역만 재고 운반을 안 잰 것이다.
    // ★그래서 **끝에서 끝까지 한 줄로** 잇는다. 중간 어느 고리가 끊겨도 마지막이 `{}` 가 된다.
    //  모양으로 위치를 재지 않는다 — 오늘 뚫린 일곱 중 다섯이 그 뿌리였다.
    {
      const base = { text: "t", threadKey: "k", channel: "cli", cwd: "." } as never;
      const chain = (entry: { spec: string; speed?: string }): Record<string, unknown> => {
        const specs = poolToSpecs([entry as never]);
        const first = specs[0];
        if (first === undefined) return { "★spec 0개": true };
        return claudeSpeedSettings(adapterInputFor(base, first).speed) as Record<string, unknown>;
      };
      const onFast = chain({ spec: "anthropic:claude-opus-5", speed: "fast" });
      const offPlain = chain({ spec: "anthropic:claude-opus-5" });
      out.push(
        assert(
          "★★프로파일에 적은 «빠름» 이 **어댑터 낱말까지 도달한다**(풀 원소 → spec → 턴 입력 → SDK 설정) — 중간 한 고리만 끊겨도 기능이 통째로 죽는데, 종전엔 번역만 재고 **운반은 아무도 안 봤다**",
          JSON.stringify(onFast) === JSON.stringify({ settings: { fastMode: true } }),
          JSON.stringify(onFast),
        ),
        assert(
          "★안 적은 프로파일은 **끝까지 안 켜진다** — 운반 고리가 값을 지어내면 한도를 태우는데 사용자는 모른다(반대 방향도 같이 봐야 «항상 켬» 으로 통과하지 못한다)",
          Object.keys(offPlain).length === 0,
          JSON.stringify(offPlain),
        ),
      );

      // 고리별로도 하나씩 — 어디서 끊겼는지 로그가 바로 말하게(연쇄만 있으면 진단이 한 칸 멀다).
      const spec1 = poolToSpecs([{ spec: "anthropic:m", speed: "fast" } as never])[0];
      const spec2 = poolToSpecs([{ spec: "anthropic:m" } as never])[0];
      out.push(
        assert(
          "★고리 1 — `poolToSpecs` 가 풀 원소의 `speed` 를 spec 에 **옮긴다**",
          (spec1 as { speed?: string } | undefined)?.speed === "fast",
          JSON.stringify(spec1),
        ),
        assert(
          "★고리 1 반대 — 안 적었으면 spec 에 **키 자체가 없다**",
          spec2 !== undefined && !("speed" in (spec2 as object)),
          JSON.stringify(spec2),
        ),
        assert(
          "★고리 2 — `adapterInputFor` 가 spec 의 `speed` 를 턴 입력에 **옮긴다**",
          adapterInputFor(base, { adapter: "claude", model: "m", speed: "fast" } as never).speed ===
            "fast",
          String(
            adapterInputFor(base, { adapter: "claude", model: "m", speed: "fast" } as never).speed,
          ),
        ),
        assert(
          "★고리 2 반대 — spec 에 없으면 턴 입력에도 **키 자체가 없다**(`speed: undefined` 도 키다)",
          !("speed" in adapterInputFor(base, { adapter: "claude", model: "m" } as never)),
          JSON.stringify(
            Object.keys(adapterInputFor(base, { adapter: "claude", model: "m" } as never)).filter(
              (k) => k === "speed",
            ),
          ),
        ),
        // ★형제 필드(`reasoning`)도 같은 운반로를 탄다 — 한 고리를 고치다 옆을 빠뜨리는 것이
        //  이 레포의 반복 사고라, 같이 본다.
        assert(
          "★같은 운반로의 `reasoning` 도 살아 있다 — 한쪽만 고치다 옆 필드가 조용히 빠지는 걸 막는다",
          adapterInputFor(base, {
            adapter: "claude",
            model: "m",
            reasoning: "high",
          } as never).reasoning === "high",
          String(
            adapterInputFor(base, { adapter: "claude", model: "m", reasoning: "high" } as never)
              .reasoning,
          ),
        ),
      );

      // ── ⓪b **openai 어댑터도 같은 연쇄를 탄다** (2026-09-12, N6 parity) ──────────
      //
      // ★종전엔 이 어댑터만 `speed` 를 **안 읽었다** — 같은 settings.json 이 어댑터를 바꾸는
      //  순간 아무 신호 없이 무시됐다(원칙 #2 위반). 형제 `reasoning` 이 2026-08-15 에
      //  똑같이 빠져 있던 자리다.
      // ★그리고 이 어댑터는 **다대일**이다(openai·ollama·google·사용자 정의). `service_tier`
      //  는 api.openai.com 의 낱말이라 compat 백엔드로 새면 안 된다 — **양쪽 방향을 다 잰다.**
      const openaiChain = (spec: string, speed?: string): Record<string, unknown> => {
        const first = poolToSpecs([{ spec, ...(speed === undefined ? {} : { speed }) } as never])[0];
        if (first === undefined) return { "★spec 0개": true };
        return openaiSpeedSettings(
          adapterInputFor(base, first).speed,
          resolveProviderConn((first as { provider?: string }).provider)?.baseURL,
        ) as Record<string, unknown>;
      };
      const openaiFast = openaiChain("openai:gpt-5", "fast");
      const openaiPlain = openaiChain("openai:gpt-5");
      const ollamaFast = openaiChain("ollama:qwen3:8b", "fast");
      const googleFast = openaiChain("google:gemini-3-pro", "fast");
      out.push(
        assert(
          "★★openai 어댑터도 «빠름» 을 **끝까지 나른다**(풀 원소 → spec → 턴 입력 → 백엔드 낱말) — 종전엔 이 어댑터만 안 읽어서, 같은 설정이 어댑터를 바꾸는 순간 **아무 신호 없이** 무시됐다",
          JSON.stringify(openaiFast) === JSON.stringify({ providerData: { service_tier: "priority" } }),
          JSON.stringify(openaiFast),
        ),
        assert(
          "★안 적은 openai 원소는 **키 자체가 없다** — 대가가 있는 손잡이라 기본은 꺼짐이어야 한다",
          Object.keys(openaiPlain).length === 0,
          JSON.stringify(openaiPlain),
        ),
        assert(
          "★★compat 백엔드(ollama)엔 **안 샌다** — `service_tier` 는 api.openai.com 의 낱말이고, 그쪽엔 그 손잡이도 그 대가도 없다(잘해야 무시·나쁘면 400)",
          Object.keys(ollamaFast).length === 0,
          JSON.stringify(ollamaFast),
        ),
        assert(
          "★같은 어댑터로 오는 google 도 마찬가지 — 하나만 막으면 형제로 샌다",
          Object.keys(googleFast).length === 0,
          JSON.stringify(googleFast),
        ),
      );

      // ── ⓪c **화면이 쓰는 키도 같은 규칙으로 갈린다** — 돌려서 잰다 ────────────────
      //
      // ★운반과 표시가 각자 판정하면 반드시 갈리고, 갈린 방향이 «안 읽는다면서 돈은 나간다»
      //  면 사용자는 안심하고 켜 둔다(2026-09-11 P1 이 정확히 그 사고였다).
      const keys = [
        ["openai:gpt-5", "openai", "정품 openai — 읽는다"],
        ["ollama:qwen3:8b", undefined, "compat — 안 읽는다"],
        ["google:gemini-3-pro", undefined, "compat — 안 읽는다"],
        ["anthropic:claude-opus-5", "claude", "claude 어댑터"],
        ["codex:gpt-5.6-sol", "codex-oauth", "codex 어댑터"],
        ["없는provider:x", undefined, "해석 실패"],
      ] as const;
      const wrongKeys = keys.filter(([spec, want]) => speedCostKeyFor(spec) !== want);
      out.push(
        assert(
          "★★화면의 대가 키가 **운반과 같은 규칙**으로 갈린다 — 어댑터 이름만으로 찍으면 `ollama` 에 **없는 비용**이 뜨고(P4), provider 이름으로 찍으면 사용자 정의 이름이 **비용을 숨긴다**(P1)",
          wrongKeys.length === 0,
          keys.map(([spec, , label]) => `${label}=${String(speedCostKeyFor(spec))}`).join(" · "),
        ),
      );
    }

    // ── ① 번역: 켜는 값만 켠다 ────────────────────────────────────────────────
    out.push(
      assert(
        "★★`speed:\"fast\"` 가 claude 백엔드의 낱말로 옮겨진다 — 이게 없으면 프로파일에 적어도 claude 턴은 표준 속도로 돌고 사용자는 이유를 모른다",
        JSON.stringify(claudeSpeedSettings("fast")) === JSON.stringify({ settings: { fastMode: true } }),
        JSON.stringify(claudeSpeedSettings("fast")),
      ),
      assert(
        "★안 켠 턴엔 **키 자체가 없다** — `settings: undefined` 를 넘기면 SDK 가 «설정을 비우라» 로 읽을 수 있고, 그건 사용자의 settings.json 을 건드리는 일이다",
        Object.keys(claudeSpeedSettings(undefined)).length === 0,
        JSON.stringify(claudeSpeedSettings(undefined)),
      ),
      assert(
        "★모르는 값은 **조용히 켜지지 않는다** — 오타가 «켜짐» 이 되면 한도를 태우는데 사용자는 모른다(설정 파서의 규칙과 같은 방향)",
        Object.keys(claudeSpeedSettings("Fast")).length === 0 &&
          Object.keys(claudeSpeedSettings("priority")).length === 0 &&
          Object.keys(claudeSpeedSettings("true")).length === 0,
        `Fast=${JSON.stringify(claudeSpeedSettings("Fast"))} priority=${JSON.stringify(claudeSpeedSettings("priority"))}`,
      ),
    );

    // ── ② 배선: **실제로 렌더를 돌려** 각 어댑터의 대가가 맞게 찍히는지 본다 ──────
    // ★2026-09-11 적대 검토 G1·G4 정정. 첫 판은 소스 grep 이었고 **네 가지로 뚫렸다**:
    //  호출을 감싸 항상 `{}` 를 반환시켜도 · 로그를 `if (false && …)` 로 꺼도 · 대가를
    //  «크레딧 9배» 로 지어내도 · 파생을 손 목록으로 되돌려도 **11/11 초록**이었다.
    //  그리고 커밋이 «렌더까지 돌려 확인» 이라 자랑한 그 줄을 재는 어세션이 **0개**였다.
    //  이제 렌더를 실제로 돌린다 — 화면에 나오는 글자가 판정이다.
    // ★★**넷 중 셋만 닫혔다**(2026-09-11 적대 검토 G3). «로그 끄기» 는 **아직 안 잡힌다** —
    //  `if (false && input.speed === "fast")` 로 바꿔도 전체 초록이다. 이 검사에 fast-mode
    //  로그를 재는 어세션이 **0개**이기 때문이다. 로그는 «왜 안 켜졌나» 의 **유일한 답변
    //  경로**인데 그물이 없다. 여기 적어 두는 이유: 주석이 «이제 닫혔다» 로 읽히면 다음
    //  사람이 확인 없이 믿는다 — 그게 이 파일이 처음 가짜였던 방식이다.
    const { renderModelProfiles } = await import("../../core/entry/models-command.js");
    const { parseModelSpec } = await import("../../core/llm-runtime/index.js");
    const line = renderModelProfiles(
      {
        p: {
          pool: [
            { spec: "anthropic:claude-opus-5", speed: "fast" },
            { spec: "codex:gpt-5.6-sol", speed: "fast" },
            { spec: "openai:gpt-5", speed: "fast" },
            { spec: "ollama:qwen3:8b", speed: "fast" },
            { spec: "codex:gpt-5.6-terra" },
          ],
        },
      } as never,
      null,
      "p",
      {} as NodeJS.ProcessEnv,
      false,
      undefined,
      // ★**제품이 쓰는 그 함수**를 준다 (2026-09-12 N6). 종전엔 검사가 자기 해석기를 지어
      //  넣었는데, 그러면 «화면이 어떻게 렌더하나» 만 재고 «무엇을 기준으로 가르나» 는 못 잰다 —
      //  그리고 이 기준이 갈리는 게 P1·P4 사고의 뿌리였다.
      speedCostKeyFor,
    );
    out.push(
      assert(
        "★★claude 행이 **비용 2배**로 찍힌다 — 어댑터가 그 값을 실제로 보내는데 화면이 다른 말을 하면 사용자가 비용을 잘못 판단한다(축을 «단가» 로 못박지 않는다 — 구독 경로는 안 쟀다)",
        /claude-opus-5`\(빠름·비용 2배\)/.test(line),
        line.split("→")[0]?.trim() ?? line,
      ),
      assert(
        "★★codex 행은 **크레딧 2.5배** — 두 어댑터의 대가는 모양이 다르다(단가 vs 크레딧). 한쪽 값을 다른 쪽에 찍으면 그게 «없는 비용» 이다",
        /gpt-5\.6-sol`\(빠름·크레딧 2\.5배\)/.test(line),
        line,
      ),
      assert(
        // ★배수를 **안 지어낸다**(2026-09-12 N6). codex·claude 와 달리 OpenAI 우선 처리는
        //  모델마다 값이 다르고 우리가 잰 적이 없다. 그래도 «안 읽음» 이라 하면 안 된다 —
        //  그건 돈이 나가는데 안 나간다고 말하는 쪽이라 사용자가 안심하고 켜 둔다(P1).
        "★★openai 행은 «읽는다·대가 있다·배수는 모른다» 를 **그대로** 말한다 — 숫자를 지어내면 «없는 비용»(P4)이고, 표에서 빼면 «안 읽는다면서 돈은 나간다»(P1)다",
        /gpt-5`\(빠름·비용 더 듦·배수 미측정\)/.test(line),
        line,
      ),
      assert(
        "★정말 안 읽는 자리(ollama)에만 «안 읽음» 이 나온다 — 같은 **openai 어댑터**로 오지만 그쪽엔 그 손잡이가 없다",
        /qwen3:8b`\(빠름·이 provider 는 안 읽음\)/.test(line),
        line,
      ),
      assert(
        "★★안 켠 원소엔 «빠름» 표기가 **없다** — 기본이 표준임을 화면이 말한다",
        /gpt-5\.6-terra`(?!\(빠름)/.test(line),
        line,
      ),
    );

    // ── ②b 배선: 어댑터가 그 번역을 **정말 옵션에 싣는가**(AST) ──────────────────
    const claudeSrc = stripComments(
      readSourceSync("src/core/llm-runtime/adapters/claude-agent-sdk.ts"),
    );
    const codexSrc = stripComments(
      readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth.ts"),
    );
    out.push(
      assert(
        "★★claude 어댑터의 **옵션 리터럴 자체**가 그 번역을 펼친다 — 문자열만 맞고 결과가 버려지면(감싸서 항상 `{}`·다른 옵션으로 이동) 턴은 영원히 표준 속도인데 검사는 초록이다",
        spreadsSpeedIntoOptions(),
        spreadsSpeedIntoOptions() ? "options 리터럴의 최상위 스프레드로 확인(AST)" : "🔴 옵션에 안 실린다",
      ),
      assert(
        "★codex 어댑터도 같은 중립 신호를 읽는다 — 한쪽만 읽으면 그게 이 결함이었다",
        /input\.speed === "fast"/.test(codexSrc) && /service_tier/.test(codexSrc),
        `codex 가 speed 를 읽음=${/input\.speed === "fast"/.test(codexSrc)}`,
      ),
    );

    // ── ②c openai 어댑터 배선 — **세 어댑터가 다 읽는다** (2026-09-12 N6) ──────────
    const oa = openaiWiresSpeed();
    out.push(
      assert(
        "★★openai 어댑터의 **모델 설정 객체**가 그 번역을 편다 — 감싸서 결과를 버리면 턴은 영원히 표준 속도인데 문자열은 그대로다",
        oa.spread,
        oa.spread ? "modelSettings 리터럴의 최상위 스프레드로 확인(AST)" : "🔴 설정에 안 실린다",
      ),
      assert(
        "★형제 `reasoning` 이 **같은 객체 안**에 있다 — 한 고리를 고치다 옆을 빠뜨리는 것이 이 레포의 반복 사고고(2026-08-15 에 이 어댑터만 강도를 안 읽었다), 그 축엔 그물이 0이었다",
        oa.sibling,
        oa.sibling ? "modelSettings 안에서 확인(AST)" : "🔴 강도가 같은 객체에 없다",
      ),
      assert(
        "★★`Agent` 리터럴이 그걸 **스프레드로만** 받는다 — 뒤에 `modelSettings:` 를 직접 놓으면 통째로 덮인다(claude 옵션 리터럴의 `settings:` 와 같은 모양의 사고)",
        oa.agent,
        oa.agent ? "직접 지정 0개 + 스프레드 1개(AST)" : "🔴 덮이거나 안 꽂힌다",
      ),
    );

    // ── ③ ★P1: **사용자 정의 provider** 도 어댑터로 갈린다 ────────────────────────
    // ★이게 이 검사의 심장이다(2026-09-11 P1). `models.providers` 로 임의 이름을 claude
    //  어댑터에 붙일 수 있으므로, 판정을 provider **이름**으로 하면 화면은 «안 읽음» 인데
    //  실제로는 **2배 비용이 청구된다.** 오류 방향이 «안 나간다» 쪽이라 사용자가 안심하고
    //  켜 두는 것이 특히 나쁘다.
    const custom = renderModelProfiles(
      { p: { pool: [{ spec: "myclaude:claude-opus-5", speed: "fast" }] } } as never,
      null,
      "p",
      {} as NodeJS.ProcessEnv,
      false,
      undefined,
      // 사용자 정의 provider 가 claude 어댑터를 타는 상황을 그대로 재현한다.
      (sp) => (sp.startsWith("myclaude:") ? "claude" : parseModelSpec(sp)?.adapter),
    );
    out.push(
      assert(
        "★★**사용자 정의 provider 이름**이 claude 어댑터를 타면 화면도 비용 2배라고 말한다 — 이름으로 판정하면 «안 읽음» 이라 하면서 2배를 청구한다",
        /비용 2배/.test(custom) && !/안 읽음/.test(custom),
        custom,
      ),
    );

    // ── ④ 대가 값 자체가 옳은가 — «서로 다르기만 하면 통과» 를 막는다 ─────────────
    // ★G3 정정: 첫 판은 «두 값이 다른가» 만 봐서 «크레딧 9배» 같은 지어낸 값도 통과했다.
    out.push(
      assert(
        "★codex 는 **크레딧** 축 2.5배 — 공식 문서가 못박은 값이다(GPT-5.6·5.5·6-Astra)",
        SPEED_TIER_COST["codex-oauth"]?.unit === "credits" &&
          SPEED_TIER_COST["codex-oauth"]?.multiplier === 2.5,
        JSON.stringify(SPEED_TIER_COST["codex-oauth"]),
      ),
      assert(
        "★claude 는 **단가** 축 2배 — Opus 5 fast 는 $10/$50, 표준은 $5/$25. 크레딧 개념이 아니다",
        SPEED_TIER_COST["claude"]?.unit === "rate" && SPEED_TIER_COST["claude"]?.multiplier === 2,
        JSON.stringify(SPEED_TIER_COST["claude"]),
      ),
      assert(
        "★키는 **어댑터 이름**이다 — provider 이름(`anthropic`)으로 잡으면 사용자 정의 provider 가 새어 나간다",
        SPEED_TIER_COST["anthropic"] === undefined && SPEED_TIER_COST["codex"] === undefined,
        Object.keys(SPEED_TIER_COST).join("·"),
      ),
      assert(
        // ★이 어세션의 값은 «있다» 가 아니라 **«숫자가 없다»** 쪽이다. 누가 그럴듯한 배수를
        //  채워 넣는 순간 빨개진다 — 실측 없이 채우는 게 이 레포의 «단가 2배» 사고였다.
        "★★openai 는 표에 **있되 배수가 없다** — 읽는 건 맞으니 빠지면 안 되고(P1), 안 잰 수를 사용자 대면 문구에 쓰면 안 된다(P4). 재고 나서 적어라",
        SPEED_TIER_COST["openai"]?.unit === "rate" &&
          SPEED_TIER_COST["openai"]?.multiplier === undefined,
        JSON.stringify(SPEED_TIER_COST["openai"]),
      ),
    );

    // ── ⑤ 관측: 안 켜진 이유를 로그가 말한다 — **AST 로** 잰다 ────────────────────
    // ★G3 정정(2026-09-11). 앞 판은 이 축에 어세션이 **0개**였고, 그래서 로그를
    //  `if (false && …)` 로 꺼도 전체가 초록이었다. 로그는 «빠름 켰는데 왜 안 빨라지죠» 의
    //  **유일한 답변 경로**다 — 화면은 «적혔다» 만 보여주고 런타임 상태는 여기에만 있다.
    // ★소스에 문자열이 있는지로 재지 않는다(그게 뚫린 방식이다). 조건문이 **도달 가능한가**
    //  를 AST 로 본다: 게이트가 `input.speed === "fast"` 하나여야 하고, `false &&` 같은
    //  죽은 조건이 끼면 걸린다.
    const { parseFastMode } = await import("../../core/llm-runtime/fast-mode-view.js");
    const prescribed = parseFastMode(
      { fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" },
      "claude-opus-5",
    ).line;
    out.push(
      assert(
        "★★«빠름» 이 안 켜진 이유를 로그가 말한다 — 프로파일엔 적혀 있는데 런타임 상태는 로그에만 있다",
        speedLogIsReachable(),
        speedLogIsReachable() ? "게이트가 input.speed === \"fast\" 하나(AST)" : "🔴 로그가 죽은 조건 뒤에 있거나 없다",
      ),
      assert(
        // ★소스 grep 이었다가 **실행**으로 바꿨다(2026-09-11 N2 수정). 문구가 어느 파일에
        //  사는지를 재던 것이라, 판정이 순수 모듈로 나가자 «처방이 사라졌다» 고 빨개졌다 —
        //  동작은 그대로인데. 처방은 «로그 줄에 나오는가» 이지 «이 파일에 있는가» 가 아니다.
        "★계정 설정으로 막힌 경우엔 **무엇을 하면 되는지**까지 말한다 — 증상만 적힌 로그는 한 번 더 묻게 만든다",
        prescribed?.includes("추가 사용량") === true,
        prescribed ?? "(줄 없음)",
      ),
    );

    // ── ⑥ 배선: 제품이 렌더에 **진짜 조회기**를 꽂는가 ────────────────────────────
    const wired = modelsRenderGetsRealLookups();
    out.push(
      assert(
        "★★`/models` 가 **런타임과 같은 판정 함수**를 받는다 — 끊으면(`() => undefined`) 모든 행이 «안 읽음» 이 되고, 호출부가 자기 클로저로 다시 조립하면 운반과 표시가 갈린다. 검사 본문은 함수를 주입해 돌리므로 이 자리를 못 본다",
        wired.adapterOf,
        wired.adapterOf ? "index.ts 가 speedCostKeyFor 를 꽂음(AST)" : "🔴 해석기가 안 꽂힌다",
      ),
      assert(
        "★형제 `caps` 배선도 같이 본다 — `models-view-shows-caps` 가 «배선까지 잰다» 고 적어두고 `modelCapsFor`→`undefined` 변이에 초록이었다(G1b)",
        wired.caps,
        wired.caps ? "index.ts 가 modelCapsFor 를 꽂음(AST)" : "🔴 caps 가 안 꽂힌다",
      ),
    );

    return out;
  },
};
