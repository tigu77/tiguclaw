// src/core/asset-fingerprint.ts
/**
 * **서빙하는 프런트 자산의 내용 지문** (2026-08-28).
 *
 * ★없어서 화면이 늙었다. 새로고침 판정이 **버전**만 봤는데 sync 배포는 버전을 안 올린다 —
 *  오늘 데몬을 28번 재시작하는 동안 브라우저는 **아침 JS 를 그대로** 들고 있었고, 그 사이
 *  새로 만든 위젯 호스트가 그 화면엔 아예 없었다. 사용자에겐 *"위젯이 안 나온다"* 로 보인다.
 *
 * ★손 번호(`?v=2`)를 쓰지 않는다 — 파일을 고치고 번호를 안 올리면 조용히 안 바뀌고, 그
 *  목록은 반드시 드리프트한다. 내용 해시는 **바뀔 때만** 바뀌고 사람이 관리할 것이 없다
 *  (이 레포가 아이콘에 이미 쓰던 규칙을 JS·CSS 로 넓힌 것뿐이다).
 *
 * ★순수 함수인 이유는 검사다 — 서버 안에 인라인이면 "지문이 내용을 따라가는가" 를 데몬을
 *  띄워야만 볼 수 있다(principle-check Q7).
 */
import { createHash } from "node:crypto";

/**
 * 파일 내용들을 **순서대로** 이어 해시한다.
 *
 * ★순서가 결과에 들어간다 — 로드 순서가 바뀌면 다른 화면이므로 그것도 "바뀐 것" 이 맞다.
 * @returns 12자 hex. 입력이 비면 빈 문자열(= 판정 불가 → 호출자가 종전 동작으로 떨어진다).
 */
export const assetFingerprintOf = (contents: readonly Uint8Array[]): string => {
  if (contents.length === 0) return "";
  const h = createHash("sha1");
  for (const c of contents) h.update(c);
  return h.digest("hex").slice(0, 12);
};
