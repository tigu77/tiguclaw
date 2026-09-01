/**
 * 회귀: **같은 실패는 같은 키가 된다 — id 가 키를 가르면 안 된다** (2026-08-31).
 *
 * ★사고(실측): 기억에 **94% 유사한 쌍**이 있었다 —
 *  `feedback_growth_failure_wa2aed889093f` / `…_wa8b66ee5542f`. 같은 실패인데 **매니저 id 가
 *  다르다는 이유로 서로 다른 메모리**가 됐다. 정규화의 `\b[0-9a-f]{8,}\b` 가 앞에 글자가
 *  붙은 id(`w`+16진수)를 **못 지웠기 때문**이다 — `w` 와 `a` 사이엔 단어경계가 없다.
 *  그러면 숫자 규칙이 조각내 `wa<n>aed<n>f` 처럼 id 마다 다른 결과를 낸다.
 *
 * ★**같은 병을 이 파일이 이미 한 번 앓았다.** 바로 아래 주석이 *"단어경계 의존 시 `30000ms`
 *  가 마스킹 실패 → 다른 군집키로 분산돼 threshold 누적 못 함"* 이라고 적어뒀다.
 *  **숫자엔 고쳤고 해시엔 안 고쳤다** — 같은 진단을 옆에 두고도 한쪽만 고친 것이다.
 *
 * ★피해가 둘이다: ①같은 내용이 인덱스에 계속 쌓인다(캡 있는 자리) ②임계 누적이 안 돼
 *  **반복 판정 자체가 늦어진다**(키가 갈리면 각각 1회로 세어진다).
 *
 * 등급: **동작** — 정규화 함수를 실제로 돌린다(데몬·네트워크 0).
 */
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "failure-key-ignores-ids",
  guards:
    "같은 실패가 id 만 달라 서로 다른 멱등 키가 되어, 같은 내용이 기억에 계속 쌓이고 반복 임계 누적도 안 되던 것(실측: 94% 유사한 쌍)",
  run: async (): Promise<Assertion[]> => {
    // 리터럴 import 는 `npm run build`(rootDir=src)를 깨뜨린다 — `loadPluginModule` 주석 참고.
    const { normalizeErrorMessage } = await loadPluginModule<{
      normalizeErrorMessage: (s: string) => string;
    }>("../../../plugins/self-growth/src/analysis.ts");
    const same = (a: string, b: string): boolean =>
      normalizeErrorMessage(a) === normalizeErrorMessage(b);

    // ① 실측 사례 그대로 — 글자 붙은 id(`w`+hex).
    const prefixed = same("매니저 wa2aed889093f 실패", "매니저 wa8b66ee5542f 실패");
    // ② UUID — 조각으로 두면 하이픈 사이가 제각각 마스킹된다.
    const uuid = same(
      "job 268be2e5-2002-4608-a8cc-27b12841d596 실패",
      "job 2a150a64-f4df-4271-b4eb-8f761784c592 실패",
    );
    // ③ 이 파일이 이미 고쳤던 축 — 회귀 안 났나.
    // ★픽스처가 **8자리 경계를 넘어야** 한다 (적대 검토 P3). 첫 판은 `30000`/`45000`(5자리)
    //  뿐이라 새 hex 규칙이 **순수 숫자 8자리 이상**을 먹는 걸 못 봤다 — `100000000ms` 가
    //  `<hash>ms` 가 되어 같은 타임아웃이 다른 키로 갈렸다. **고치려던 그 결함을 다른
    //  자릿수에서 재발시킨 것**이고, 검사는 "안 깨졌다" 고 말하고 있었다.
    //  **경계를 안 넘는 픽스처는 경계를 안 잰다.**
    const units =
      same("타임아웃 30000ms 초과", "타임아웃 45000ms 초과") &&
      same("타임아웃 45000ms 초과", "타임아웃 100000000ms 초과") &&
      same("재시도 12345678회", "재시도 999회") &&
      // ★**같은 자리의 id 를 물어본다** (3라운드 F11). 한쪽만 재고 있었다 — 8자 id 가
      //  hex 로 보이면 `<hash>`, 순수 숫자면 `<n>` 이라 **같은 필드인데 키가 갈렸다**
      //  (그 확률 `(10/16)^8` = 2.33%). 검사는 그걸 **안 물어봤다.**
      same("job 1234567a 실패", "job 12345678 실패") &&
      // ★8자리 **경계 아래**는 그대로 둔다 — 규칙을 `{7,}` 로 넓히면 여기가 걸린다.
      normalizeErrorMessage("코드 abcdef1 오류") === "코드 abcdef<n>오류";

    // ④ ★반대 방향 — **다른 실패는 여전히 달라야** 한다. 전부 뭉개면 임계가 엉뚱하게 쌓인다.
    const distinct =
      !same("타임아웃 초과", "권한 거부") && !same("파일 없음", "네트워크 끊김");
    // ⑤ ★영단어를 해시로 오인하지 않는다(16진수 글자만으로 된 흔한 낱말은 어쩔 수 없다).
    const words =
      normalizeErrorMessage("accessed 파일") === "accessed 파일" &&
      normalizeErrorMessage("database 연결") === "database 연결";

    return [
      assert(
        "★★글자가 붙은 id 도 지운다 — `w`+16진수는 단어경계가 없어 종전 규칙을 빠져나갔다(실측 94% 유사 쌍의 원인)",
        prefixed,
        `${normalizeErrorMessage("매니저 wa2aed889093f 실패")} | ${normalizeErrorMessage("매니저 wa8b66ee5542f 실패")}`,
      ),
      assert(
        "★★UUID 는 **통째로** 지운다 — 조각으로 두면 하이픈 사이를 숫자 규칙이 제각각 바꿔 키가 갈린다",
        uuid,
        normalizeErrorMessage("job 268be2e5-2002-4608-a8cc-27b12841d596 실패"),
      ),
      assert(
        "★이미 고쳤던 축(숫자+단위)이 **안 깨졌다** — 같은 파일이 같은 병을 두 번 앓았다",
        units,
        `${normalizeErrorMessage("타임아웃 45000ms 초과")} | ${normalizeErrorMessage("타임아웃 100000000ms 초과")}`,
      ),
      assert(
        "★★반대 방향 — **다른 실패는 여전히 다르다**(전부 뭉개면 임계가 엉뚱하게 쌓여 반복이 아닌 걸 반복이라 한다)",
        distinct,
        distinct ? "서로 다름 유지" : "★과도 마스킹",
      ),
      assert(
        "★영단어를 해시로 오인하지 않는다 — `accessed`·`database` 는 그대로 둔다",
        words,
        `${normalizeErrorMessage("accessed 파일")} · ${normalizeErrorMessage("database 연결")}`,
      ),
    ];
  },
};
