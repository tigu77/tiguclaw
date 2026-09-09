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
          if (depth === 0) return src.slice(start, k).includes("lastFingerprintNote");
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
    return out;
  },
};
