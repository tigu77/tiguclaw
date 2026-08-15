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
/**
 * ★**주석은 코드가 아니다** (2026-08-15, 적대 검토 F2·F6).
 *
 * 적대 검토가 `reasoning[...] = ...` 한 줄을 **주석으로 바꾸고** 1,031건을 전부 통과시켰다.
 * 배선이 사라졌는데 그물은 초록이었다 — 정규식이 주석 줄에 걸렸기 때문이다. 같은 방법으로
 * 취소 통지 문구도 주석 한 줄로 만족됐다. ★이 레포는 **같은 부류로 이미 세 번 데였다**
 * (`⑫ 구독 검사`가 주석 처리로 다시 뚫린 것 · `verify-dashboard-split` 이 주석 안의
 * `<style>` 을 세어 상시 FAIL 이던 것). 판정 대상은 **코드**지 그걸 설명하는 글이 아니다.
 *
 * 문자열 안의 `//`(URL 등)을 주석으로 오인하면 반대편 오탐이 되므로 따옴표를 추적하고,
 * 줄 주석은 **줄머리이거나 공백 뒤**일 때만 인정한다(`https://` 는 `:` 뒤라 안 걸린다).
 * 정규식 리터럴 안의 `\/\/` 도 역슬래시 뒤라 안 걸린다.
 * 줄 구조는 보존한다(`sourceOrder` 가 위치를 쓰고, 오류 메시지 줄번호가 어긋나면 안 된다).
 */
export const stripComments = (src: string): string => {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    const next = src[i + 1] ?? "";
    if (quote !== null) {
      out += c;
      if (c === "\\") { out += next; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, " "); // 줄바꿈만 남긴다(위치 보존)
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const prev = i === 0 ? "\n" : (src[i - 1] ?? "");
    if (c === "/" && next === "/" && /[\s]/.test(prev)) {
      const nl = src.indexOf("\n", i);
      i = (nl < 0 ? src.length : nl) - 1;
      continue;
    }
    out += c;
  }
  return out;
};

/** 세 헬퍼가 공유하는 읽기 — **주석을 벗긴 코드**를 준다. */
const readCode = async (url: URL): Promise<string | null> => {
  const { readFile } = await import("node:fs/promises");
  try {
    return stripComments(await readFile(url, "utf8"));
  } catch {
    return null;
  }
};

export const sourceHas = async (
  relFromRegressionDir: string,
  patterns: RegExp[],
): Promise<{ ok: boolean; missing: string[] }> => {
  const url = new URL(relFromRegressionDir, import.meta.url);
  const src = await readCode(url);
  if (src === null) return { ok: false, missing: [`읽기 실패(경로 오타?) ${String(url)}`] };
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
  const url = new URL(relFromRegressionDir, import.meta.url);
  const src = await readCode(url);
  if (src === null) return { ok: false, detail: `읽기 실패(경로 오타?) ${String(url)}` };
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
  const url = new URL(relFromRegressionDir, import.meta.url);
  {
    const src = await readCode(url);
    if (src === null) return { ok: false, found: -1 }; // -1 = 파일을 못 읽음(패턴 0회와 구분).
    const found = (src.match(new RegExp(pattern.source, "g" + pattern.flags.replace("g", "")))
      ?? []).length;
    return { ok: found >= min, found };
  }
};
