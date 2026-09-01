/**
 * 회귀: **`spawn_agent` 는 «누구를」과 «무엇을」을 따로 받는다** (2026-09-01 사용자 신고).
 *
 * ★사고: 비서가 `spawn_agent` 를 **이름 자리에 작업 제목을 넣어** 호출했고 «미발견» 을
 *  받은 뒤 `deep` 으로 다시 불렀다. 턴 하나가 그냥 날아갔다.
 *
 * ★원인은 모델이 아니라 **스키마가 그렇게 유도한 것**이다. 둘이 겹쳤다:
 *  ① `name` 에 «목록에 있는 이름이어야 한다» 는 설명이 **없었다**(빈 `z.string()`).
 *  ② 작업 제목을 넣을 자리가 **아예 없었다** — 매니저(`run_in_background`)엔 `label` 이
 *    있는데 서브에이전트엔 없어서, 설명을 쓰고 싶은 모델에게 남는 문자열 칸은 `name` 뿐이었다.
 *
 * ★그리고 라벨이 없으면 잡 카드가 전부 `deep`·`general` 로만 보인다 — `deep` 셋을 동시에
 *  띄우면 어느 게 무엇인지 구분이 안 된다(그게 이 인자를 만든 실제 이유다).
 *
 * 등급: **동작**(스키마·기본값을 실행으로 확인) + **판정**(설명 존재).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "spawn-agent-label",
  guards:
    "spawn_agent 가 «누구를」만 받고 «무엇을」을 못 받아, 비서가 이름 자리에 작업 제목을 넣어 호출하고 «미발견» 으로 턴을 하나 버리던 것 + 잡 카드가 전부 에이전트 이름만이라 동시에 띄운 것들을 구분 못 하던 것(사용자 신고 2026-09-01)",
  run: async (): Promise<Assertion[]> => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const src = await readFile(
      path.join(REPO, "src/core/llm-runtime/capabilities/agent-registry.ts"),
      "utf8",
    );
    const dash = await readFile(
      path.join(REPO, "packages/dashboard/js/background-drawer.js"),
      "utf8",
    );

    // `spawn_agent` 스키마 블록만 본다(다른 도구의 필드와 섞이지 않게).
    const at = src.indexOf('tool(\n    "spawn_agent"');
    const block = at < 0 ? "" : src.slice(at, at + 6000);

    return [
      assert(
        "★spawn_agent 스키마를 찾았다(0이면 아래는 미검사다)",
        block !== "",
        block === "" ? "★못 찾음" : `${block.length}자`,
      ),
      assert(
        "★★`label` 인자가 있다 — 없으면 모델이 제목을 넣을 곳이 `name` 뿐이라 그 자리에 넣는다(실제로 그랬다)",
        /\blabel:\s*z\s*\n?\s*\.string\(\)/.test(block),
        /\blabel:\s*z/.test(block) ? "있음" : "★없음",
      ),
      assert(
        "★★`name` 에 **설명**이 붙어 있다 — «목록에 있는 이름» 이라고 말해주지 않으면 모델이 제목을 넣는다",
        /name:\s*z[\s\S]{0,120}?\.describe\(/.test(block),
        /name:\s*z[\s\S]{0,120}?\.describe\(/.test(block) ? "설명 있음" : "★설명 없음",
      ),
      assert(
        "★`label` 미지정이면 **종전대로** 에이전트 이름이 라벨이다(회귀 0)",
        /label:\s*args\.label[\s\S]{0,140}?:\s*args\.name/.test(src),
        /label:\s*args\.label/.test(src) ? "폴백 있음" : "★폴백 없음 — 미지정 시 라벨이 빈다",
      ),
      assert(
        "★★잡 카드가 **에이전트 이름과 제목을 같이** 보여준다 — 라벨을 통째로 «🤖 이름» 으로 덮으면 제목을 줘도 화면에 안 보인다(그게 이 인자를 만든 이유다)",
        /opts\.label[\s\S]{0,200}?"🤖 "\s*\+\s*nm\s*\+\s*" · "\s*\+\s*title/.test(dash),
        /" · "/.test(dash) ? "둘 다 표시" : "★이름만 표시 — 제목이 화면에 안 온다",
      ),
    ];
  },
};
