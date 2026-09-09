/**
 * 회귀: **제품 정체성이 자리마다 다른 명사로 시작하지 않는다** (2026-09-09, 외부 검토).
 *
 * 지적: 처음 온 사람이 보는 두 자리가 서로 다른 것을 말하고 있었다 —
 *   `package.json`  → "Always-on multi-channel **AI assistant** …"
 *   GitHub 설명      → "Always-on, self-hosted **AI agent runtime** …"
 * 둘 다 틀린 말은 아니지만, 방문자는 이게 «개인 비서» 인지 «에이전트 런타임» 인지
 * «Claude Code 상위 호환 도구» 인지 «Agent OS» 인지 가릴 수가 없다. 이름이 넷이면
 * 포지셔닝은 0개다.
 *
 * ★위계를 하나로 정했다: **정체성=assistant · 하는 일=목표를 맡긴다 · 기술 분류=runtime.**
 *  사람에게는 비서, 기술 문맥에서는 런타임 — 둘 다 살리되 **순서**를 고정한다.
 * ★그래서 여기서 세는 것은 낱말 사전이 아니라 **«같은 명사로 시작하나»** 다. 문구는
 *  바뀔 수 있고 바뀌어야 한다(마케팅은 굳는 게 아니다). 갈리는 것만 막는다.
 * ★GitHub 저장소 설명은 레포 밖(플랫폼 설정)이라 여기서 못 센다 — 그건 사람이 맞춘다.
 *  대신 레포 안 두 자리를 묶어두면, 하나를 고칠 때 나머지를 보게 된다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
/**
 * 공개 README — **두 트리에서 자리가 다르다.**
 *
 * ★dev 레포에선 `_workspace/public-overlay/README.md`(오버레이 원본)이고, 배포 트리에선
 *  그게 `README.md` 로 깔려 있다. `_workspace/` 는 sync manifest EXCLUDE 라 배포본엔
 *  아예 없다 — 처음 판이 그 경로를 박아서 **배포 트리 스위트가 통째로 던졌다**(sync
 *  §5 가 push 전에 잡았다). 자리를 손으로 적지 말고 «있는 쪽» 을 쓴다.
 */
const readPublicReadme = (): string => {
  try {
    return read("_workspace/public-overlay/README.md");
  } catch {
    return read("README.md");
  }
};

/** 정체성 명사 — 이 순서로 처음 나오는 것이 그 문장의 «무엇인가» 다. */
const NOUNS = ["ai assistant", "agent runtime", "agent os", "orchestrator"] as const;
const leadNoun = (text: string): string => {
  const t = text.toLowerCase();
  let best = "", at = Infinity;
  for (const n of NOUNS) {
    const i = t.indexOf(n);
    if (i >= 0 && i < at) { at = i; best = n; }
  }
  return best;
};

export const check: RegressionCheck = {
  name: "product-identity-is-one-noun",
  guards:
    "처음 온 사람이 보는 자리마다 제품 정체성이 다른 명사로 시작하던 것 — package.json 은 " +
    "«AI assistant», GitHub 설명은 «AI agent runtime» 이라 방문자가 무엇인지 가릴 수 없었다",
  async run(): Promise<Assertion[]> {
    const pkg = JSON.parse(read("package.json")) as { description?: string };
    const desc = pkg.description ?? "";
    const readme = readPublicReadme().slice(0, 1500);
    const out: Assertion[] = [];

    out.push(
      assert(
        "★★`package.json` 과 공개 README 가 **같은 정체성 명사**로 시작한다 — 두 자리가 갈리면 방문자는 «비서» 인지 «런타임» 인지 «Agent OS» 인지 가릴 수 없고, 이름이 넷이면 포지셔닝은 0개다",
        leadNoun(desc) !== "" && leadNoun(desc) === leadNoun(readme),
        JSON.stringify({ "package.json": leadNoun(desc) || "★없음", README: leadNoun(readme) || "★없음" }),
      ),
    );
    out.push(
      assert(
        "★정체성이 **assistant** 다 — 기술 분류(runtime)는 뒤에 온다. 사람에게는 비서, 기술 문맥에서는 런타임이라는 위계",
        leadNoun(desc) === "ai assistant",
        `앞선 명사: ${leadNoun(desc) || "★없음"}`,
      ),
    );
    return out;
  },
};
