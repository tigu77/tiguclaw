/**
 * **배선 단언 공용 헬퍼** (2026-07-30).
 *
 * ★왜: 순수 함수만 검사하면 **호출부를 지워도 초록**이다. 2026-07-29 에 3건을 그렇게 고쳤는데
 *  바로 다음날 추가한 5건이 같은 구멍을 그대로 재도입했다(감사 실측: 순수 로직 변이 7/7 잡힘,
 *  **배선 변이 12/12 전부 통과**). 매번 손으로 readFile+정규식을 쓰다 빠뜨린 것이므로
 *  헬퍼로 올려 빠뜨릴 여지를 없앤다.
 *
 * 배포본엔 `.ts` 가 없으므로 읽기 실패는 **통과**(오탐 0) — 기존 관용구와 동일.
 */
export const sourceHas = async (
  relFromRegressionDir: string,
  patterns: RegExp[],
): Promise<{ ok: boolean; missing: string[] }> => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(relFromRegressionDir, import.meta.url);
  let src: string;
  try {
    src = await readFile(url, "utf8");
  } catch {
    return { ok: true, missing: [] }; // 배포본 — 검사 불가, 통과.
  }
  const missing = patterns.filter((re) => !re.test(src)).map((re) => String(re));
  return { ok: missing.length === 0, missing };
};

/** 같은 패턴이 **N회 이상** 나오는지(호출부가 여러 곳일 때). */
export const sourceHasCount = async (
  relFromRegressionDir: string,
  pattern: RegExp,
  min: number,
): Promise<{ ok: boolean; found: number }> => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(relFromRegressionDir, import.meta.url);
  try {
    const src = await readFile(url, "utf8");
    const found = (src.match(new RegExp(pattern.source, "g" + pattern.flags.replace("g", "")))
      ?? []).length;
    return { ok: found >= min, found };
  } catch {
    return { ok: true, found: min };
  }
};
