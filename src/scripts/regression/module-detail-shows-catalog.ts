/**
 * 회귀: **모듈 상세가 «그 provider 로 뭘 쓸 수 있나» 를 보여준다** (2026-09-02 정태님:
 * *"상세보기가 디테일한 부분들을 잘 보여줬으면 해 / llm프로바이더의 경우 벤더및 모델
 * 목록이 될 수 있겠지"*).
 *
 * ★종전 상세는 **제목이 자기 이름뿐인 카드 하나**였다 — 담긴 게 `provider`·`adapter`·
 *  `apiKeyEnv` 라 요약과 같은 내용이었고, 파고들 게 없었다. 정작 모델 목록은 카탈로그가
 *  부팅·매시 받아두고 있었는데 화면에 도달하는 경로가 0이었다(실측: 8개 어댑터 전부).
 *
 * ★검사의 초점은 **모양을 데이터가 정하는가**다. openrouter 420개는 벤더 색인이라야 읽히고
 *  (58종), anthropic 11개는 모델을 바로 보는 게 맞다. provider 이름으로 가르면 새 provider
 *  가 틀린 모양을 얻는다([[feedback_hand_maintained_lists]] · 원칙 2).
 *
 * 등급: **동작**(순수 함수를 픽스처로 실행). 캐시를 인자로 받게 뽑았기에 가능하다 —
 * 안 뽑았으면 홈에 카탈로그가 없는 환경에서 «0개» 로 공짜 초록이 났을 것이다.
 */
import { catalogViews } from "../../core/plugins/providers.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const many = (n: number, pre: string): string[] =>
  Array.from({ length: n }, (_, i) => `${pre}-${String(i)}`);

const CAPS = (spec: string): { context?: number; tools?: boolean } | undefined =>
  spec === "anthropic:claude-opus-5"
    ? { context: 200_000, tools: true }
    : spec === "anthropic:legacy"
      ? { tools: false }
      : undefined;

/** `data` 를 표로 읽는다 — 렌더러가 기대하는 모양(`columns`/`rows`)이 맞는지 같이 본다. */
const table = (v: { data: unknown } | undefined): { columns: string[]; rows: Record<string, unknown>[] } | null => {
  const d = v?.data as { columns?: unknown; rows?: unknown } | undefined;
  return Array.isArray(d?.columns) && Array.isArray(d.rows)
    ? { columns: d.columns as string[], rows: d.rows as Record<string, unknown>[] }
    : null;
};

export const check: RegressionCheck = {
  name: "module-detail-shows-catalog",
  guards:
    "모듈 상세(대시보드)의 LLM 어댑터 카드가 요약과 같은 값만 담고 있어 파고들 게 없던 것 — 카탈로그가 받아둔 모델 목록이 화면에 도달하는 경로가 0이었다(사용자 지적 2026-09-02)",
  run: async (): Promise<Assertion[]> => {
    const ns = catalogViews(
      "openrouter",
      [...many(200, "openai/gpt"), ...many(150, "qwen/q"), ...many(69, "google/g"), "anthropic/c"],
      CAPS,
    );
    const plain = catalogViews("anthropic", ["claude-opus-5", "legacy", "unknown-one"], CAPS);
    const mixed = catalogViews("mix", [...many(9, "a/m"), ...many(9, "b/m"), "plain"], CAPS);
    const none = catalogViews("together", [], CAPS);
    const nsT = table(ns[0]);
    const plainT = table(plain[0]);

    return [
      assert(
        "★★네임스페이스가 있으면 **벤더 색인**이다 — 420행 표는 20행에서 잘려 아무것도 아니게 된다",
        nsT !== null && nsT.columns.join(",") === "vendor,models" && nsT.rows.length === 4,
        nsT === null ? "★표가 아님" : `${nsT.columns.join(",")} · ${String(nsT.rows.length)}행`,
      ),
      assert(
        "★★색인이 **많은 순**이다 — 렌더러가 20행에서 자르므로 잘리는 쪽이 덜 중요해야 한다",
        nsT?.rows[0]?.vendor === "openai" && nsT?.rows[1]?.vendor === "qwen",
        nsT === null ? "★없음" : nsT.rows.map((r) => String(r.vendor)).join(" > "),
      ),
      assert(
        "★네임스페이스가 없으면 **모델을 바로** 보여준다(그게 그 데이터에 맞는 모양이다)",
        plainT !== null && plainT.columns.join(",") === "model,context,tools" && plainT.rows.length === 3,
        plainT === null ? "★표가 아님" : `${plainT.columns.join(",")} · ${String(plainT.rows.length)}행`,
      ),
      assert(
        "★★능력은 **아는 것만** 싣는다 — 모르는 칸을 채우면 화면이 «도구 안 됨» 이라고 거짓말한다",
        plainT?.rows[0]?.tools === "✅" &&
          plainT?.rows[1]?.tools === "✖" &&
          plainT?.rows[2]?.tools === "" &&
          plainT?.rows[2]?.context === "",
        plainT === null
          ? "★없음"
          : plainT.rows.map((r) => `${String(r.model)}:tools=${JSON.stringify(r.tools)}`).join(" · "),
      ),
      assert(
        "★★네임스페이스가 **섞이면** 묶지 않는다 — 묶으면 `/` 없는 모델이 표에서 사라진다",
        table(mixed[0])?.columns.join(",") === "model,context,tools" &&
          table(mixed[0])?.rows.length === 19,
        `${table(mixed[0])?.columns.join(",") ?? "★없음"} · ${String(table(mixed[0])?.rows.length ?? 0)}행(19여야)`,
      ),
      assert(
        "★카탈로그가 없으면 **빈 표를 만들지 않는다** — 빈 카드는 «없다» 가 아니라 «망가졌다» 로 읽힌다",
        none.length === 0,
        `뷰 ${String(none.length)}개(0이어야)`,
      ),
      assert(
        "★뷰 id·order 가 요약 카드와 안 겹친다(같은 자리에 둘이 겹쳐 그려지지 않게)",
        ns[0]?.id === "llm-adapter.openrouter.vendors" &&
          plain[0]?.id === "llm-adapter.anthropic.models" &&
          ns[0]?.order === 41,
        `${String(ns[0]?.id)} · order=${String(ns[0]?.order)}`,
      ),
    ];
  },
};
