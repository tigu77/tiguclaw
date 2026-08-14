/**
 * 회귀: 추론 강도를 **모델이 말한 값**으로 보내고, 사용자가 모델별로 덮을 수 있다 (2026-08-14).
 *
 * 사고: "티구클로 codex 가 왜 느린가" 를 파다 나왔다. 우리는 `reasoning` 필드를 **아예 안
 * 보내서** 백엔드 기본을 받고 있었는데, 그건 모델 카탈로그가 말하는 기본과 달랐다.
 * codex `/models` 응답은 모델마다 `default_reasoning_level` 을 주고(실측: sol=low ·
 * terra/luna/5.5=medium) 정품 CLI 는 그 값을 명시해 보낸다. 즉 우리는 **빠르라고 만든
 * 모델(sol)을 고른 적도 없이 더 무겁게** 굴리고 있었다.
 * 실측(XL 벤치, 깨끗한 픽스처): 명시 low 로 바꾸니 출력 7,229 → 4,567(**−37%**).
 *
 * ★그리고 이 값은 **우리가 이미 받아서 버리던** 것이다 — model-catalog 가 같은 응답에서
 *  `slug` 만 꺼내고 나머지를 버렸다.
 *
 * 이 검사가 지키는 것:
 *  ① 모델별 표를 **코드에 박지 않는다** — sol=low·terra=medium 처럼 이미 갈려 있어서
 *    손으로 적으면 모델이 늘 때마다 드리프트한다. 카탈로그에서 온다.
 *  ② 사용자가 **모델 키로** 덮을 수 있다(`models.reasoning`) — 프로파일이 아니라 모델의
 *    성질이다(프로파일 하나에 여러 provider 모델이 섞인다).
 *  ③ **모르면 안 보낸다** — 추측값을 씌우면 종전보다 나쁘다.
 *  ④ claude 는 대상이 아니다 — 등급 개념이 없다(adaptive thinking).
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadModelReasoning } from "../../core/settings.js";
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** `.tiguclaw/settings.json` 한 장 있는 임시 프로젝트 — loadModelReasoning 의 실제 경로. */
const projectWith = (settings: unknown): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "reasoning-regr-"));
  mkdirSync(path.join(dir, ".tiguclaw"), { recursive: true });
  writeFileSync(
    path.join(dir, ".tiguclaw", "settings.json"),
    JSON.stringify(settings),
    "utf8",
  );
  return dir;
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ② 모델 키로 덮인다 ────────────────────────────────────────────────────
  {
    const dir = projectWith({
      models: { reasoning: { "codex:gpt-5.6-sol": "high", "codex:gpt-5.5": "xhigh" } },
    });
    const m = loadModelReasoning(dir);
    out.push(
      assert(
        "★모델 키(provider:model)로 덮어쓴다",
        m.get("codex:gpt-5.6-sol") === "high" && m.get("codex:gpt-5.5") === "xhigh",
        `sol=${m.get("codex:gpt-5.6-sol")} 5.5=${m.get("codex:gpt-5.5")}`,
      ),
    );
    out.push(
      assert(
        "안 적은 모델은 비어 있다(부재=모름, 기본값 강요 아님)",
        m.get("codex:gpt-5.6-terra") === undefined,
        `terra=${String(m.get("codex:gpt-5.6-terra"))}`,
      ),
    );
  }

  // ── 유효값 목록을 우리가 흉내 내지 않는다 ─────────────────────────────────
  //  지원 강도는 모델마다 다르다(sol 은 max·ultra 까지, 5.5 는 xhigh 까지). 우리가 목록을
  //  들고 있으면 새 등급이 나올 때 **멀쩡한 값을 막는다** — 문자열이면 통과시키고 판정은
  //  백엔드(400)에 맡긴다.
  {
    const dir = projectWith({ models: { reasoning: { "codex:gpt-5.6-sol": "ultra" } } });
    out.push(
      assert(
        "★모르는 등급도 통과시킨다(화이트리스트 금지 — 새 등급을 우리가 막지 않는다)",
        loadModelReasoning(dir).get("codex:gpt-5.6-sol") === "ultra",
        `ultra=${String(loadModelReasoning(dir).get("codex:gpt-5.6-sol"))}`,
      ),
    );
  }

  // ── 쓰레기 값은 무시(never-throw) ─────────────────────────────────────────
  {
    const dir = projectWith({ models: { reasoning: { "codex:x": 3, "codex:y": "", "codex:z": null } } });
    const m = loadModelReasoning(dir);
    out.push(
      assert(
        "숫자·빈문자·null 은 무시한다(부팅·턴 생존)",
        m.size === 0,
        `남은 항목 ${m.size}개`,
      ),
    );
  }

  // ── ①·③·④ 배선 — 값의 출처와 부재 처리 ──────────────────────────────────
  {
    const w = await sourceHas("../../core/llm-runtime/model-catalog.ts", [
      // 카탈로그 응답에서 실제로 그 필드를 꺼낸다(버리지 않는다).
      /default_reasoning_level/,
      // 덮어쓰기가 카탈로그보다 우선.
      /const override = loadModelReasoning\(cwd\)\.get\(key\);\s*\n\s*if \(override !== undefined\) return override;/,
    ]);
    out.push(
      assert(
        "★값은 카탈로그에서 오고, 사용자 덮어쓰기가 우선한다",
        w.ok,
        w.ok ? "확인" : `누락 ${w.missing.join(" ")}`,
      ),
    );
    const a = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        // ★모르면 **안 보낸다** — 이 가드가 사라지면 undefined 가 wire 로 나간다.
        /const effort = resolveReasoningEffort\("codex", model, input\.cwd\);\s*\n\s*if \(effort !== undefined\) body\.reasoning = \{ effort \};/,
      ],
    );
    out.push(
      assert(
        "★강도를 모르면 필드를 안 보낸다(추측값 금지 — 종전 동작 유지)",
        a.ok,
        a.ok ? "가드 확인" : `누락 ${a.missing.join(" ")}`,
      ),
    );
    // ④ ★claude 도 **같은 설정 키**를 읽는다 — 단, 기본값은 만들지 않는다 (2026-08-14 정정).
    //
    //  처음엔 "claude 는 등급 개념이 없다(adaptive thinking)" 며 대상에서 뺐는데 **틀렸다**:
    //  Agent SDK 에 `effort: 'low'|'medium'|'high'|'xhigh'|'max'` 가 있고 이름도 값도 같다.
    //  내가 확인한 건 "우리 어댑터가 안 읽는다" 였는데 거기서 "그 어댑터엔 그 축이 없다" 로
    //  넘어갔다(한쪽 끝만 보고 반대쪽 추정).
    //
    //  ★기준은 "정품 클라이언트와 같은가"(사용자 정리): codex 는 정품 CLI 가 카탈로그 값을
    //   명시해 보내니 우리도 보내야 같아지고, claude 는 정품(Claude Code)도 SDK 기본으로
    //   도니 **안 보내는 것이 이미 같은 것**이다. 그래서 claude 엔 기본값을 안 만든다.
    //   그럼에도 손잡이는 있어야 한다 — 설정이 어댑터를 가리면 원칙 #2 위반이다.
    const c = await sourceHas("../../core/llm-runtime/adapters/claude-agent-sdk.ts", [
      /resolveReasoningEffort\(input\.provider \?\? "anthropic"/,
    ]);
    out.push(
      assert(
        "★claude 도 같은 설정 키를 읽는다(설정이 어댑터를 가리지 않는다)",
        c.ok,
        c.ok ? "손잡이 확인" : `누락 ${c.missing.join(" ")}`,
      ),
    );
    // ★그리고 claude 엔 **기본값이 없다** — 카탈로그에 anthropic 항목이 없으므로 자연히
    //  "덮어쓰기가 있을 때만" 이 된다. 여기에 정적 기본을 심으면 정품과 갈린다.
    const noDefault = await sourceHas("../../core/llm-runtime/model-catalog.ts", [
      /reasoning\[`codex:\$\{r\.slug\}`\]/,
    ]);
    out.push(
      assert(
        "카탈로그 기본은 codex 만 채운다(claude 기본값을 지어내지 않는다)",
        noDefault.ok,
        noDefault.ok ? "codex 스코프 확인" : `누락 ${noDefault.missing.join(" ")}`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "reasoning-effort-from-catalog",
  guards:
    "추론 강도를 아무것도 안 보내 백엔드 기본으로 돌던 것 — 모델 카탈로그가 sol=low 라고 말하는데 우리만 더 무겁게 굴렸다(XL 출력 −37%). 모델별 표를 코드에 박거나 등급 화이트리스트로 새 값을 막는 것도 같이 막는다",
  run,
};
