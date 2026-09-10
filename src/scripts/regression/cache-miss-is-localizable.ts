/**
 * 회귀: **캐시가 왜 콜드였는지를 로그만으로 짚을 수 있다** (2026-09-09 정태님:
 * *"로그로도 판별이 가능하게 재야지"*).
 *
 * 사고: codex 캐시 적중률이 실측 6%~95% 로 갈렸는데 로그엔 **바이트 수만** 있었다.
 * 그래서 «지시가 45,692 로 같은데 내용이 다른가» 를 가릴 수 없었고, **같은 분에 같은
 * 크기의 두 요청이 65% 와 8% 로 갈린 것**을 설명하지 못했다. 증상은 있는데 판정 수치가
 * 없는 상태다 — 원격 불가 설치본에선 그게 곧 «못 잡는다» 는 뜻이다
 * ([[feedback_logs_must_stand_alone]]).
 *
 * ★재는 것은 «달라졌나» 가 아니라 **«어디서 달라졌나»** 다. 프리픽스를 앞에서부터 잘라
 *  사다리로 해시하면, 다음 요청과 비교해 **몇 번째 칸부터 갈렸는지**가 나온다 — 그게
 *  캐시가 끊긴 자리다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "cache-miss-is-localizable",
  guards:
    "캐시 적중률이 6~95% 로 갈리는데 로그엔 바이트 수만 있어, 크기가 같은 두 요청이 왜 " +
    "다르게 캐시됐는지 로그만으로는 영영 못 가리던 것",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const { prefixFingerprint, firstDivergentCut, describeFingerprint, FINGERPRINT_CUTS } =
      await import("../../core/llm-runtime/prefix-fingerprint.js");

    // ① 같은 프리픽스는 같은 지문 — 아니면 매번 «갈렸다» 가 되어 신호가 죽는다.
    const base = "가".repeat(50_000);
    out.push(
      assert(
        "★같은 프리픽스는 같은 지문이다 — 매번 갈리면 «갈림» 신호가 배경소음이 된다",
        prefixFingerprint(base).join() === prefixFingerprint(base).join(),
        // ★증거엔 **관측**을 적는다 — «비교했다» 는 기대값을 되풀이한 것이라, 빨간불을
        //  봐도 무엇이 나왔는지 모른다(메타 게이트가 이걸 잡았다).
        `1회=${prefixFingerprint(base).join("/")} · 2회=${prefixFingerprint(base).join("/")}`,
      ),
    );

    // ② **어디서** 갈렸는지 짚는다 — 이게 이 검사의 본체다.
    //    20,000자 지점을 바꾸면 1·2·3칸(1k·4k·16k)은 같고 4칸(64k)부터 갈려야 한다.
    const changed = base.slice(0, 20_000) + "X" + base.slice(20_001);
    const at = firstDivergentCut(prefixFingerprint(base), prefixFingerprint(changed));
    out.push(
      assert(
        "★★프리픽스가 20,000자 지점에서 갈리면 **4칸(16k~64k 사이)** 이라고 짚는다 — «달라졌다» 가 아니라 «어디서» 를 말해야 캐시가 끊긴 자리를 찾는다",
        at === 4,
        `갈린 칸=${at} (자르는 지점: ${FINGERPRINT_CUTS.join(", ")})`,
      ),
    );
    const early = "Z" + base.slice(1);
    out.push(
      assert(
        "★맨 앞이 갈리면 1칸이다 — 지시 첫머리가 바뀌면 뒤가 전부 무효라는 뜻이고, 그게 가장 비싼 갈림이다",
        firstDivergentCut(prefixFingerprint(base), prefixFingerprint(early)) === 1,
        `갈린 칸=${firstDivergentCut(prefixFingerprint(base), prefixFingerprint(early))}`,
      ),
    );

    // ③ «첫 요청» 과 «갈린 데 없음» 이 **구분된다** — 둘 다 0 이면 콜드 원인을 또 못 가린다.
    const first = describeFingerprint(prefixFingerprint(base), undefined);
    const same = describeFingerprint(prefixFingerprint(base), prefixFingerprint(base));
    out.push(
      assert(
        "★★«처음이라 비교 대상이 없다» 와 «프리픽스가 그대로다» 가 로그에서 구분된다 — 둘 다 «0» 으로 적으면 콜드 캐시의 원인을 여전히 못 가린다",
        first.includes("처음") && same.includes("없음") && first !== same,
        JSON.stringify({ first, same }),
      ),
    );

    // ④ 원문을 안 남긴다 — 프롬프트엔 대화가 들어 있고 로그는 오래 산다.
    out.push(
      assert(
        "★지문에 **원문이 안 실린다** — 프롬프트엔 대화 내용이 있고 로그는 오래 산다",
        !prefixFingerprint(base).some((h) => h.includes("가")) &&
          prefixFingerprint(base).every((h) => /^[0-9a-f]{8}$/.test(h)),
        prefixFingerprint(base).join("/"),
      ),
    );

    // ⑤ 어댑터가 실제로 **찍는가** — 함수만 있고 아무도 안 부르면 없는 것과 같다.
    const src = stripComments(
      readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth.ts"),
    );
    // ★**로그 문장 안에 있는지**를 본다 — 변수 존재만 보면 로그에서 빼도 초록이다
    //  (변이로 실측). 계산만 하고 안 찍으면 «로그로 판별한다» 는 목적 자체가 무너진다.
    const inLogStatement = (label: string): boolean => {
      const i = src.indexOf(label);
      if (i < 0) return false;
      const start = src.lastIndexOf("console.log(", i);
      if (start < 0) return false;
      // 그 console.log 호출이 끝나는 자리까지 — 괄호 깊이로 센다.
      let depth = 0;
      for (let k = start + "console.log".length; k < src.length; k += 1) {
        if (src[k] === "(") depth += 1;
        else if (src[k] === ")") {
          depth -= 1;
          if (depth === 0) {
            const body = src.slice(start, k);
            return body.includes("lastFingerprintNote") && body.includes("lastToolsNote");
          }
        }
      }
      return false;
    };
    const curve = inLogStatement("[cache-curve]");
    const turnEnd = inLogStatement("[codex-turn-end]");
    out.push(
      assert(
        "★★codex 어댑터가 지문을 **로그 문장 안에** 싣는다 — 계산만 하고 안 찍으면 로그로 판별한다는 목적이 그대로 무너진다(변수 존재만 보면 로그에서 빼도 초록이었다)",
        /prefixFingerprint\(/.test(src) && curve && turnEnd,
        `계산=${/prefixFingerprint\(/.test(src)} · cache-curve=${curve} · codex-turn-end=${turnEnd}`,
      ),
    );
    // ★**누구 것인지**가 없으면 지문도 소용없다 (2026-09-10 실측).
    //  위임(`worker:<uuid>`)은 중앙값 **1턴**만 살고 끝난다(최근 5일 56개 중 56개가 2턴
    //  이하). 그래서 «이 콜드가 어느 위임의 것인가 · 위임들끼리 머리를 공유하나» 를 봐야
    //  하는데, 로그에 threadKey 가 없어 대조가 불가능했다. 지문이 있어도 주인이 없으면
    //  두 줄을 나란히 놓을 수가 없다.
    for (const label of ["[codex-turn-end]", "[cache-curve]"] as const) {
      const i = src.indexOf(label);
      const head = i < 0 ? "" : src.slice(i, i + 90);
      out.push(
        assert(
          `★★\`${label}\` 이 **threadKey 를 싣는다** — 없으면 «이 콜드가 어느 위임의 것인가» 를 못 가리고, 지문이 있어도 대조할 짝을 못 찾는다`,
          /\$\{input\.threadKey\}/.test(head),
          head === "" ? "★로그 자체가 없다" : head.replace(/\s+/g, " ").slice(0, 70),
        ),
      );
    }

    // ★**도구 변화를 지시 변화와 갈라 본다** (2026-09-10 실측). 메인 스레드가 29초 만에
    //  도구 블록이 425자 줄면서 자기 캐시를 깼는데(95%→10%), 로그엔 바이트 수만 있어
    //  «어느 도구가 빠졌나» 를 못 짚었다. 프리픽스 지문은 도구+지시를 뭉쳐 보므로 둘을
    //  갈라주지 못한다 — 개수와 도구만의 해시를 따로 남겨야 두 줄 대조로 «12개→11개» 가 보인다.
    out.push(
      assert(
        "★★턴 종료 로그가 **도구 개수와 도구만의 해시**를 따로 싣는다 — 프리픽스 지문만으로는 «도구가 변했나 지시가 변했나» 를 못 가르고, 그러면 캐시가 깨진 원인을 여전히 못 짚는다",
        /lastToolsNote/.test(src) && /tools=\$\{/.test(src) && inLogStatement("[codex-turn-end]"),
        `변수=${/lastToolsNote/.test(src)} · 개수표기=${/tools=\$\{/.test(src)}`,
      ),
    );

    // ★★**사다리가 «지난 턴과 견줘 우리 프리픽스가 변했나» 를 답한다** (2026-09-10).
    //  종전엔 `tools+instructions+input` 을 통째로 이어붙여 쟀는데, 지문은 **매 model-call
    //  마다** 갱신되므로 비교 짝이 «지난 턴» 이 아니라 **같은 턴의 직전 call** 이었다.
    //  거기서 변하는 건 언제나 `input`(도구 결과가 뒤에 붙는다)뿐이라 로그가 **늘
    //  «갈림=5칸»** 만 찍었다 — 회사돌쇠 6턴 중 5턴이 그 값이었고, 정작 그 시간에 도구가
    //  64↔63 으로 뒤집히며 프리픽스를 깨고 있었는데 사다리는 한 번도 안 가리켰다.
    //  뒤에 붙는 것은 원리적으로 프리픽스 캐시를 못 깨므로 `input` 은 판별력이 0이다.
    out.push(
      assert(
        "★★지문 사다리에 `input` 을 넣지 않는다 — 넣으면 매 call 마다 «갈렸다» 가 나와 판별력이 0이 되고, 실제로 로그가 늘 «갈림=5칸» 만 찍었다",
        !/lastFingerprint = prefixFingerprint\([\s\S]{0,200}?body\.input/.test(src),
        (() => {
          const m = /lastFingerprint = prefixFingerprint\(([\s\S]{0,220}?)\);/.exec(src);
          return m === null ? "★조립부를 못 찾음 — 표현이 바뀌었으면 이 검사부터 고쳐라" : m[1]?.replace(/\s+/g, " ").slice(0, 110) ?? "?";
        })(),
      ),
    );

    // ★★**«어느 도구가» 를 로그가 말한다** — 개수와 해시는 «변했다» 까지만 말한다.
    //  회사돌쇠(원격 접속 불가)의 메인이 `64개↔63개` 를 턴마다 오가며 캐시를 3,712 바닥에
    //  붙여 뒀는데, 이름이 없어서 원격에서는 끝내 못 짚었다.
    const { describeToolChange, rememberToolNames } = await import(
      "../../core/llm-runtime/prefix-fingerprint.js"
    );
    rememberToolNames("t-regr", ["a", "b", "c"]);
    const toolDiff = describeToolChange(["a", "c"], rememberToolNames("t-regr", ["a", "c"]));
    out.push(
      assert(
        "★★도구가 바뀌면 **이름**을 적는다 — «63개» 만으로는 원격 설치본에서 어느 도구인지 영영 못 짚는다",
        toolDiff.includes("-[b]") && toolDiff.includes("3→2"),
        `관측=${JSON.stringify(toolDiff)}`,
      ),
    );
    rememberToolNames("t-same", ["a", "b"]);
    out.push(
      assert(
        "★안 바뀌었으면 **아무것도 안 적는다** — 매 턴 66개를 나열하면 진단이 아니라 배경소음이고, 배경소음은 실제로 12일간 묻혔다",
        describeToolChange(["a", "b"], rememberToolNames("t-same", ["a", "b"])) === "",
        `관측=${JSON.stringify(describeToolChange(["a", "b"], ["a", "b"]))}`,
      ),
    );
    out.push(
      assert(
        "★어댑터가 그 diff 를 **도구 표기에 실어** 턴 종료 줄로 내보낸다 — 계산만 하면 원격에선 없는 것과 같다",
        /describeToolChange\(/.test(src) &&
          /rememberToolNames\(input\.threadKey/.test(src) &&
          /lastToolsNote =[\s\S]{0,400}?toolChange/.test(src),
        `호출=${/describeToolChange\(/.test(src)} · 기억=${/rememberToolNames\(input\.threadKey/.test(src)} · 표기연결=${/lastToolsNote =[\s\S]{0,400}?toolChange/.test(src)}`,
      ),
    );

    // ★**틀린 처방을 제품 문구에 박아 두지 않는다** (2026-09-10). 이 경고는 «먼저 모델을
    //  바꿔 보라 — sol 12% ↔ terra 95%+» 라고 단언했는데 근거가 **11턴 프로브 한 번**이었다.
    //  46일 실사용은 sol 메인 227턴 42%·서브 75턴 45% · terra 서브 119턴 52% 로, 8배 격차가
    //  아니다. 사용자가 그 문구를 받고 «솔이 필요한 상황인데 테라로 내리긴 힘들지» 라고
    //  되물었다 — 제품이 내보내는 문구는 재지 않은 말을 하면 안 된다(SYSTEM.md §21).
    const runtime = stripComments(readSourceSync("src/core/llm-runtime/index.ts"));
    out.push(
      assert(
        "★★캐시 경고가 **모델 교체를 처방하지 않는다** — 재지 않은 배수(sol 12% ↔ terra 95%+)를 근거로 모든 사용자를 모델 교체로 보내던 문구",
        !/모델을 바꿔 보라|sol 12%|terra 95/.test(runtime),
        `옛 문구 잔존=${/모델을 바꿔 보라|sol 12%|terra 95/.test(runtime)}`,
      ),
    );
    out.push(
      assert(
        "★그 자리에 **로그로 판별하는 법**이 들어 있다 — 처방을 지우고 빈칸으로 두면 사용자는 더 막막해진다",
        /갈림=/.test(runtime) && /도구변화=/.test(runtime),
        `갈림 안내=${/갈림=/.test(runtime)} · 도구변화 안내=${/도구변화=/.test(runtime)}`,
      ),
    );

    return out;
  },
};
