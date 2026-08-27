// src/core/claude-cli.ts
/**
 * **번들된 Claude Code 실행기 찾기** (2026-08-27 사용자 지적).
 *
 * ★사실관계부터 — 내가 처음에 틀렸다. `@anthropic-ai/claude-agent-sdk` 는 Claude Code 를
 *  **함께 깐다**: 플랫폼별 optional 의존(`@anthropic-ai/claude-agent-sdk-<플랫폼>`)에 실제
 *  `claude` 바이너리(실측 259MB)가 들어 있다. 압축된 래퍼가 4.1MB 라 "번들 안 한다" 고
 *  단정했는데, `PATH` 를 비우고 SDK 를 돌려도 정상 기동한다(실증).
 *
 * ★그리고 그 바이너리엔 **`setup-token` 이 있다**(실측: `claude setup-token --help` 동작).
 *  즉 `npm ci` 가 끝난 순간 구독 토큰 발급 수단이 **이미 손안에 있다.** 종전 안내
 *  (`npm i -g @anthropic-ai/claude-code`)는 같은 259MB 를 **한 번 더** 받게 만든다.
 *
 * ★자리 규칙은 ripgrep 과 같다 — **우리가 부르는 것은 우리가 찾는다.** 다만 여긴 받아올
 *  필요가 없다(이미 의존성으로 온다). 없을 수 있는 경우는 둘뿐이고 둘 다 정직하게 알린다:
 *  ①`--no-optional`·`--omit=optional` 로 설치했다 ②지원 안 하는 플랫폼/아키텍처.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 플랫폼별 실행파일 이름. */
const binName = (): string => (process.platform === "win32" ? "claude.exe" : "claude");

/**
 * `node_modules/@anthropic-ai/claude-agent-sdk-*` 중 실행기를 든 것.
 *
 * ★패키지 이름을 **열거하지 않는다**(8종 + 앞으로 늘어난다). 디렉터리를 훑어 **실행기가
 *  있는가**로 판정한다 — 손 목록이 드리프트하는 부류를 애초에 안 만든다
 *  ([[feedback_hand_maintained_lists]]).
 */
export const findBundledClaude = (fromDir?: string): string | null => {
  const here = fromDir ?? path.dirname(fileURLToPath(import.meta.url));
  const bin = binName();
  // 이 파일에서 위로 올라가며 node_modules 를 찾는다(레포·설치본·dist 어디서 불려도 같다).
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const scope = path.join(dir, "node_modules", "@anthropic-ai");
    if (existsSync(scope)) {
      let entries: string[];
      try {
        entries = readdirSync(scope);
      } catch {
        entries = [];
      }
      for (const e of entries) {
        if (!e.startsWith("claude-agent-sdk-")) continue;
        const p = path.join(scope, e, bin);
        try {
          if (statSync(p).isFile()) return p;
        } catch {
          /* 다음 후보 */
        }
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
};

/**
 * 없을 때 사용자에게 할 말 — **한 곳에서만** 만든다(doctor·온보드·에러가 같은 말을 하게).
 *
 * ★전역 설치를 권하지 않는다. 같은 것을 두 벌 받게 되고, 그러면 버전이 갈려서 "어느 쪽이
 *  도는지" 를 아무도 모르게 된다. 진짜 원인 둘을 그대로 말한다.
 */
export const bundledClaudeMissingHint = (): string =>
  "Claude Code 실행기를 못 찾았습니다 — 보통 `npm ci` 가 의존성으로 같이 깝니다. " +
  "`--omit=optional` 로 설치했다면 그 옵션 없이 다시 설치하세요. " +
  "지원 안 하는 플랫폼이면 `npm i -g @anthropic-ai/claude-code` 로 따로 설치할 수 있습니다.";
