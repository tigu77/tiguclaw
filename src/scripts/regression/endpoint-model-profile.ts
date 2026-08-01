/**
 * 회귀: **커스텀 엔드포인트가 자기 정의로 실행 프로파일을 고른다** (2026-08-01).
 *
 * 배경: 엔드포인트는 에이전트·스킬과 같은 **데이터**(정의 파일)인데, 에이전트는 이미
 * frontmatter `model:` 로 실행 모델을 선언하고 엔드포인트만 못 했다 — 같은 부류의 비대칭
 * (`능력은 데이터` 원칙). 처음엔 "비전 되는 모델 고정" 회피책으로 제기됐지만, 회피 여부와
 * 무관하게 **데이터가 자기 실행 조건을 선언할 수 있어야 한다**는 게 본체다(사용자 지적).
 *
 * ★프로파일 이름만 받는다(`provider:model` 직접 지정 아님, 사용자 결정). 데이터 파일에
 *  벤더 모델명을 박으면 모델이 바뀔 때 **같이 썩는다**. 프로파일은 의도("high")를 선언하므로
 *  풀이 갱신돼도 따라온다. 게이트웨이(`body.model`)는 앱이 매 호출 정하는 자리라 직접 지정도
 *  허용하지만, 정의 파일은 성격이 다르다.
 *
 * ★해석은 `resolveModelChain`(llm-runtime 단일 정본)에 위임한다 — 라우터가 프로파일 규칙을
 *  다시 구현하면 같은 판정이 두 곳이 되고, 오늘 하루 걷어낸 병이 그것이다.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "endpoint-model-profile",
  guards:
    "엔드포인트가 실행 모델을 선언할 수 없어(에이전트는 되는데) 비전 필요한 호출이 어느 어댑터에 잡히느냐에 맡겨지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { discoverEndpoints } = await import("../../core/entry/endpoint-registry.js");
    type Ep = Awaited<ReturnType<typeof discoverEndpoints>>[number];
    const { resolveModelChain } = await import("../../core/llm-runtime/index.js");

    const dir = await mkdtemp(path.join(tmpdir(), "tiguclaw-ep-"));
    try {
      const epDir = path.join(dir, "endpoints");
      await writeFile(
        path.join(dir, "settings.json"),
        JSON.stringify({
          models: {
            profiles: {
              vision: { pool: ["anthropic:claude-opus-5"] },
              cheap: { pool: ["anthropic:claude-haiku-4-5"] },
            },
          },
        }),
        "utf8",
      );
      const mk = async (name: string, fm: string): Promise<void> => {
        await writeFile(path.join(epDir, `${name}.md`), `---\n${fm}\n---\n본문\n`, "utf8");
      };
      const { mkdir } = await import("node:fs/promises");
      await mkdir(epDir, { recursive: true });
      await mk("withmodel", "path: /a\nmode: full\nmodel: vision");
      await mk("nomodel", "path: /b\nmode: full");

      const eps = await discoverEndpoints(dir);
      const withModel = eps.find((e: Ep) => e.name === "withmodel");
      const noModel = eps.find((e: Ep) => e.name === "nomodel");

      out.push(
        assert(
          "★정의의 `model:` 이 엔드포인트에 실린다",
          withModel?.model === "vision",
          `withmodel.model=${String(withModel?.model)}`,
        ),
      );
      out.push(
        assert(
          "미지정이면 빈 문자열(= 기본 풀, 현행 동작)",
          noModel?.model === "",
          `nomodel.model=${JSON.stringify(noModel?.model)}`,
        ),
      );

      // ★프로파일 이름이 **실제 실행 풀**로 풀린다 — 이름만 실어 나르고 끝나면 무의미하다.
      const chain = resolveModelChain("vision", dir);
      out.push(
        assert(
          "★프로파일 이름이 실행 풀로 해석된다(운반만 하고 끝나지 않는다)",
          chain.length > 0 && chain[0].length > 0,
          chain.length === 0
            ? "★해석 결과 0 — 프로파일이 안 먹는다"
            : `${chain.length}단 · 첫 풀 ${chain[0].map((s) => s.model).join(",")}`,
        ),
      );
      // 다른 프로파일은 다른 풀을 준다(같은 값이 나오면 해석이 죽은 것).
      const cheap = resolveModelChain("cheap", dir);
      out.push(
        assert(
          "대조군 — 다른 프로파일은 다른 풀을 준다(해석이 살아 있다)",
          cheap.length > 0 && cheap[0][0]?.model !== chain[0][0]?.model,
          `vision=${chain[0]?.[0]?.model} cheap=${cheap[0]?.[0]?.model}`,
        ),
      );
      // 미인식 이름은 빈 체인 — 조용히 엉뚱한 모델로 가지 않고 기본 풀로 떨어진다.
      out.push(
        assert(
          "미인식 프로파일은 빈 체인(기본 풀로 안전 복귀)",
          resolveModelChain("존재하지-않는-프로파일", dir).length === 0,
          "빈 체인",
        ),
      );

      // ★배선 — http-bridge 가 정의값을 route 로 넘기고, route 가 그걸 체인으로 푸는가.
      //  (실 HTTP 턴은 LLM 을 태우므로, 운반 계약을 소스 순서로 본다.)
      const { sourceOrder } = await import("./_wiring.js");
      const wired = await sourceOrder("../../../plugins/http-bridge/index.ts", [
        /toolPolicy: ep\.mode === "restricted"/,
        /\.\.\.\(ep\.model !== "" \? \{ modelProfile: ep\.model \} : \{\}\)/,
      ]);
      out.push(
        assert(
          "★http-bridge 가 엔드포인트 정의의 프로파일을 route 로 넘긴다",
          wired.ok,
          wired.detail,
        ),
      );
      // ★route 가 그 값을 **해석해서 실행 체인으로 넘기는가**. 위 단언들은
      //  `resolveModelChain` 을 직접 부르므로, route 가 그걸 안 불러도 초록이다
      //  (변이로 확인 — 실제로 그랬다). 실 턴은 LLM 을 태우므로 배선 순서로 본다:
      //  프로파일 → 체인 해석 → runClaude 로 chain 전달, 그리고 **세션 override 가 먼저**.
      const routeWired = await sourceOrder("../../core/router.ts", [
        /const endpointChain =/,
        /resolveModelChain\(opts\.modelProfile/,
        /overridePool\.length > 0/,
        /\{ chain: endpointChain \}/,
      ]);
      out.push(
        assert(
          "★route 가 프로파일을 체인으로 풀어 실행에 넘긴다(운반만 하고 끝나지 않는다)",
          routeWired.ok,
          routeWired.detail,
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return out;
  },
};
