/**
 * 회귀: **첨부 이미지 안내가 양 어댑터에서 참이어야 한다** (2026-07-31).
 *
 * 사고: 2026-07-28 커밋 `421d067` 이 이 문장을 뒤집었다 —
 *   "…`Read` 는 **텍스트 파일만** 읽습니다(이미지는 첨부로 전달된 것만 볼 수 있습니다)"
 * 근거는 codex/openai 의 file-ops Read(`fs.readFile(abs,"utf8")`)였고 그건 사실이다.
 * 그런데 **claude 는 그 Read 를 안 쓴다** — SDK 내장 Read 가 이미지를 vision 으로 반환하고,
 * claude 어댑터엔 inline 이미지 주입 경로가 아예 없어(`input_image` 는 codex/openai 만)
 * **Read 가 유일한 통로**다. 그래서 claude 가 사진을 못 보게 됐다.
 *
 * 실 SDK A/B(검토자 8회 + 교정 후 4회):
 *   뒤집은 문구  Read 1/4 · 오답/환각 3건("초록 배경 위 빨간 하트" ← 실제는 노란 배경 위 파란 삼각형)
 *   이전 문구    Read 4/4 · 정답 4/4
 *   교정 문구    Read 4/4 · 정답 4/4
 *
 * ★교훈: 두 문구 **어느 쪽도 양 어댑터에 참이 아니었다**(codex 는 inline 으로 보고 Read 는
 *  텍스트 전용 / claude 는 inline 이 없고 Read 가 vision). 사실을 단언하는 대신 **행동을
 *  지시**해서 양쪽에서 옳게 동작하게 한다 — "열어보고, 그림이 아니면 정직 보고".
 *  어댑터 분기 0(LLM-agnostic)을 유지하면서.
 *
 * ★2026-08-01 — 이 검사는 그 사고의 **절반만** 지키고 있었다. 문구만 보고 **배달은 안 봤다**:
 *  첨부 블록을 프롬프트에서 통째로 빼거나 라우터에서 첨부를 드롭해도 스위트가 초록이었다
 *  (검토 실측). 사용자에게 보이는 증상은 문구 사고와 **똑같다** — 모델이 사진을 못 본다.
 *  문구가 옳아도 **경로가 안 가면** 열 대상을 모른다. 두 어댑터의 배달 경로를 함께 본다.
 *  배달 형상은 어댑터마다 달라도(claude=경로 텍스트+네이티브 Read / codex=텍스트+input_image)
 *  불변식은 하나다 — **첨부가 있으면 모델이 그 사실과 경로를 알게 된다.**
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "attachment-image-guidance",
  guards:
    "첨부 이미지 안내가 'Read 는 텍스트만' 으로 단언돼 claude 가 사진을 못 보고 환각으로 답하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { formatAttachments } = await import("../../core/prompt-assembly.js");
    const text = formatAttachments([
      { kind: "image", path: "/tmp/x.png", mimeType: "image/png" },
    ] as never);

    // ★단언형 금지 — 한쪽 어댑터에서 반드시 거짓이 된다.
    const falseClaims = [
      "텍스트 파일만",
      "첨부로 전달된 것만",
    ].filter((c) => text.includes(c));
    out.push(
      assert(
        "★`Read` 능력을 단언하지 않는다(어댑터마다 다르므로 어느 단언이든 한쪽에서 거짓)",
        falseClaims.length === 0,
        falseClaims.length === 0 ? "단언 없음" : `단언 발견: ${falseClaims.join(", ")}`,
      ),
    );

    // 행동 지시 3요소: ①안 보이면 Read 를 **먼저** 열어본다 ②그래도 아니면 정직 보고
    // ③추측 금지(환각이 거절보다 나쁘다 — 실측에서 환각이 나왔다).
    const needed: Array<[string, string]> = [
      ["Read` 로 열어보세요", "안 보이면 Read 를 시도하라"],
      ["보이지 않는다고 말하고", "그래도 아니면 정직 보고"],
      ["지어내지", "추측 금지(환각 차단)"],
    ];
    const missing = needed.filter(([frag]) => !text.includes(frag)).map(([, why]) => why);
    out.push(
      assert(
        "★행동 지시 3요소가 다 있다(시도 → 정직 보고 → 추측 금지)",
        missing.length === 0,
        missing.length === 0 ? "3요소 확인" : `누락: ${missing.join(" / ")}`,
      ),
    );

    // ── 배달(2026-08-01 신설): 경로가 실제로 모델에게 간다 ────────────────
    //  ★종전에 비어 있던 절반. 문구가 아무리 옳아도 경로가 안 가면 모델은 열 파일을 모른다.
    const IMG_PATH = "/tmp/x.png";
    out.push(
      assert(
        "★첨부 블록에 **실제 경로**가 실린다(모델이 열 대상을 안다)",
        text.includes(IMG_PATH),
        text.includes(IMG_PATH) ? "경로 포함" : "★경로 없음 — 모델이 열 수 없다",
      ),
    );
    // claude 배달 — 사용자 턴 조립에서 첨부 블록이 살아남는가(드롭되면 여기서 잡힌다).
    const { assembleUserPrompt } = await import("../../core/prompt-assembly.js");
    const claudePrompt = assembleUserPrompt(["시스템 컨텍스트"], [text, "이 사진 좀 봐줘"]);
    out.push(
      assert(
        "★claude: 조립된 사용자 턴에 첨부 경로가 남는다(드롭 0)",
        claudePrompt.includes(IMG_PATH) && claudePrompt.includes("이 사진 좀 봐줘"),
        claudePrompt.includes(IMG_PATH) ? "경로+본문 동시 전달" : "★첨부가 조립에서 사라졌다",
      ),
    );
    // codex 배달 — 같은 텍스트 블록 **더하기** 네이티브 비전 아이템.
    //  ★실파일이 필요하다(인코더가 읽는다). 없으면 조용히 빈 배열이 돼 **검사가 스스로
    //   초록/빨강을 오판한다** — 픽스처를 진짜로 만든다.
    const { buildMediaContentItems } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth-history.js"
    );
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const tmp = await mkdtemp(pathMod.join(os.tmpdir(), "tiguclaw-att-"));
    const realPng = pathMod.join(tmp, "x.png");
    // 최소 유효 PNG(1x1).
    await writeFile(
      realPng,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    let media: Array<{ type?: string }> = [];
    try {
      media = await buildMediaContentItems([
        { kind: "image", path: realPng, mimeType: "image/png", filename: "x.png", bytes: 70 },
      ] as never);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
    out.push(
      assert(
        "★codex: 이미지가 네이티브 비전 아이템으로도 실린다",
        media.length === 1 && media[0]?.type === "input_image",
        media.length === 0
          ? "★비전 아이템 0 — 이미지가 텍스트로만 간다"
          : `${media.length}개 · ${String(media[0]?.type)}`,
      ),
    );

    // 이미지가 없으면 이 안내 자체가 붙지 않는다(텍스트 전용 턴 회귀 0).
    const noImage = formatAttachments([
      { kind: "file", path: "/tmp/a.txt", mimeType: "text/plain" },
    ] as never);
    out.push(
      assert(
        "이미지 없는 첨부엔 이미지 안내가 안 붙는다",
        !noImage.includes("Read` 로 열어보세요"),
        noImage.length > 120 ? `${noImage.slice(0, 120)}…` : noImage,
      ),
    );
    return out;
  },
};
