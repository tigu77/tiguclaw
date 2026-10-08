/**
 * **포트를 못 열었을 때 이유와 고칠 길을 말한다** (2026-10-08 집 윈도우 실사고).
 *
 * ★사고: 윈도우가 6917~7016 을 예약(제외 범위)해 대시보드·브리지가 `listen EACCES` 로 못 떴다. 로그엔 오류 스택만 남고 데몬은
 *  «ready» 라고 해서 사용자는 «대시보드가 안 열린다» 밖에 알 수 없었다. EACCES 는 윈도우에선 대개 예약 범위, EADDRINUSE 는
 *  다른 프로그램 — 둘 다 **포트를 바꾸면** 풀린다.
 * ★표식 `[port-unavailable:<코드>] <키>=<포트>` 로 시작한다 — 자기 점검(health-sweep)이 이 표식으로 찾아 사용자에게 알린다.
 *  문장(영어, 로그용)은 바뀌어도 표식 모양은 그대로 둔다(`parsePortUnavailable` 가 그 모양을 읽는다).
 */
export const PORT_UNAVAILABLE_TAG = "[port-unavailable";

/** listen 실패 → 한 줄 안내. 포트 문제가 아니면 undefined(원래 오류를 그대로 쓴다). */
export const portListenFailure = (err: unknown, key: string, port: number | string): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EACCES") {
    return (
      `${PORT_UNAVAILABLE_TAG}:EACCES] ${key}=${port} could not be opened (permission denied). On Windows this usually means the port ` +
      `is inside an excluded range reserved by Hyper-V/WSL/Docker — check \`netsh interface ipv4 show excludedportrange protocol=tcp\`, ` +
      `then set ${key} in the home .env to a free port between 15001 and 32767 (the defaults are 17010 for the dashboard and 17011 ` +
      `for the bridge) and restart.`
    );
  }
  if (code === "EADDRINUSE") {
    return `${PORT_UNAVAILABLE_TAG}:EADDRINUSE] ${key}=${port} is already in use by another program — set ${key} in the home .env to a free port and restart.`;
  }
  return undefined;
};

/** 안내 줄에서 코드·키·포트를 읽는다 — 사용자 알림(번역)용. */
export const parsePortUnavailable = (text: string): { code: string; key: string; port: string } | undefined => {
  const m = /\[port-unavailable:(\w+)\] (\w+)=(\d+)/.exec(text);
  return m === null ? undefined : { code: m[1]!, key: m[2]!, port: m[3]! };
};

/**
 * `netsh interface ipv4 show excludedportrange protocol=tcp` 출력 → [시작, 끝] 목록. 표 머리·언어(한국어 윈도우 포함)와 무관하게
 * 「숫자 두 개로 시작하는 줄」만 센다(관리 제외 표시 `*` 는 무시).
 */
export const parseExcludedPortRanges = (text: string): Array<[number, number]> =>
  text
    .split(/\r?\n/)
    .map((l) => /^\s*(\d+)\s+(\d+)\b/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [Number(m[1]), Number(m[2])] as [number, number]);

/** 포트가 예약 범위 안인가 — 걸린 범위를 돌려준다. */
export const excludedRangeOf = (port: number, ranges: Array<[number, number]>): [number, number] | undefined =>
  ranges.find(([a, b]) => port >= a && port <= b);
