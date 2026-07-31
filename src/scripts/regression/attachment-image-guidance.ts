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
