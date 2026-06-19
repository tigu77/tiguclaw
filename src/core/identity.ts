/**
 * 영역 코어 — 정체성 read (AGENT.md / SYSTEM.md).
 *
 * memory.ts 분해(7b)로 추출 — 동작 무변경, 순수 이동.
 *  - `readAgent` / `agentSizeWarning` / `agentPathHint` / `AGENT_SIZE_WARN_BYTES`:
 *    1층 self markdown (런타임 홈의 인격 hub).
 *  - `readSystem`: 작동 헌법(SYSTEM.md) 매 turn prepend 소스.
 */
import fs from "node:fs";
import { getPaths } from "./paths.js";

// ─── AGENT.md (1층 self markdown) — 런타임 홈의 인격 hub ──────────────────
// CC 의 CLAUDE.md 와 동형 패턴. 매 turn 자동 prepend. 비서가 SDK Read 도구로
// 본문 안에서 reference 한 하위 markdown 을 lazy import — AGENT.md 는 hub.
// V9.4 — 경로를 `getPaths().agentMd`(런타임 홈) 로 lazy 호출. 이전 `process.cwd()/AGENT.md`
//  const 는 모듈 로드 시점(ensureHome 이전) 평가 위험이 있어 제거. readAgent 가 매 turn
//  런타임 시점에 호출되고 getPaths 는 freeze 캐시라 재계산 비용 0.
export const AGENT_SIZE_WARN_BYTES = 4096;

/** 파일이 없으면 빈 문자열, 있으면 본문. fs 예외는 빈 문자열로 swallow. */
export const readAgent = (): string => {
  try {
    return fs.readFileSync(getPaths().agentMd, "utf8");
  } catch {
    return "";
  }
};

// ─── SYSTEM.md (작동 헌법) — 언제나 로드 (2026-05-27) ──────────────────────
// 사용자 결정: SYSTEM.md 는 on-demand Read 가 아니라 *매 turn 항상* user prompt 앞에
// prepend 되는 소스다 (AGENT.md 와 동급 상시 컨텍스트). 부팅 시 syncSystemMd 가 앱
// 정본을 `<home>/SYSTEM.md` 로 미러하므로 그 미러를 읽는다. 양 어댑터(claude·codex)가
// 동일하게 prepend 해 LLM parity 유지. 부재 시 빈 문자열 (헌법 미러 실패해도 turn 생존).
export const readSystem = (): string => {
  try {
    return fs.readFileSync(getPaths().systemMd, "utf8");
  } catch {
    return "";
  }
};

/**
 * AGENT.md 실제 경로 1줄 안내 — 매 turn prepend.
 * V9.4 후 readAgent 는 `<home>/AGENT.md` 를 읽는데, 비서의 파일 도구 cwd 는
 * `process.cwd()`(데몬 cwd) 라 "AGENT.md" 만으로 Edit 하면 엉뚱한 파일에 써질 수
 * 있다(home ≠ cwd 시). 데몬만 아는 절대 경로를 알려줘 자기 정체성 편집이 실제로
 * readAgent 가 읽는 파일에 반영되게 한다. (prod 에서 home 이 file-ops 샌드박스 밖이면
 * 편집 제약 — V10 file-ops 샌드박스 분리 후속.)
 */
export const agentPathHint = (): string =>
  `> [system] 당신의 AGENT.md 실제 경로: \`${getPaths().agentMd}\` — 이름·말투·습관 등 정체성 갱신은 *이 경로* 를 \`Edit\`/\`Write\` 하세요 (데몬이 매 turn 이 파일을 읽어 prepend). 레포 루트의 AGENT.md 가 아닙니다.`;

/** body 가 4096B 초과 시 한 줄 경고, 그 외 빈 문자열. */
export const agentSizeWarning = (body: string): string => {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= AGENT_SIZE_WARN_BYTES) return "";
  return `> [system] AGENT.md 가 ${AGENT_SIZE_WARN_BYTES}B 초과합니다 (현재 ${bytes}B). 하위 markdown(예: \`<TIGUCLAW_HOME>/data/agent/<topic>.md\`)으로 분할하고 AGENT.md 본문에서 reference 만 남기는 것을 고려하세요. 비서가 필요 시 \`Read\` 도구로 자동 불러옵니다.`;
};
