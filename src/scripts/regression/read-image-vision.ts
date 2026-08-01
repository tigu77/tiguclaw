/**
 * 회귀: **이미지를 `Read` 하면 비전으로 간다 — 실패를 성공으로 위장하지 않는다**
 * (2026-08-01, 라이브 사고).
 *
 * 사고: `mode: full` 커스텀 엔드포인트에서 이미지를 `Read` 로 열어 판독시켰는데, 어댑터가
 * codex 로 잡히면 이미지가 **바이너리 그대로 텍스트 토큰**으로 들어갔다. 모델은 "판독할 수
 * 없는 바이너리" 라 답했고, **그 실패가 `status: succeeded` 로 반환**됐다. 호출한 앱은 정상
 * 응답으로 받아 캐시에 저장했고, 오염된 캐시가 이후 실행을 감염시켰다.
 *   실측: 같은 엔드포인트·같은 이미지에서 claude 는 7회 정상 판독, codex 는 입력 토큰이
 *   4~5만으로 폭증하며 전 항목 `판독 불가`. 사흘간 "캐시 오염"·"workspace 초기화" 로
 *   세 번 오진했고 그 사이 무관한 코드가 수정됐다.
 *
 * 뿌리는 둘이었다.
 *  ①`file-ops` Read 가 **무조건 `readFile(utf8)`** — 바이너리 판정이 없었다. 이 도구는
 *   codex/openai 전용이고 claude 는 SDK 네이티브 Read 라 비전으로 처리한다 = **어댑터
 *   비대칭**("모든 기능 LLM 무관" 위반).
 *  ②설령 이미지 블록을 돌려줘도 어댑터가 **text 아닌 블록을 통째로 버렸다**. 게다가
 *   text 가 비면 결과를 통째로 `JSON.stringify` 해서, 이미지가 오면 **base64 를 텍스트로
 *   쏟았다**(입력 토큰 폭증의 정체).
 *
 * ★핵심은 "codex 가 비전을 못 한다" 가 아니다 — 첨부 경로에선 이미 비전으로 처리한다.
 *  `Read` 경로만 그 채널을 안 탔고, **미지원을 성공이라 답한 것**이 훨씬 해로웠다.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

/** 최소 유효 PNG(1x1) — 매직 바이트가 진짜여야 판정이 의미 있다. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export const check: RegressionCheck = {
  name: "read-image-vision",
  guards:
    "codex 에서 이미지 Read 가 바이너리를 텍스트로 주입하고 그 실패를 성공으로 반환하던 것(엔드포인트 OCR 사흘 오진)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { createFileOpsMcpServer } = await import(
      "../../core/llm-runtime/capabilities/file-ops-mcp.js"
    );
    // ★프로덕션 경로 그대로 — codex 는 이 브리지를 통해 file-ops 를 부른다.
    //  브리지가 content 를 어떻게 넘기는지까지 함께 검증된다(직접 호출로는 그게 빠진다).
    const { adaptClaudeMcpServer } = await import(
      "../../core/llm-runtime/adapters/_mcp-bridge.js"
    );
    const dir = await mkdtemp(path.join(tmpdir(), "tiguclaw-readimg-"));
    try {
      const img = path.join(dir, "shot.png");
      const txt = path.join(dir, "note.txt");
      await writeFile(img, PNG_1X1);
      await writeFile(txt, "평범한 텍스트\n둘째 줄\n", "utf8");

      const server = await adaptClaudeMcpServer(createFileOpsMcpServer(dir), "file-ops");
      const callRead = async (p: string): Promise<unknown[]> => {
        const r = await server.callTool("Read", { path: p });
        return Array.isArray(r) ? r : [];
      };

      // ★① 이미지는 **이미지 블록**으로 돌아온다(텍스트로 위장하지 않는다).
      const imgRes = await callRead(img);
      const imgBlock = imgRes.find(
        (c) => c !== null && typeof c === "object" && (c as { type?: string }).type === "image",
      ) as { data?: string; mimeType?: string } | undefined;
      out.push(
        assert(
          "★이미지 Read 는 image 블록으로 답한다(바이너리를 텍스트로 안 준다)",
          imgBlock !== undefined && typeof imgBlock.data === "string",
          imgBlock === undefined
            ? "★image 블록 없음 — 바이너리가 텍스트로 나간다"
            : `mime=${String(imgBlock.mimeType)} base64=${String(imgBlock.data).length}자`,
        ),
      );
      out.push(
        assert(
          "매직 바이트로 판정한다(확장자 아님) — PNG 를 PNG 로 안다",
          imgBlock?.mimeType === "image/png",
          String(imgBlock?.mimeType),
        ),
      );
      // 사람이 읽는 설명도 같이 온다 — 모델이 무슨 일이 일어났는지 알아야 한다.
      const imgText = imgRes
        .filter((c) => (c as { type?: string })?.type === "text")
        .map((c) => String((c as { text?: unknown }).text ?? ""))
        .join("");
      out.push(
        assert(
          "무슨 일이 일어났는지 말한다(조용한 치환 0)",
          imgText.includes("비전 채널"),
          imgText.slice(0, 80),
        ),
      );

      // ★② 대조군 — 텍스트 파일은 종전과 똑같이 본문이 온다(과잉 판정 0).
      const txtRes = await callRead(txt);
      const txtText = txtRes
        .filter((c) => (c as { type?: string })?.type === "text")
        .map((c) => String((c as { text?: unknown }).text ?? ""))
        .join("");
      out.push(
        assert(
          "대조군 — 텍스트 파일은 본문이 그대로 온다",
          txtText.includes("평범한 텍스트") && txtText.includes("둘째 줄"),
          txtText.slice(0, 60).replace(/\n/g, "⏎"),
        ),
      );
      out.push(
        assert(
          "대조군 — 텍스트 파일엔 image 블록이 안 붙는다",
          !txtRes.some((c) => (c as { type?: string })?.type === "image"),
          `블록 ${txtRes.length}개`,
        ),
      );

      // ★③ 어댑터 변환 — image 블록이 input_image 로 옮겨지고, base64 가 **텍스트로
      //  쏟아지지 않는다**(원래 사고의 입력 토큰 폭증이 바로 이것이었다).
      //  어댑터의 변환 규칙과 동형인 순수 변환을 여기서 검증한다(실 API 호출 없이).
      const media: Array<{ type: string; image_url: string }> = [];
      let outputStr = imgRes
        .filter((c) => (c as { type?: string })?.type === "text")
        .map((c) => String((c as { text?: unknown }).text ?? ""))
        .join("");
      for (const c of imgRes) {
        const b = c as { type?: string; data?: unknown; mimeType?: unknown };
        if (b.type !== "image" || typeof b.data !== "string") continue;
        media.push({
          type: "input_image",
          image_url: `data:${String(b.mimeType)};base64,${b.data}`,
        });
      }
      if (outputStr === "") {
        outputStr = media.length > 0 ? "(이미지 첨부됨)" : JSON.stringify(imgRes);
      }
      out.push(
        assert(
          "★이미지가 비전 아이템(input_image)으로 옮겨진다",
          media.length === 1 && media[0].image_url.startsWith("data:image/png;base64,"),
          `${media.length}개 · ${media[0]?.image_url.slice(0, 32) ?? "-"}…`,
        ),
      );
      out.push(
        assert(
          "★도구 출력 문자열에 base64 가 안 실린다(입력 토큰 폭증 0)",
          !outputStr.includes(PNG_1X1.toString("base64").slice(0, 24)),
          `출력 ${outputStr.length}자`,
        ),
      );
      await server.close?.();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return out;
  },
};
