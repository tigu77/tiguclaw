/**
 * 회귀: **플러그인이 실어 오는 훅** (2026-11-03 설계 `docs/decisions/2026-11-03-plugin-hooks-design.md` §9.1).
 *
 * 켜진 플러그인의 `hooks/hooks.json` 이 설치·켜기만으로(승인 없이) 여섯 이벤트에서 홈·프로젝트 훅 **뒤에** 같은 엔진으로 돈다.
 * 지키는 것: 출처 줄 · 치환·환경변수(ROOT ≠ DATA, 데이터 폴더 미생성) · 사용자 훅 우선(먼저 막으면 플러그인 훅 0) · 이름당 한 폴더
 * (홈 안·번들/홈) · 파일 없음 = 조용 · 이름 규칙 · 깨진 파일 격리 · 세 층 공통 항목 판정(null·command 없음·잘못된 timeout·변환 예외 ·
 * 보존 값 0/"5"/1.5) · spawn 동기 예외(NUL) · 실행 수 = 인벤토리 runnable = /status N · 관측 이벤트의 plugin · 끄기·켜기·제거·내용 변경이
 * 다음 호출부터 · 플러그인 훅이 없을 때 /status·/plugins 그대로.
 *
 * 등급: **동작** — 자식 프로세스의 격리 홈에서 진짜 셸 훅(표식 파일로 판정).
 */
import { runChildChecks } from "./_child-checks.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "plugin-hooks",
  guards:
    "플러그인 훅이 끈 뒤에도 돌거나·사용자 훅보다 먼저 돌거나·같은 이름의 다른 폴더 훅이 섞여 출처를 가를 수 없거나·출처 표시 없이 사용자 글로 들어가는 것 — 그리고 훅 항목 하나(null·잘못된 timeout·NUL)가 runHooks 를 거절시켜 뒤 훅(사용자의 차단 훅 포함)까지 막던 기존 결함",
  run: async (): Promise<Assertion[]> => runChildChecks(new URL("./_plugin-hooks-child.ts", import.meta.url)),
};
