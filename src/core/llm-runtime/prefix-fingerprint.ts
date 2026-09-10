/**
 * **프리픽스 지문** — 캐시가 왜 콜드였는지를 **로그만으로** 짚기 위한 것 (2026-09-09 정태님:
 * *"로그로도 판별이 가능하게 재야지"*).
 *
 * 사고: codex 캐시 적중률이 6%~95% 로 갈렸는데, 로그엔 **바이트 수만** 있었다. 그래서
 * «지시가 45,692 로 같은데 내용이 다른가» 를 가릴 수가 없었다 — 같은 분에 같은 크기의 두
 * 요청이 65% 와 8% 로 갈린 것을 설명하지 못했다. 증상만 있고 **판정 수치**가 없었다
 * ([[feedback_logs_must_stand_alone]]).
 *
 * ★**사다리로 잰다.** 프리픽스를 앞에서부터 잘라 여러 지점의 해시를 남긴다. 다음 요청과
 *  비교하면 **몇 번째 칸부터 달라졌는지**가 그대로 나온다 — 그게 캐시가 끊긴 자리다.
 *  «달라졌다» 가 아니라 «1KB 까지는 같고 16KB 에서 갈렸다» 를 로그가 말한다.
 * ★해시는 짧게(8자) — 로그는 사람이 읽는 자리다. 충돌은 진단에 무해하다(같은 8자가
 *  우연히 겹쳐도 그 다음 칸에서 갈린다).
 * ★**원문을 안 남긴다.** 프롬프트엔 대화 내용이 들어 있고 로그는 오래 산다.
 *
 * ★**실측으로 밝혀진 것** (2026-09-10, 격리 프로브 10턴 × 2조건):
 *  codex 캐시는 **정상이다.** 같은 threadKey 로 연속 호출하면 **2턴 콜드(45%) 뒤 99%** 로
 *  안정된다. 낮게 보이던 값은 **콜드 스타트 창**을 짧은 표본으로 잰 것이었다(3턴만 재면
 *  그 창 안에 갇힌다 — 내가 그렇게 «백엔드가 흔들린다» 고 잘못 결론냈다).
 *  ★공식 문서가 경고하는 «top-level `instructions` 는 캐시 breakpoint 를 못 가진다» 도
 *   **이 경로에선 차이가 없었다**: instructions 파라미터 vs developer 메시지 A/B 에서
 *   중앙값이 둘 다 99% 였다. 문서를 읽고 «그래서 이게 원인» 이라고 넘겨짚지 말 것.
 *  ★`store` 는 손잡이가 아니다 — 백엔드가 `store:true` 를 400 으로 거절한다.
 */
import { createHash } from "node:crypto";

/** 자르는 지점(문자) — 촘촘할수록 잘 짚지만 로그가 길어진다. 다섯이면 충분하다. */
export const FINGERPRINT_CUTS = [1_000, 4_000, 16_000, 64_000, 256_000] as const;

const short = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);

/**
 * 프리픽스를 잘라 각 지점까지의 해시를 낸다.
 *
 * @param prefix 캐시 대상이 되는 문자열(지시 + 입력을 **보내는 순서 그대로** 이어붙인 것).
 * @returns 자른 지점 수만큼의 짧은 해시. 프리픽스가 짧으면 그 지점부터는 전체 해시가 반복된다.
 */
export const prefixFingerprint = (prefix: string): string[] =>
  FINGERPRINT_CUTS.map((n) => short(prefix.slice(0, n)));

/**
 * 두 지문이 **몇 번째 칸부터** 달라졌나.
 *
 * @returns 1-based 칸 번호. 전부 같으면 0(= 프리픽스가 그대로다).
 */
export const firstDivergentCut = (a: readonly string[], b: readonly string[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return i + 1;
  }
  return a.length === b.length ? 0 : Math.min(a.length, b.length) + 1;
};

/**
 * 사람이 읽는 한 줄 — «어디서 갈렸나» 를 바로 말한다.
 *
 * ★첫 요청(비교 대상 없음)은 «처음» 이라고 적는다. «갈린 데 없음» 과 구분돼야 한다 —
 *  둘 다 «0» 으로 적으면 콜드 캐시의 원인을 또 못 가린다.
 */
export const describeFingerprint = (
  now: readonly string[],
  prev: readonly string[] | undefined,
): string => {
  const head = now.join("/");
  if (prev === undefined) return `fp=${head} 갈림=처음`;
  const at = firstDivergentCut(prev, now);
  if (at === 0) return `fp=${head} 갈림=없음(프리픽스 동일)`;
  const from = at === 1 ? 0 : FINGERPRINT_CUTS[at - 2];
  const to = FINGERPRINT_CUTS[at - 1];
  return `fp=${head} 갈림=${at}칸(${from?.toLocaleString()}~${to?.toLocaleString()}자 사이)`;
};

/**
 * 스레드별 직전 지문 — **바운드**한다. 진단용 곁가지가 메모리를 먹으면 안 된다
 * ([[project_hotpath_bound_preserve_record]]).
 */
const CAP = 64;
const lastByThread = new Map<string, string[]>();

/** 직전 지문을 꺼내고 이번 것을 넣는다(같은 호출에서 둘 다 한다 — 순서가 갈리면 틀린다). */
export const rememberFingerprint = (
  threadKey: string,
  fp: string[],
): string[] | undefined => {
  const prev = lastByThread.get(threadKey);
  lastByThread.delete(threadKey);
  lastByThread.set(threadKey, fp);
  if (lastByThread.size > CAP) {
    const oldest = lastByThread.keys().next().value;
    if (oldest !== undefined) lastByThread.delete(oldest);
  }
  return prev;
};
