/**
 * 회귀: **가이드가 시키는 대로 하면 진짜 된다** (2026-08-30).
 *
 * ★기존 검사들이 못 보던 자리다:
 *  - `plugin-guide-is-true` 는 가이드의 **이름**이 코드와 맞는지만 본다(오타 방지).
 *  - `plugin-install-without-restart` 는 홈에 플러그인을 만들어 설치까지 하는데,
 *    그 픽스처는 `startService` + `getMcpServer` 로 **가이드 §1 과 다른 모양**이다.
 *
 *  즉 *"문서를 따라 하면 위젯이 뜬다"* 는 **한 번도 실행된 적이 없었다.** 서드파티가 처음
 *  겪는 것이 정확히 그 길인데.
 *
 * ★**문서 자체를 픽스처로 쓴다.** §1 의 코드 블록 셋(`package.json`·`index.js`·
 *  `web/widget.js`)을 마크다운에서 **뽑아서** 임시 홈에 쓰고 로드한다. 사본을 만들면
 *  그게 곧 두 벌이고, 문서만 고치면 조용히 갈린다([[feedback_simple_composable_no_duplication]]).
 *  이렇게 하면 **문서를 고치는 순간 이 검사가 그 문서를 실행한다.**
 *
 * 지키는 것 넷:
 *  ① 블록 셋이 문서에 **여전히 있다**(구조가 바뀌면 여기서 먼저 운다)
 *  ② `package.json` 이 우리 매니페스트로 **읽힌다**(schemaVersion·kind·entry·needs)
 *  ③ 홈에 그대로 놓으면 로더가 **집어 든다**(문법 오류·잘못된 기본 내보내기면 여기서 죽는다)
 *  ④ 선언한 데이터 라우트가 **실제로 값을 낸다**(가이드가 약속한 결과)
 *
 * 등급: **실행** — 문서에서 뽑은 코드를 파일로 쓰고 로더에 태운다.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 가이드 §1 의 코드 블록 — 순서대로 package.json · index.js · web/widget.js. */
const recipeBlocks = (): Array<{ lang: string; body: string }> => {
  const md = readFileSync(path.join(REPO, "docs/plugins.md"), "utf8");
  const from = md.indexOf("## 1. 30초 판");
  const to = md.indexOf("## 2.", from);
  if (from < 0 || to < 0) return [];
  return [...md.slice(from, to).matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((m) => ({
    lang: m[1]!,
    body: m[2]!,
  }));
};

export const check: RegressionCheck = {
  name: "plugin-guide-recipe-runs",
  guards:
    "가이드 §1 이 시키는 대로 만든 플러그인이 실제로 로드되는지 아무도 안 보던 것 — `plugin-guide-is-true` 는 **이름**만 대조하고, `plugin-install-without-restart` 의 픽스처는 `startService`+`getMcpServer` 라 **문서와 다른 모양**이다. 서드파티가 처음 겪는 길이 정확히 이 레시피인데 한 번도 실행된 적이 없었다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const blocks = recipeBlocks();
    out.push(
      assert(
        "★가이드 §1 에서 코드 블록 셋(매니페스트·엔트리·위젯)을 뽑을 수 있다 — 못 뽑으면 문서 구조가 바뀐 것이고, 아래 판정이 조용히 사라진다",
        blocks.length === 3 && blocks[0]?.lang === "json",
        blocks.map((b) => b.lang).join(", ") || "★블록 0",
      ),
    );
    if (blocks.length !== 3) return out;

    const home = mkdtempSync(path.join(tmpdir(), "guide-recipe-"));
    try {
      const dir = path.join(home, "plugins", "hello");
      mkdirSync(path.join(dir, "web"), { recursive: true });
      writeFileSync(path.join(dir, "package.json"), blocks[0]!.body);
      writeFileSync(path.join(dir, "index.js"), blocks[1]!.body);
      writeFileSync(path.join(dir, "web", "widget.js"), blocks[2]!.body);

      // ② 매니페스트로 읽히는가 — 우리 로더가 보는 필드로.
      const pkg = JSON.parse(blocks[0]!.body) as {
        type?: string;
        tiguclaw?: { schemaVersion?: number; kind?: unknown; name?: string; entry?: string };
      };
      const m = pkg.tiguclaw;
      out.push(
        assert(
          "★가이드의 `package.json` 이 **우리 매니페스트로 읽힌다**(schemaVersion·kind·name·entry) — 하나만 틀려도 독자는 아무 말 없이 안 되는 걸 겪는다",
          m?.schemaVersion === 1 &&
            m.name === "hello" &&
            typeof m.entry === "string" &&
            pkg.type === "module",
          JSON.stringify(m ?? {}),
        ),
      );

      // ③ 로더가 집어 드는가 — 진짜 로드다(문법 오류·잘못된 기본 내보내기면 여기서 죽는다).
      const { loadPlugins } = await import("../../core/plugins/loader.js");
      const { getEventBus } = await import("../../core/eventbus.js");
      const loaded = await loadPlugins(path.join(home, "plugins"), getEventBus());
      const hello = loaded.find((p) => p.manifest.name === "hello");
      out.push(
        assert(
          "★★가이드대로 만든 폴더를 홈에 두면 **로더가 집어 든다** — 이게 안 되면 문서 첫 절이 거짓이고, 독자는 첫 30초에 막힌다",
          hello !== undefined,
          hello === undefined
            ? `★못 읽음 · 읽힌 것=[${loaded.map((p) => p.manifest.name).join(", ")}]`
            : `capabilities=[${hello.capabilities.join(", ")}]`,
        ),
      );
      if (hello === undefined) return out;

      // ④ 약속한 결과 — 선언한 데이터 라우트가 실제로 값을 낸다.
      const inst = hello.instance as {
        getDataRoutes?: () => Record<string, { handler: (q: Record<string, string>) => Promise<unknown> }>;
      };
      const routes = inst.getDataRoutes?.() ?? {};
      const got = await routes.greeting?.handler({ who: "정태" });
      out.push(
        assert(
          "★★선언한 데이터 라우트가 **실제로 값을 낸다** — 가이드가 약속한 결과다(선언만 읽히고 안 불리면 독자는 '왜 빈 칸이지' 를 겪는다)",
          typeof (got as { text?: string } | undefined)?.text === "string" &&
            (got as { text: string }).text.includes("정태"),
          JSON.stringify(got ?? null),
        ),
      );
      out.push(
        assert(
          "★위젯 파일이 **등록 함수를 부른다**(`window.tiguWidgets.register`) — 이름이 갈리면 화면에 아무것도 안 뜨고 오류도 없다",
          blocks[2]!.body.includes("window.tiguWidgets.register("),
          blocks[2]!.body.split("\n")[0] ?? "",
        ),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    return out;
  },
};
