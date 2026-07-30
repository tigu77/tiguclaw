/**
 * **배선 단언 공용 헬퍼** (2026-07-30).
 *
 * ★왜: 순수 함수만 검사하면 **호출부를 지워도 초록**이다. 2026-07-29 에 3건을 그렇게 고쳤는데
 *  바로 다음날 추가한 5건이 같은 구멍을 그대로 재도입했다(감사 실측: 순수 로직 변이 7/7 잡힘,
 *  **배선 변이 12/12 전부 통과**). 매번 손으로 readFile+정규식을 쓰다 빠뜨린 것이므로
 *  헬퍼로 올려 빠뜨릴 여지를 없앤다.
 *
 * ★읽기 실패는 **빨간불**이다 (2026-07-31 교정). 원래는 "배포본엔 .ts 가 없다" 며 통과로
 *  넘겼는데, **그 전제가 사실이 아니었다** — public 매니페스트는 `src/**` 를 그대로 싣고
 *  `test:regression` 은 tsx 로 src 를 돈다. 실측: 전체 스위트에서 읽기 실패 **0건**.
 *  즉 이 관용은 오탐을 막은 적이 없고, **경로 오타를 영원히 초록으로 만드는 일**만 했다
 *  (그물의 그물코가 없는 채로 있어도 아무도 모른다 = 오늘 실제로 한 건 나왔다).
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
    return { ok: false, missing: [`읽기 실패(경로 오타?) ${String(url)}`] };
  }
  const missing = patterns.filter((re) => !re.test(src)).map((re) => String(re));
  return { ok: missing.length === 0, missing };
};

/**
 * 패턴들이 **이 순서대로** 나오는지 (2026-07-31).
 *
 * ★존재만 검사하면 못 잡는 부류가 있다: `[codex-sse-incomplete]` 로그는 있었는데 바로 위
 *  `throw` 가 그보다 앞서서, **정작 실패한 스트림에서만 안 찍혔다**(성공 때만 찍히는 진단).
 *  "있다" 와 "닿는다" 는 다르고, 그 차이가 순서인 경우가 있다.
 */
export const sourceOrder = async (
  relFromRegressionDir: string,
  patterns: RegExp[],
): Promise<{ ok: boolean; detail: string }> => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(relFromRegressionDir, import.meta.url);
  let src: string;
  try {
    src = await readFile(url, "utf8");
  } catch {
    return { ok: false, detail: `읽기 실패(경로 오타?) ${String(url)}` };
  }
  let at = -1;
  for (const re of patterns) {
    const idx = src.search(re);
    if (idx < 0) return { ok: false, detail: `미발견 ${String(re)}` };
    if (idx < at) return { ok: false, detail: `순서 역전 ${String(re)}` };
    at = idx;
  }
  return { ok: true, detail: "순서 확인" };
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
    return { ok: false, found: -1 }; // -1 = 파일을 못 읽음(패턴 0회와 구분).
  }
};
