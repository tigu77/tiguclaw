/**
 * 회귀: **플러그인 메뉴 동작(`handler:`)** — 플러그인이 커맨드 파일 하나 + 자기 코드의 처리기 하나로 모든 프로젝트 메뉴에 동작을 더하고,
 * 누르면 코어가 다시 확인한 그 프로젝트를 받아 처리기가 돈다(2026-11-03 설계 §2.8 · §7-⑧ · R4 N2).
 *
 * 지키는 것: 발견 판정(플러그인+scope 만) · 프로젝트 맥락(연결 기록 경로·메시지 좌표) · 화면(postCard → 위젯 첨부) · 폴더 대조(같은 이름 다른 폴더·
 * 로드 실패 → 안내, 입구까지) · 수명(끄기·제거·다시 켜기) · confirm 의 코어 집행 · 중복·/stop·늦은 출력 차단 · 던짐·비밀 가림 · 셸 중단 보존 · 두 채널 표현.
 *
 * 등급: **동작** — 자식 프로세스의 격리 홈에서 진짜 로더로 설치한 플러그인(_child-checks.ts).
 */
import { runChildChecks } from "./_child-checks.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "plugin-command-handler",
  guards:
    "플러그인이 셸 한 줄·비서 부탁 글로 안 되는 메뉴 동작(자기 코드·자기 화면)을 더할 길이 없던 것 — 그리고 그 길이 생기며 코드가 로드된 적 없는 폴더의 선언이 남의 처리기를 부르거나, 슬래시 글자의 경로가 처리기로 가거나, 멈춘 뒤에도 카드·답이 나가는 것",
  run: async (): Promise<Assertion[]> => runChildChecks(new URL("./_plugin-command-handler-child.ts", import.meta.url)),
};
