/**
 * **브리지에 못 닿았을 때 «왜» 를 남긴다** — 순수 (2026-09-18, 회사돌쇠 조사).
 *
 * ★사고: 대시보드가 `502 bridge unreachable: fetch failed` 를 냈는데, 로그에
 *  **그것뿐**이었다. 데몬도 대시보드도 죽지 않았고 앞뒤로 작업 로그가 이어졌는데,
 *  «어느 요청이 · 무슨 코드로» 실패했는지가 **아무 데도 없어** 원인을 확정할 수 없었다.
 *
 * ★★`fetch failed` 는 **껍데기**다. Node 의 `fetch` 는 진짜 원인을 `cause` 에 넣어 감싼다
 *  (`ECONNREFUSED`·`ETIMEDOUT`·`ENOTFOUND`·`ECONNRESET`…). 오늘 Windows 실행부에서 고친
 *  «CLIXML 이 오류를 가린다» 와 **같은 부류**다 — 있는 정보를 안 꺼내 쓰는 것.
 *
 * ★토큰·본문은 절대 안 싣는다. 경로·코드·간단한 메시지까지다.
 */
export const describeFetchFailure = (e: unknown): string => {
  const parts: string[] = [];
  // ★**방문한 것을 기억한다** — 상수 상한만으로는 `a→b→a` 순환이 안 막힌다(자기 변이로
  //  적발: 자기참조는 «같은 객체» 검사에 걸리지만 두 칸짜리 순환은 영원히 돈다).
  //  깊이 상한은 «너무 긴 사슬» 을, 방문 집합은 «되돌아옴» 을 막는다 — 다른 것을 막는다.
  const seen = new Set<unknown>();
  let cur: unknown = e;
  // 원인 사슬을 따라간다 — `fetch failed` → `Error: connect ECONNREFUSED ::1:7011` 처럼
  // 한 겹 아래에 진짜가 있다.
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth += 1) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const o = cur as { message?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
    const msg = typeof o.message === "string" ? o.message : "";
    const code = typeof o.code === "string" ? o.code : "";
    const piece = [code, msg].filter((s) => s !== "").join(" ");
    if (piece !== "" && !parts.includes(piece)) parts.push(piece);
    if (o.cause === undefined || o.cause === cur) break;
    cur = o.cause;
  }
  if (parts.length === 0) return String(e).slice(0, 200);
  return parts.join(" ← ").slice(0, 300);
};

/** 로그 한 줄 — **무엇을 부르다가** 실패했는지가 같이 있어야 진단이 된다. */
export const bridgeFailureLog = (target: string, path: string, e: unknown): string =>
  `[bridge] ${path} → ${target} 실패: ${describeFetchFailure(e)}`;
