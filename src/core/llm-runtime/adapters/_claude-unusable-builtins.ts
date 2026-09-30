/**
 * **tiguclaw 안에서 쓸 수 없는 Claude SDK 빌트인** — 요청에 싣지 않는다 (2026-09-30).
 *
 * ★왜: SDK 는 Claude Code 자체 작업 흐름용 빌트인을 매 호출 싣는다. 첫 요청을 가로채 재니 빌트인 도구가
 *  28.6K 토큰인데, 그중 파일·웹(Read·Write·Edit·NotebookEdit·WebFetch·WebSearch)은 3.6K 뿐이었다. 아래는
 *  tiguclaw 에서 **동작하지 않거나(실측) · 거짓 약속이 되거나(실측) · 이미 우리 길로 일원화한 것**만 모았다.
 *  합 약 19K 토큰/호출(opus-5-5 count_tokens). 쌩 Claude Code 도 같은 도구를 싣지만 거기선 동작한다 — 우리에겐 값이 0이다.
 * ★판정 = 가짜 Anthropic 서버가 도구 호출을 내려보내고 tiguclaw 가 돌려준 **도구 결과**(모델 호출 0, 2026-09-30):
 *   - `CronCreate`: «Scheduled … **Session-only (dies when Claude exits)**». 턴마다 SDK 프로세스가 끝나니 한 번도
 *     안 울린다 — 비서가 «알림 걸어 뒀어요» 라고 거짓 약속을 한다. 영속 일정은 스케줄러(`add_schedule`)가 한다.
 *   - `LSP`: «No LSP server available for file type: .ts» — 서버는 CC 플러그인이 주는데 우리는 SDK 격리 모드다.
 *   - `PushNotification`: «Not sent — this terminal is active …» — 데몬엔 터미널이 없는데 늘 이 답이다.
 *     사용자에게 닿는 길은 채널(텔레그램·대시보드)이다.
 *   - `Workflow`: 백그라운드로 뜨고 기록은 `~/.claude/projects` 에 쌓인다 — SDK 서브에이전트(08-08 차단,
 *     `withSdkSubagentsBlocked`)와 같은 병(관측·스티어·취소 0 · claude 전용 · 풀/폴백 상실). 팬아웃은 우리 매니저가 한다.
 *   - `ScheduleWakeup`: CC `/loop` 전용 · `DesignSync`: CC `/design-sync` 스킬 전용(SDK 스킬 도구는 막혀 있다) ·
 *     `ReportFindings`: CC 코드리뷰 화면 전용 — 셋 다 그 진입점이 tiguclaw 에 없다(설명에 그렇게 적혀 있다).
 * ★**남긴 것**(능력이 있거나 확인 못 함 — «능력 손실 금지»): `SendMessage`·`ListAgents`(실측: 사용자의 다른 Claude
 *  Code 세션이 보인다 = 실제 세션 간 메시지) · `Monitor` · `EnterWorktree`·`ExitWorktree` · 파일·웹 도구.
 * ★SDK 를 올리면 새 빌트인이 늘 수 있다 — 여기 없으면 그대로 실린다(안전한 쪽). 배선·목록은 회귀
 *  `claude-request-tool-set` 이 본다(회귀는 실제 SDK 를 못 띄운다 — 요청 실측은 이 주석의 가짜 서버 캡처가 근거다).
 */
export const SDK_UNUSABLE_TOOL_NAMES = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "LSP",
  "PushNotification",
  "Workflow",
  "ScheduleWakeup",
  "DesignSync",
  "ReportFindings",
] as const;
