/**
 * 회귀: **OpenAI 호환 provider 를 설정 한 줄로 붙일 수 있다** (2026-08-06).
 *
 * 배경: 2026-06-24 백로그는 "OpenRouter 어댑터 신설" 을 최우선으로 적었는데, 그 사이
 * (2026-07-18) config-driven provider 가 들어가면서 **어댑터를 새로 만들 필요가 없어졌다** —
 * `settings.json` 의 `models.providers.<name>` 에 `{adapter:"openai", baseURL, apiKeyEnv}`
 * 를 적으면 OpenRouter·together·groq·vLLM 등 OpenAI 호환 엔드포인트가 그대로 붙는다.
 *
 * ★그런데 이 기능은 **README·docs·어디에도 없었다.** 코드에 있고 아무도 모르는 기능은
 *  없는 기능이다(이 레포에서 반복된 부류 — 죽은 게이트·안 실리는 인덱스). 문서를 붙이는
 *  김에, 그 문서가 약속하는 계약을 여기에 못 박는다: **문서가 시키는 대로 적으면 실제로
 *  그 좌표가 나온다**. 문서와 코드가 갈리면 이 검사가 먼저 운다.
 *
 * 네트워크 0 — 좌표 해석만 본다(실제 호출은 키가 필요하고 그건 여기 범위 밖).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** settings.json 만 있는 일회용 cwd — 실제 홈·데몬 불변. */
const withSettings = (models: unknown): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-provider-"));
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ models }, null, 2),
    "utf8",
  );
  return dir;
};

export const check: RegressionCheck = {
  name: "openai-compatible-provider",
  guards:
    "OpenAI 호환 provider(OpenRouter 등)를 설정으로 붙이는 경로 — 문서가 약속하는 계약",
  run: async (): Promise<Assertion[]> => {
    const { resolveProviderConn, listProviderNames } = await import(
      "../../core/llm-runtime/provider-registry.js"
    );

    // ★README 가 그대로 싣는 예시. 문서를 고치면 여기도 같이 깨져야 한다.
    const cwd = withSettings({
      providers: {
        openrouter: {
          adapter: "openai",
          baseURL: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
        // 미지 어댑터는 거부돼야 한다(오타가 조용히 도는 provider 를 만들면 안 된다).
        bogus: { adapter: "not-an-adapter", apiKeyEnv: "X" },
        // 빌트인 이름 덮어쓰기 시도 — 하드코딩이 authoritative.
        anthropic: {
          adapter: "openai",
          baseURL: "https://evil.example/v1",
          apiKeyEnv: "X",
        },
      },
    });

    const or = resolveProviderConn("openrouter", cwd);
    const bogus = resolveProviderConn("bogus", cwd);
    const anth = resolveProviderConn("anthropic", cwd);
    const names = listProviderNames(cwd);

    // ★README 가 **이 예시 그대로** 실려 있는지 — 문서와 코드가 갈리는 순간 여기서 운다.
    //  (문서만 고치고 코드를 안 고치는 쪽도, 그 반대도 같은 검사에 걸린다.)
    const { readFile } = await import("node:fs/promises");
    const docHits: string[] = [];
    // ★"README" 가 아니라 **사용자가 읽는 문서 묶음**을 본다 (2026-08-11). 설정 예시가
    //  README 에서 `docs/setup.md` 로 옮겨가자 이 검사가 울었다 — 내용이 사라진 게 아니라
    //  자리가 바뀐 것이었다. 대상을 한 파일로 박아두면 문서를 정리할 때마다 게이트가 운다.
    for (const rel of [
      "_workspace/public-overlay/README.md",
      "_workspace/public-overlay/README.en.md",
      "docs/setup.md",
      "docs/setup.en.md",
    ]) {
      const url = new URL(`../../../${rel}`, import.meta.url);
      let doc: string;
      try {
        doc = await readFile(url, "utf8");
      } catch {
        // ★배포 레포엔 `_workspace/` 가 없다(매니페스트 EXCLUDE) — 거기선 이 축이 대상 아님.
        //  조용한 통과 금지: 무엇을 못 봤는지 아래 detail 에 남긴다.
        docHits.push(`${rel}:없음`);
        continue;
      }
      const ok =
        doc.includes('"baseURL": "https://openrouter.ai/api/v1"') &&
        doc.includes('"apiKeyEnv": "OPENROUTER_API_KEY"') &&
        doc.includes('"adapter": "openai"');
      docHits.push(`${rel}:${ok ? "일치" : "—"}`);
    }
    // ★판정은 **언어별로 한 곳 이상**이다. 예시가 README 에 있든 setup 문서에 있든
    //  사용자가 읽는 자리에 있으면 된다 — 파일을 지목하면 문서 정리를 막는 게이트가 된다.
    const langHas = (suffix: string): boolean =>
      docHits.some((h) => h.includes(suffix) && h.endsWith("일치"));
    const docsAgree = langHas(".en.md") && docHits.some(
      (h) => !h.includes(".en.md") && h.endsWith("일치"),
    );

    return [
      assert(
        "★OpenAI 호환 provider 가 설정만으로 해석된다(어댑터 신설 불요)",
        or !== null &&
          or.adapter === "openai" &&
          or.baseURL === "https://openrouter.ai/api/v1" &&
          or.apiKeyEnv === "OPENROUTER_API_KEY",
        or === null ? "해석 실패" : `${or.adapter} / ${String(or.baseURL)}`,
      ),
      assert(
        "목록에 떠서 비서·대시보드가 존재를 안다(있는데 안 보이면 없는 것)",
        names.includes("openrouter"),
        names.join(","),
      ),
      assert(
        "미지 adapter 는 거부한다(오타가 조용히 도는 provider 가 되지 않게)",
        bogus === null && !names.includes("bogus"),
        `bogus=${bogus === null ? "null" : "해석됨"}`,
      ),
      assert(
        "★빌트인 이름은 설정이 못 덮는다(anthropic 을 남의 엔드포인트로 돌릴 수 없다)",
        anth !== null && anth.adapter === "claude" && anth.baseURL === undefined,
        anth === null ? "null" : `${anth.adapter} / ${String(anth.baseURL)}`,
      ),
      assert(
        "★README(영·한)의 예시가 이 검사가 돌린 설정과 같다(문서-코드 드리프트 0)",
        docsAgree,
        docHits.join(" · "),
      ),
    ];
  },
};
