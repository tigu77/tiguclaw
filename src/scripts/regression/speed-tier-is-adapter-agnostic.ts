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
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import ts from "typescript";
import { readSourceSync, stripComments } from "./_wiring.js";

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
 */
const speedLogIsReachable = (): boolean => {
  const src = ts.createSourceFile(
    "claude-agent-sdk.ts",
    readSourceSync("src/core/llm-runtime/adapters/claude-agent-sdk.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  let ok = false;
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n) && /fast_mode_state/.test(n.thenStatement.getText())) {
      const c = n.expression;
      ok =
        ts.isBinaryExpression(c) &&
        c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        c.left.getText() === "input.speed" &&
        c.right.getText() === '"fast"';
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return ok;
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
  const src = ts.createSourceFile(
    "index.ts",
    readSourceSync("src/index.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  const out = { adapterOf: false, caps: false };
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "renderModelProfiles"
    ) {
      const args = n.arguments;
      // 6번째 = caps, 7번째 = adapterOf (필수 인자이므로 자리로 센다).
      const caps = args[5]?.getText() ?? "";
      const ad = args[6]?.getText() ?? "";
      if (caps === "modelCapsFor") out.caps = true;
      // 해석기는 `parseModelSpec` 을 실제로 부르는 클로저여야 한다.
      if (/parseModelSpec\s*\(/.test(ad) && /\.adapter/.test(ad)) out.adapterOf = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
};

export const check: RegressionCheck = {
  name: "speed-tier-is-adapter-agnostic",
  guards:
    "«빠름» 이 codex 에서만 돌던 것 — 계약·파서·화면은 다 나갔는데 claude 어댑터 번역만 " +
    "빠져서, 같은 설정이 어댑터마다 다르게 굴고 화면은 그걸 provider 탓으로 적었다",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { claudeSpeedSettings, SPEED_TIER_COST } = await import(
      "../../core/llm-runtime/types.js"
    );

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
      (sp) => parseModelSpec(sp)?.adapter,
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
        "★정말 안 읽는 어댑터(ollama)에만 «안 읽음» 이 나온다",
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
    );

    // ── ⑤ 관측: 안 켜진 이유를 로그가 말한다 — **AST 로** 잰다 ────────────────────
    // ★G3 정정(2026-09-11). 앞 판은 이 축에 어세션이 **0개**였고, 그래서 로그를
    //  `if (false && …)` 로 꺼도 전체가 초록이었다. 로그는 «빠름 켰는데 왜 안 빨라지죠» 의
    //  **유일한 답변 경로**다 — 화면은 «적혔다» 만 보여주고 런타임 상태는 여기에만 있다.
    // ★소스에 문자열이 있는지로 재지 않는다(그게 뚫린 방식이다). 조건문이 **도달 가능한가**
    //  를 AST 로 본다: 게이트가 `input.speed === "fast"` 하나여야 하고, `false &&` 같은
    //  죽은 조건이 끼면 걸린다.
    out.push(
      assert(
        "★★«빠름» 이 안 켜진 이유를 로그가 말한다 — 프로파일엔 적혀 있는데 런타임 상태는 로그에만 있다",
        speedLogIsReachable(),
        speedLogIsReachable() ? "게이트가 input.speed === \"fast\" 하나(AST)" : "🔴 로그가 죽은 조건 뒤에 있거나 없다",
      ),
      assert(
        "★계정 설정으로 막힌 경우엔 **무엇을 하면 되는지**까지 말한다 — 증상만 적힌 로그는 한 번 더 묻게 만든다",
        /extra_usage_disabled/.test(claudeSrc) && /추가 사용량/.test(claudeSrc),
        `처방 있음=${/추가 사용량/.test(claudeSrc)}`,
      ),
    );

    // ── ⑥ 배선: 제품이 렌더에 **진짜 조회기**를 꽂는가 ────────────────────────────
    const wired = modelsRenderGetsRealLookups();
    out.push(
      assert(
        "★★`/models` 가 **진짜 어댑터 해석기**를 받는다 — 끊으면(`() => undefined`) 모든 행이 «안 읽음» 이 되어 P1 수정이 통째로 무효가 되는데, 검사 본문은 자기가 만든 해석기를 주입하므로 이 자리를 못 본다",
        wired.adapterOf,
        wired.adapterOf ? "index.ts 가 parseModelSpec().adapter 를 꽂음(AST)" : "🔴 해석기가 안 꽂힌다",
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
