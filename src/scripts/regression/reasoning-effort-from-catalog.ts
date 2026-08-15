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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadModelReasoning } from "../../core/settings.js";
import { mergeReasoning } from "../../core/llm-runtime/model-catalog.js";
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

  // ── ★우선순위를 **실행해서** 확인한다 (2026-08-14 적대 검토 ①·④ — 각 4점) ──
  //  종전엔 소스에 `const override = …; if (override !== undefined) return override;`
  //  **두 줄이 있는지**만 봤다. 변이 시험에서 순서를 뒤집자(카탈로그 먼저 조회) 그대로
  //  통과했고, 실측하면 `models.reasoning="high"` 인데 카탈로그의 `low` 가 나갔다 —
  //  사용자가 적은 설정이 **조용히 무시**된다. 정규식은 "그 줄이 있나" 를 볼 뿐
  //  "어느 쪽이 이기나" 를 못 본다. 그래서 진짜 캐시 파일·진짜 설정을 깔고 **부른다**.
  //  ★자식 프로세스인 이유: `getPaths()` 가 홈을 캐시해서 부모 안에서 바꿔봐야 안 먹는다.
  {
    const home = mkdtempSync(path.join(tmpdir(), "reasoning-home-"));
    writeFileSync(
      path.join(home, "model-catalog.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        models: { codex: ["gpt-5.6-sol"] },
        reasoning: {
          "codex:gpt-5.6-sol": "low",
          "codex:gpt-5.6-terra": "medium",
          // ★쓰레기 값 — 손편집·부분기록된 캐시를 흉내 낸다(적대 검토 B1).
          "codex:junk-num": 3,
          "codex:junk-obj": { nested: 1 },
          "codex:junk-null": null,
          "codex:junk-empty": "",
          "codex:junk-blank": "   ",
        },
      }),
      "utf8",
    );
    const proj = projectWith({
      models: { reasoning: { "codex:gpt-5.6-sol": "high", "codex:gpt-5.6-terra": "xhigh" } },
    });
    // ★홈 레이어에도 같은 키를 둔다 — 순회를 뒤집으면(홈이 이김) 여기서 죽는다(B2).
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ models: { reasoning: { "codex:gpt-5.6-terra": "low" } } }),
      "utf8",
    );
    const plain = mkdtempSync(path.join(tmpdir(), "reasoning-plain-"));
    const child = new URL("./_reasoning-effort-child.ts", import.meta.url);
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(child), proj, plain],
      { encoding: "utf8", env: { ...process.env, TIGUCLAW_HOME: home } },
    );
    let got: Record<string, string | null> = {};
    try {
      got = JSON.parse(r.stdout.trim()) as Record<string, string | null>;
    } catch {
      /* 아래 단언이 실패로 드러낸다 */
    }
    out.push(
      assert(
        "★카탈로그 기본이 실제로 적용된다(저장·조회가 이어져 있다)",
        got.catalogOnly === "low",
        `sol → ${String(got.catalogOnly)} (기대 low) ${r.stdout.slice(0, 80)}${r.stderr.slice(0, 120)}`,
      ),
    );
    out.push(
      assert(
        "★사용자 덮어쓰기가 카탈로그를 이긴다(적어둔 설정이 조용히 무시되지 않는다)",
        got.overridden === "high",
        `override=high · catalog=low → ${String(got.overridden)}`,
      ),
    );
    out.push(
      assert(
        "★anthropic 은 기본값이 없다(정품 Claude Code 와 같은 상태 = 미전송)",
        got.anthropic === null,
        String(got.anthropic),
      ),
    );
    out.push(
      assert(
        "★캐시의 쓰레기 값(숫자·객체·null)이 wire 로 안 샌다",
        got.junkNum === null &&
          got.junkObj === null &&
          got.junkNull === null &&
          got.junkEmpty === null &&
          got.junkBlank === null,
        `num=${String(got.junkNum)} obj=${String(got.junkObj)} null=${String(got.junkNull)}` +
          ` empty=${JSON.stringify(got.junkEmpty)} blank=${JSON.stringify(got.junkBlank)}`,
      ),
    );
    out.push(
      assert(
        "★프로젝트 설정이 홈 설정을 이긴다(레이어 순서)",
        got.layered === "xhigh",
        `프로젝트=xhigh 홈=low → ${String(got.layered)}`,
      ),
    );
    out.push(
      assert(
        "모르는 모델은 미전송(추측값 금지)",
        got.unknown === null,
        String(got.unknown),
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

  // ── ★조회 결과가 **사라진 키를 지운다** (적대 검토 F9) ──────────────────────
  //  종전엔 이 경로에 검사가 하나도 없어서(`refreshModelCatalog` 는 네트워크·인증 뒤라
  //  검사가 못 닿는다) 삭제 로직을 통째로 되돌려도 초록이었다. 판정만 순수 함수로
  //  꺼냈으므로 이제 **실행해서** 본다.
  {
    const t: Record<string, string> = {
      "codex:a": "low",
      "codex:b": "high", // 벤더가 없앤 모델
      "anthropic:x": "medium", // 다른 provider — 건드리면 안 된다
    };
    const changed = mergeReasoning(t, "codex", { "codex:a": "low", "codex:c": "xhigh" });
    out.push(
      assert(
        "★벤더가 없앤 강도는 캐시에서도 사라진다(병합만 하면 옛 값이 영구히 이긴다)",
        !("codex:b" in t) && t["codex:c"] === "xhigh" && t["codex:a"] === "low",
        JSON.stringify(t),
      ),
    );
    out.push(
      assert(
        "★한 provider 조회가 다른 provider 값을 지우지 않는다",
        t["anthropic:x"] === "medium",
        `anthropic:x=${String(t["anthropic:x"])}`,
      ),
    );
    const same = mergeReasoning({ ...t }, "codex", { "codex:a": "low", "codex:c": "xhigh" });
    out.push(
      assert(
        "바뀐 게 없으면 changed=false(같은 값에 디스크를 쓰지 않는다)",
        changed && !same,
        `첫 병합=${changed} 재병합=${same}`,
      ),
    );
  }

  // ── ★어댑터를 **손으로 열거하지 않는다** (적대 검토 F10) ────────────────────
  //  openai 어댑터만 이 설정 키를 안 읽어서, `openai:<모델>` 로 적으면 아무 신호 없이
  //  무시됐다. 원인은 검사가 "claude 도 읽는다" 처럼 **이름을 손으로 적어** 세 번째
  //  어댑터에 같은 질문을 안 한 것이다. 목록을 **디스패치 지점에서 파생**시킨다 —
  //  네 번째 어댑터가 생기면 그 순간 이 검사가 묻는다.
  {
    const idx = await readFile(
      new URL("../../core/llm-runtime/index.ts", import.meta.url),
      "utf8",
    );
    const files = [
      ...idx.matchAll(/import \{ run\w+ \} from "\.\/adapters\/([\w-]+)\.js";/g),
    ].map((m) => m[1] ?? "");
    const missing: string[] = [];
    for (const f of files) {
      const r = await sourceHas(`../../core/llm-runtime/adapters/${f}.ts`, [
        /resolveReasoningEffort\(/,
      ]);
      if (!r.ok) missing.push(f);
    }
    out.push(
      assert(
        "★디스패치되는 모든 어댑터가 같은 설정 키를 읽는다(어댑터를 바꿔도 무시 0)",
        files.length >= 3 && missing.length === 0,
        missing.length === 0
          ? `어댑터 ${files.length}개 확인: ${files.join(", ")}`
          : `★안 읽는 어댑터: ${missing.join(", ")}`,
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
