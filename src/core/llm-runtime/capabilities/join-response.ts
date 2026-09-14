/**
 * **묶음 합류 응답 조립 — 자식이 조용히 사라지지 않게** (2026-09-14)
 *
 * ★사고(외부 재현, 실측): 6,000자 자식 셋을 `wait_for_worker` 로 한 번에 거두면 도구 응답이
 *  18,169자가 되고, 어댑터 진입 cap(codex C2 = 16,000자, 머리 8,000 + 꼬리 4,000)이 **묶음
 *  전체**에 걸린다. 그 결과 **둘째 자식의 처음·중간·끝 표식이 전부 사라졌다**(9개 중 5개만
 *  남음). 잘린 것은 `wait_for_worker` 가 아니라 그 **뒤**이고, 아무 표시도 남지 않는다.
 *
 * ★그래서 «마지막에 전부 한 번에 다시 읽으면 안전하다» 는 거짓이다. 여기서 고치는 것은 셋:
 *  ①cap 을 키우거나 예외를 두지 **않는다**(다른 도구의 비용이 같이 늘고, 예외는 는다)
 *  ②자르는 자리를 **자식별**로 옮긴다 — 한 자식이 길어도 다른 자식이 사라지지 않는다
 *  ③**머리에 명세를 둔다** — 전체 목록·각 상태·원문 재조회 방법. 뒤가 잘려도 이건 남는다.
 *
 * ★재조회는 **읽기**다 — 끝난 잡의 `job.result` 를 다시 읽는 것이라 자식이 새로 돌지 않는다.
 *  그리고 하나씩 부르면 예산을 혼자 쓰므로 «같은 묶음을 다시 잘리게» 하는 순환이 없다.
 */

/**
 * 한 합류 응답이 쓸 **본문 총예산**. codex 진입 cap(16,000) 밑에 둬서 C2 가 애초에 안 걸리게
 * 한다 — 어댑터 상수를 여기서 import 하지 않는다(그러면 도구가 어댑터에 묶인다). 명세·머리표가
 * 쓸 자리를 남기고 고른 수다.
 */
export const JOIN_BODY_BUDGET_CHARS = 12_000;

export interface JoinEntry {
  readonly jobId: string;
  readonly label: string;
  /** 사람이 읽는 상태 한 토막 (`✅ 완료`·`⏳ 아직 진행 중` 등). */
  readonly status: string;
  /** 결과 본문. 없으면 빈 문자열(상태만 보고된다). */
  readonly body: string;
}

/** 자식별 예산 — 짧은 자식이 남긴 몫을 긴 자식이 나눠 쓴다(water-filling). */
const shareBudget = (lengths: readonly number[], total: number): number[] => {
  const share = new Array<number>(lengths.length).fill(0);
  const open = lengths.map((_, i) => i);
  let left = total;
  while (open.length > 0) {
    const even = Math.floor(left / open.length);
    if (even <= 0) break;
    const done = open.filter((i) => (lengths[i] as number) <= even);
    if (done.length === 0) {
      for (const i of open) share[i] = even;
      break;
    }
    for (const i of done) {
      share[i] = lengths[i] as number;
      left -= share[i] as number;
    }
    for (const i of done) open.splice(open.indexOf(i), 1);
  }
  return share;
};

/** 자기 몫을 넘는 본문은 머리+꼬리만 남기고, **무엇이 빠졌고 어떻게 읽나**를 그 자리에 적는다. */
const fitBody = (body: string, budget: number, jobId: string): string => {
  if (body.length <= budget) return body;
  const head = Math.max(0, Math.floor((budget * 2) / 3));
  const tail = Math.max(0, budget - head);
  const omitted = body.length - head - tail;
  return (
    `${body.slice(0, head)}\n` +
    `…[이 자식 결과 ${body.length.toLocaleString()}자 중 ${omitted.toLocaleString()}자 생략 — ` +
    `wait_for_worker(["${jobId}"]) 로 이 자식만 부르면 예산을 혼자 써서 더 많이 받습니다. ` +
    `작업이 다시 돌지는 않습니다.]…\n` +
    (tail > 0 ? body.slice(body.length - tail) : "")
  );
};

/**
 * 합류 응답 한 덩어리. **첫 줄이 명세**다 — 압축(C1)이 본문을 치워도 첫 줄은 남으므로
 * (`compactOldToolOutputs`), 모델이 무엇을 다시 읽어야 하는지 알 수 있다.
 */
export const packJoinResponse = (
  entries: readonly JoinEntry[],
  opts?: { budget?: number },
): string => {
  if (entries.length === 0) return "기다릴 작업이 없습니다.";
  const budget = opts?.budget ?? JOIN_BODY_BUDGET_CHARS;
  const share = shareBudget(
    entries.map((e) => e.body.length),
    budget,
  );
  const n = entries.length;
  const manifest = entries.map(
    (e, i) =>
      `· [${i + 1}] ${e.label} (${e.jobId}): ${e.status}` +
      (e.body === ""
        ? ""
        : ` · 결과 ${e.body.length.toLocaleString()}자` +
          (e.body.length > (share[i] as number)
            ? ` (아래에 ${(share[i] as number).toLocaleString()}자만 실음)`
            : "")),
  );
  const bodies = entries
    .filter((e) => e.body !== "")
    .map((e) => {
      const i = entries.indexOf(e);
      return `── [${i + 1}] ${e.label} (${e.jobId}) ──\n${fitBody(e.body, share[i] as number, e.jobId)}`;
    });
  return [
    // ★**짧게 둔다** (2026-09-14). 압축은 첫 줄만 남기고 그것도 200자에서 자른다 — 여기에
    //  UUID 를 나열했더니 자식 6명에서 **넷만 남고 둘이 잘렸다**(외부 재현 실측). 복구
    //  가능성이 안내문 길이에 걸려 있으면 안 된다. 목록은 `read_worker_result()` 가 준다.
    `작업자 결과 ${n}건 — 본문이 생략됐으면 read_worker_result() 로 목록(첫 쪽에 없으면 cursor 로 다음 쪽), read_worker_result(job_id, offset) 로 원문 구간을 읽으세요(읽기 전용).`,
    ...manifest,
    ...bodies,
  ].join("\n");
};

/**
 * **완료 결과의 한 구간** — 큰 결과를 나눠 읽기 위한 순수 계산 (2026-09-14).
 *
 * ★왜 필요한가(외부 재현 실측): 18,000자짜리 자식 하나는 **혼자 불러도** 예산(12,000)에 걸려
 *  가운데가 계속 생략됐다. 「이 자식만 다시 부르면 더 받습니다」 라는 안내가 그 크기에선
 *  **거짓말**이었다. 안내가 가리키는 곳에 실제로 닿아야 한다.
 *
 * ★단위는 **문자(UTF-16 code unit)** 다 — 바이트도 토큰도 아니다. 그리고 경계에서
 *  **서러게이트 쌍을 쪼개지 않는다**(이모지가 깨진다). 끝이 쌍 한가운데면 한 칸 앞으로
 *  당기므로, 돌려준 `end` 를 다음 `offset` 으로 쓰면 **이어붙였을 때 원문과 정확히 같다.**
 */
export const RESULT_PAGE_CHARS = 8_000;

export const sliceResultPage = (
  text: string,
  offset?: number,
  limit?: number,
): { text: string; start: number; end: number; total: number; done: boolean } => {
  const total = text.length;
  let start = Math.min(Math.max(0, Math.floor(offset ?? 0)), total);
  // ★**시작이 쌍 한가운데면 앞의 high 로 정규화한다** (2026-09-14 외부 검토). 종전엔 끝만
  //  보정해서, 쌍 가운데를 가리키는 offset 이 들어오면 **짝 없는 low 서러게이트**로 시작해
  //  글자가 깨졌다. 되돌린 위치는 반환 `start` 에 그대로 실어 호출부가 알 수 있게 한다.
  if (start > 0 && start < total) {
    const cur = text.charCodeAt(start);
    const prev = text.charCodeAt(start - 1);
    if (cur >= 0xdc00 && cur <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) start -= 1;
  }
  const want = Math.min(
    Math.max(1, Math.floor(limit ?? RESULT_PAGE_CHARS)),
    RESULT_PAGE_CHARS,
  );
  let end = Math.min(start + want, total);
  // 쌍을 쪼개는 자리에서만 물러선다 — **짝 없는 high** 는 그대로 둔다(버리지 않는다).
  if (end > start && end < total) {
    const code = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  // ★★**반드시 전진한다** — 남은 데이터가 있는데 0자를 돌려주면 호출부가 **영원히 같은
  //  자리를 다시 부른다**(실측: `limit=1` 로 쌍을 만나면 진행 0 · done=false). 그때는
  //  예외적으로 쌍 하나(2 code unit)를 통째로 준다. 「쪼개지 않는다」와 「멈추지 않는다」는
  //  **둘 다** 지켜야 하고, 종전엔 앞의 하나만 보고 뒤를 못 봤다.
  if (end <= start && start < total) end = Math.min(start + 2, total);
  return { text: text.slice(start, end), start, end, total, done: end >= total };
};
