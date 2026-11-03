/**
 * 회귀: **플러그인 공통 실행형은 커맨드별 처음 한 번 승인** — run 줄이 바뀌면 다시, `confirm: true` 면 매번(2026-11-03 설계 §2.5·§8-1·§8-1b,
 * §7-⑦ R2·R3·R4 N1) + 플러그인 켜기·끄기·설치·제거·모듈 화면이 메뉴 갱신(`commands.changed`)을 내고 끈 플러그인의 공통은 어디에도 없다(§7-④).
 *
 * 지키는 것: 승인 범위 문구·매니페스트 이름 키·다른 키 보존 · 옛 확인값(치환 전 run·매니페스트 이름) · 플러그인·커맨드 격리 · 같은 이름 두 폴더·파일 이동 ·
 * 세 경로의 키 · 철회 · 홈 층만 · confirm 우선(승인 있음/없음) · 쓰는 순간 재확인 · 동시 갱신 · 저장 실패의 끝(입구까지) · 끄기 대조군·실제 제거 경로 · 다섯 문.
 *
 * 등급: **동작** — 자식 프로세스의 격리 홈에서 진짜 로더·설정 파일·DB(_child-checks.ts).
 */
import { runChildChecks } from "./_child-checks.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "plugin-command-approval",
  guards:
    "플러그인 커맨드 파일(코드 신뢰를 거치지 않은 데이터)이 사용자 모르게 모든 연결 프로젝트에서 셸을 도는 것 — 그리고 한 번 승인이 보지 않은 run 줄·다른 파일·다른 플러그인으로 번지거나, 제거·철회·저장 실패 뒤에도 살아 있는 것",
  run: async (): Promise<Assertion[]> => runChildChecks(new URL("./_plugin-command-approval-child.ts", import.meta.url)),
};
