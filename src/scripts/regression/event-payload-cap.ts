/**
 * 회귀: **긴 답변 본문이 이벤트 절단에 안 잘린다** — ★행동 게이트 (2026-08-08).
 *
 * 사용자 신고: 대시보드에서 긴 답변이 중간에 끊겨 보였고 새로고침해도 같았다. 원인은
 * `event-persist` 의 페이로드 비대 가드였다 — payload JSON 이 상한을 넘으면 **모든 문자열을
 * 300자로** 자르는데, 그 300 은 *조회 키*(threadKey·label)를 살리려던 값이지 **본문**을 위한
 * 값이 아니었다. 12,650자 답변의 텍스트 세그먼트가 거기 걸려 300자로 잘렸고,
 * `chat_log` 엔 전문이 무손실로 있는데 **화면은 잘린 사본**을 그렸다.
 *
 * ★더 나쁜 건 **잘렸다는 표시가 없었다**는 것이다. 도구 출력은 잘려도 "생략됨" 으로 보이는데
 *  답변 본문은 잘린 채 **정상 완료처럼** 보였다 — 오늘 하루에만 같은 모양(끊긴 걸 성공처럼
 *  렌더)을 두 번 겪었다.
 *
 * ★왜 이제야: 답변 2,025건 중 상한을 넘긴 게 그 한 건이다(2위 9,788자). 상한 **바로 아래**에서
 *  오래 살았을 뿐 새 결함이 아니다 — 그래서 "오늘 바꾼 것 때문" 이라는 첫 가설이 틀렸다.
 *
 * 이 검사는 **실제 절단 함수를 호출**한다. 값(64,000)을 문자열로 확인하는 게 아니라, 현실적인
 * 길이의 답변이 **온전히 살아남는지**를 본다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "event-payload-cap",
  guards:
    "이벤트 페이로드 절단이 답변 본문을 삼키지 않는다 — 잘린 사본이 화면에 정상처럼 뜨던 것",
  run: async (): Promise<Assertion[]> => {
    // ★**실제 상수**를 쓴다. 처음엔 `64_000` 을 인자로 직접 넘겼는데, 그러면 상수를
    //  10,000 으로 되돌려도 검사가 통과한다(변이로 확인 — 가짜 초록). 순수 함수를 내 입력으로
    //  부르는 것과 **배선을 확인하는 것**은 다르다. 레드팀이 짚은 그 부류를 그대로 밟았다.
    const { truncatePayloadJson, MAX_PAYLOAD_CHARS } = await import(
      "../../core/event-persist.js"
    );

    // 실측 사고 크기(12,650자)보다 넉넉히. ★상수를 **직접 참조**하지 않고 고정 길이를
    //  쓰는 이유: "상한이 이 정도는 돼야 한다" 가 지켜야 할 성질이다(상한을 따라 늘어나면
    //  상한을 낮춰도 통과한다).
    const body = "가".repeat(20_000);
    const payload = { channel: "http-bridge", threadKey: "dashboard:default", kind: "text", text: body };
    const out = JSON.parse(truncatePayloadJson(payload, MAX_PAYLOAD_CHARS)) as Record<string, unknown>;

    // 폭주 방어는 살아 있어야 한다 — 상한을 넘기면 여전히 잘린다.
    const huge = { text: "나".repeat(200_000), threadKey: "t" };
    const cut = JSON.parse(truncatePayloadJson(huge, MAX_PAYLOAD_CHARS)) as Record<string, unknown>;

    return [
      assert(
        "★2만 자 답변이 **온전히** 살아남는다(잘린 사본이 화면에 뜨지 않게)",
        out.text === body && out._truncated === undefined,
        `${String(out.text ?? "").length}자 · truncated=${String(out._truncated)}`,
      ),
      assert(
        "조회 키는 그대로다(threadKey·kind)",
        out.threadKey === "dashboard:default" && out.kind === "text",
        `${String(out.threadKey)} / ${String(out.kind)}`,
      ),
      assert(
        "★폭주 페이로드는 **여전히 막는다**(상한을 없앤 게 아니라 올린 것)",
        cut._truncated === true && String(cut.text ?? "").length < 1000,
        `truncated=${String(cut._truncated)} · ${String(cut.text ?? "").length}자`,
      ),
      assert(
        "절단본도 **유효 JSON** 이다(깨진 JSON 이 소비처를 터뜨리던 2026-07-09 사고)",
        typeof cut === "object" && cut !== null,
        "파싱 성공",
      ),
    ];
  },
};
