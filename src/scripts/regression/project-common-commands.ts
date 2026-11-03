/**
 * 회귀: **프로젝트 공통 커맨드** — 한 번 정의하면 연결한 모든 프로젝트의 메뉴에 뜨고 그 프로젝트를 대상으로 돈다(2026-11-03,
 * docs/decisions/2026-11-03-project-common-commands-design.md §7 ①~⑧ · R1 ①②③⑥).
 *
 * 지키는 것: 발견 분할(공통은 전역 목록·봇 메뉴에 없다) · 범위별 동명 공존(분할 → 범위별 중복 제거) · 직접 호출 0/1/N · 공통 프롬프트형의
 * 대상 줄 · 메뉴(코어 표 한 곳 — 텔레그램·브리지 같은 목록) · 위험 액션 두 단계 · 폴더 열기(가짜 opener, 진짜 Finder 0) · 확인 지문(프로젝트·파일) ·
 * 범위 전환 도구 · list_commands·인벤토리.
 *
 * 등급: **동작** — 자식 프로세스의 격리 홈에서 실제 DB·임시 프로젝트·홈 플러그인·실제 셸(_child-checks.ts).
 */
import { runChildChecks } from "./_child-checks.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "project-common-commands",
  guards:
    "모든 프로젝트에 공통인 커맨드를 둘 자리가 없고, 프로젝트 메뉴의 빌트인 항목을 두 채널이 각자 손으로 적던 것 — 그리고 공통을 들이며 생길 범위 누수(오타가 전역 봇 메뉴로)·동명 소실·대상 없는 턴·확인값 재사용",
  run: async (): Promise<Assertion[]> => runChildChecks(new URL("./_project-common-commands-child.ts", import.meta.url)),
};
