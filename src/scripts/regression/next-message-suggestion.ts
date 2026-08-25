/**
 * 회귀: 다음 메시지 제안 — **꺼져 있고, 안 새고, 비용이 상수로 묶여 있다.**
 *
 * 배경 (2026-08-10): 턴이 끝나면 "사용자가 이어서 할 만한 말" 한 줄을 만들어 대시보드
 *  입력창에 회색 고스트로 띄운다. Tab 이면 입력창에 채워진다(전송 아님).
 *
 * ★이 기능은 **매 턴 토큰을 쓴다.** 그래서 위험은 "안 뜬다" 가 아니라 **조용히 켜져 있고
 *  조용히 커지는 것**이다. 이 검사는 그 셋을 지킨다:
 *   ① 기본 꺼짐(설정 부재·형식오류 = 꺼짐)
 *   ② 사람이 안 보는 턴(스케줄러·워커·엔드포인트·게이트웨이)엔 아예 안 만든다
 *   ③ 프롬프트 크기가 **상수 둘로 결정**된다 — 대화가 길어져도 안 커진다
 *  거기에 출력 정리(고스트는 한 줄)를 더한다.
 */
import {
  readSuggestionSettings,
  shouldSuggestForThread,
  normalizeSuggestion,
  SUGGESTION_MAX_CHARS,
} from "../../core/next-message-suggestion.js";
import { readFile } from "node:fs/promises";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  // ── ① 기본 꺼짐 ────────────────────────────────────────────────────────────
  //  토큰을 쓰는 기능은 명시적으로만 켜진다. 설정이 없는 임시 홈에서 켜져 있으면
  //  "기본값이 뒤집힌 것" 이고, 그건 조용히 과금된다.
  {
    const s = readSuggestionSettings();
    out.push({
      name: "★설정 부재 = 꺼짐(토큰 쓰는 기능의 안전 기본값)",
      ok: s.enabled === false,
      got: `enabled=${String(s.enabled)} (기대 false)`,
    });
  }

  // ── ② 사람이 안 보는 턴엔 안 만든다 ────────────────────────────────────────
  //  고스트는 대시보드 입력창에만 뜬다. 파생 턴에도 만들면 **아무도 안 보는 제안에**
  //  매번 토큰을 쓴다.
  {
    const skip = ["scheduler:3", "worker:abc", "endpoint:x:y", "agent:sub", "gateway:z"];
    const keep = ["dashboard:default", "dashboard:1784-abc", "tg:12345"];
    out.push({
      name: "★파생 턴(스케줄러·워커·엔드포인트·에이전트·게이트웨이)엔 안 만든다",
      ok: skip.every((t) => !shouldSuggestForThread(t)),
      got: skip.map((t) => `${t}=${String(shouldSuggestForThread(t))}`).join(" "),
    });
    out.push({
      name: "사람이 보는 세션엔 만든다",
      ok: keep.every((t) => shouldSuggestForThread(t)),
      got: keep.map((t) => `${t}=${String(shouldSuggestForThread(t))}`).join(" "),
    });
    out.push({
      name: "빈 threadKey 는 안 만든다",
      ok: !shouldSuggestForThread(""),
      got: `""=${String(shouldSuggestForThread(""))} (기대 false)`,
    });

    // ★2026-08-25 — 합성 턴 검사는 **뺐다.** 사용자 지정이 바뀌었다:
    //  *"메인턴이 응답을 보낼 때마다"* — 워커 완료 정리 턴도 메인 턴이다. 그리고 제안은
    //  이제 메인 턴 안에서 같이 나오므로(별도 호출 없음) 걸러야 할 추가 호출 자체가 없다.
    //  남은 판정은 **보여줄 자리인가** 하나뿐이고, 그건 위 접두사 검사가 본다.
  }

  // ── ④⑤ **구조가 대신 지킨다** (2026-08-25 인라인 전환) ────────────────────
  //  ④ 였던 것: 조립이 비서 발화의 앞 600자만 남겨 마지막 물음이 잘려나갔고(2026-08-10
  //   실사고: "② tigu check 갈까요?" → 제안이 "다음은 뭐 하지?"), 그래서 "물으면 답하라"
  //   규칙이 볼 재료가 없었다. **이제 조립 자체가 없다** — 제안을 만드는 주체가 그 물음을
  //   방금 쓴 모델이다. 잘릴 텍스트가 없으니 이 실패 모드가 구조적으로 사라졌다.
  //  ⑤ 였던 것: 생성 규칙이 시스템(안정) 채널에 있는가 → `inline-next-suggestion` 이 본다.
  //  ★검사를 지운 게 아니라 **지킬 대상이 없어진 것**이다. 되살아나면(별도 호출 부활)
  //   `inline-next-suggestion` ⑥이 잡는다.

  // ── ⑥ 출력 정리 — 고스트는 한 줄이다 ───────────────────────────────────────
  {
    const cases: [string, string | null][] = [
      ['"이거 배포해줘"', "이거 배포해줘"],
      ["제안: 다음 단계 알려줘", "다음 단계 알려줘"],
      ["첫 줄이다\n둘째 줄은 버린다", "첫 줄이다"],
      ["   ", null],
      ["", null],
    ];
    const bad = cases.filter(([raw, want]) => normalizeSuggestion(raw) !== want);
    out.push({
      name: "따옴표·머리말·여러 줄을 정리해 한 줄로 만든다",
      ok: bad.length === 0,
      got:
        bad.length === 0
          ? `${cases.length}건 전부 기대대로`
          : bad.map(([r]) => `실패:${JSON.stringify(r)}→${String(normalizeSuggestion(r))}`).join(" "),
    });
    const long = normalizeSuggestion("나".repeat(SUGGESTION_MAX_CHARS + 80)) ?? "";
    out.push({
      name: "긴 제안은 잘린다(고스트가 입력창을 덮지 않게)",
      ok: long.length === SUGGESTION_MAX_CHARS,
      got: `길이=${long.length} (기대 ${SUGGESTION_MAX_CHARS})`,
    });
  }

  // ── ★**늦게 온 제안이 버려지지 않는다** (2026-08-18, 사용자 신고) ─────────────
  //  사고: "가끔 제안이 안 나온다". 서버는 멀쩡했다 — 5일 창에서 대시보드 턴 36건 **전부**
  //  60초 안에 제안이 붙었다(100%). 버린 건 **프런트**였다.
  //
  //  종전엔 `vtIsStaleForAppend` 를 빌려 썼다("중복을 피하려고 채팅·워커가 쓰는 기준을
  //  그대로 쓴다"). 그런데 **그 판정은 다른 질문에 답한다** — *"이 메시지를 리스트 바닥에
  //  붙이면 순서가 깨지는가"*(기준 = 리스트의 최신 ts). 제안은 리스트에 안 붙는다(입력창
  //  위 고스트라 "순서" 가 없다). 그래서 답변 버블이 먼저 리스트에 실리고(= newest) 제안이
  //  그보다 5초 넘게 늦으면 **정상 제안이 버려졌다**.
  //  실측: 턴→제안 간격 중앙 **3.9초**, 최대 11.9초, **10%가 5초 초과** — "가끔" 의 정체.
  //  ★통합은 이름이 같아서가 아니라 **질문이 같을 때** 한다(architecture §Q8).
  //
  //  판정은 프런트에 있어 여기서 실행할 수 없다 → **배선을 고정**한다: 빌려온 순서 판정을
  //  다시 쓰지 않고, 세션별 마지막 제안 ts 와만 비교한다(= 최신성).
  {
    const ghost = await readFile(
      new URL("../../../packages/dashboard/js/ghost-suggest.js", import.meta.url),
      "utf8",
    );
    const code = ghost.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    out.push({
      name: "★제안 수신에 리스트 **순서** 판정을 쓰지 않는다(늦게 온 제안이 버려지던 것)",
      ok: !/vtIsStaleForAppend/.test(code),
      got: /vtIsStaleForAppend/.test(code)
        ? "★순서 판정(vtIsStaleForAppend) 재사용 — 5초 넘게 걸린 제안이 버려진다"
        : "순서 판정 미사용",
    });
    out.push({
      name: "★대신 세션별 **최신성**으로 판정한다(replay 만 막고 늦은 제안은 통과)",
      ok:
        /const prev = tk === null \? null : lsAll\(\)\[tk\];/.test(code) &&
        /ts <= prevTs\) return;/.test(code),
      got:
        /ts <= prevTs\) return;/.test(code)
          ? "세션별 ts 비교 확인"
          : "★최신성 판정 없음 — replay 가드가 통째로 사라졌을 수 있다",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "next-message-suggestion",
  guards:
    "매 턴 토큰을 쓰는 제안 기능이 조용히 켜져 있거나(기본 꺼짐), 아무도 안 보는 파생 턴에도 돌거나, 대화가 길어질수록 프롬프트가 같이 커지는 것",
  run,
};
