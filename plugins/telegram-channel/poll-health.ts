/**
 * **텔레그램 폴링 상태 관측** (2026-11-17).
 *
 * ★왜: 개발돌쇠가 «텔레그램이 한참 답을 안 했다» 고 겪었는데 원인을 가를 기록이 없었다. 채널 `up` 표시는 마지막 폴링 성공을
 *  증명하지 않고, grammY 는 일시적 폴링 오류를 내부에서 재시도하며 `debug` 출력으로만 남긴다(`bot.js` `handlePollingError` —
 *  일반 데몬 로그에 안 보인다). 요청 한 번은 기본 500초(`timeoutSeconds`)까지 매달릴 수 있다.
 *  ★이 모듈은 원인을 정하지 않는다 — 다음에 같은 일이 나면 «폴링이 실패·지연했나» 를 로그로 가를 수 있게 할 뿐이다.
 *
 * 규칙:
 *  - 정상 폴링은 **침묵**(정상 long polling 은 매 30초쯤 돈다 — 매번 쓰면 배경 소음). 부팅 뒤 첫 응답만 한 줄.
 *  - 상태가 바뀔 때만 쓴다: 실패 시작 한 줄 → (연속 실패는 세기만) → 복구 한 줄(횟수·기간).
 *  - 정상 대기와 실패를 가른다: 요청이 long polling 대기(`timeout`초) + 여유를 넘겨서야 끝났으면 «느림» 한 줄.
 *  - 내용·토큰·chat/user id 는 싣지 않는다. 상태는 상수 크기(마지막 성공 시각·실패 횟수)뿐이다.
 */

/** 정상 long polling 대기 뒤 «느리다» 고 볼 여유. 네트워크 왕복·서버 지연을 넉넉히 덮는다. */
export const POLL_SLOW_GRACE_MS = 30_000;

export interface PollHealth {
  /** getUpdates 요청 시작 — 시작 시각을 돌려준다(끝날 때 같이 넘긴다). `timeoutSec` = 그 요청의 long polling 대기(초). */
  begin(timeoutSec: number | undefined): number;
  /** 응답을 받았다. `timeoutSec` = 그 요청의 long polling 대기(초). */
  ok(startedAt: number, timeoutSec: number | undefined): void;
  /** 요청이 실패했다(전송 실패·API 오류). `kind` 는 원인 요약(내용·토큰 없음). */
  fail(startedAt: number, kind: string): void;
  /** 지금 매달린 요청이 정상 대기를 넘겼으면 그 설명(아니면 null) — 종료 때 한 줄 남긴다. */
  stalled(): string | null;
  /**
   * 마지막으로 업데이트를 받아 온 시각(성공 응답 경계, 없으면 null). grammY 는 한 응답의 업데이트를 **차례로** 처리하고 다 끝나야 다음
   *  getUpdates 를 부르므로(`bot.js` `loop`·`handleUpdates`), 핸들러 안에서 읽으면 그 업데이트가 «도착한» 시각이다 — 앞 업데이트의 첨부
   *  다운로드를 기다린 시간이 발신→도착에 섞이지 않는다.
   */
  lastReceivedAt(): number | null;
}

const ago = (now: number, at: number | null): string => (at === null ? "없음(부팅 뒤)" : `${Math.round((now - at) / 1000)}초 전`);

export const createPollHealth = (log: (line: string) => void, now: () => number = Date.now): PollHealth => {
  let lastOkAt: number | null = null;
  let failingSince: number | null = null;
  let failCount = 0;
  let firstFailKind = "";
  let inflightSince: number | null = null;
  let inflightTimeoutSec: number | undefined;
  const slowMs = (timeoutSec: number | undefined): number => (timeoutSec ?? 0) * 1000 + POLL_SLOW_GRACE_MS;
  return {
    begin(timeoutSec): number {
      const t = now();
      inflightSince = t;
      inflightTimeoutSec = timeoutSec;
      return t;
    },
    ok(startedAt, timeoutSec): void {
      const t = now();
      const dur = t - startedAt;
      if (inflightSince === startedAt) inflightSince = null;
      if (failingSince !== null) {
        log(
          `telegram: polling 복구 — 실패 ${failCount}회 · ${Math.round((t - failingSince) / 1000)}초 동안(첫 실패: ${firstFailKind}), ` +
            `마지막 성공 ${ago(t, lastOkAt)}`,
        );
        failingSince = null;
        failCount = 0;
        firstFailKind = "";
      } else if (lastOkAt === null) {
        log(`telegram: polling 첫 응답 확인 (${dur}ms)`);
      }
      if (dur > slowMs(timeoutSec)) {
        log(`telegram: getUpdates 응답이 ${Math.round(dur / 1000)}초 걸림(정상 대기 ${timeoutSec ?? 0}초) — 성공했지만 느림`);
      }
      lastOkAt = t;
    },
    fail(startedAt, kind): void {
      const t = now();
      if (inflightSince === startedAt) inflightSince = null;
      failCount += 1;
      if (failingSince !== null) return; // 연속 실패는 센다 — 복구 때 한 줄로 알린다.
      failingSince = t;
      firstFailKind = kind;
      log(
        `telegram: polling 실패 — ${kind} (요청 ${Math.round((t - startedAt) / 1000)}초 만에, 마지막 성공 ${ago(t, lastOkAt)}). ` +
          "이어지는 실패는 세어 두고 복구되면 한 줄로 알린다",
      );
    },
    stalled(): string | null {
      if (inflightSince === null) return null;
      const dur = now() - inflightSince;
      return dur > slowMs(inflightTimeoutSec)
        ? `getUpdates 응답 대기 ${Math.round(dur / 1000)}초째(정상 대기 ${inflightTimeoutSec ?? 0}초)`
        : null;
    },
    lastReceivedAt: () => lastOkAt,
  };
};
