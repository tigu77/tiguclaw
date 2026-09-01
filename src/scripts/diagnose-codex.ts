/**
 * diagnose-codex — **가벼운 요청 vs 무거운 요청** A/B (2026-07-30, 2026-07-31 중복 제거).
 *
 * 왜 있나: 회사 인스턴스에서 codex 가 `error/server_is_overloaded` 로 계속 실패하는데
 * **공식 Codex CLI 는 같은 계정·같은 머신에서 정상**이었다. 남은 가설이
 * "부하 시 **무겁고 낯선 요청**이 먼저 셰딩된다" 였고, 그걸 가르려고 만들었다.
 *
 * 판정:
 *   LEAN 성공 + HEAVY 실패 → **무게가 원인**. 도구 축소·instructions 분할이 실효 대책.
 *   둘 다 실패            → 계정·클라이언트 식별 쪽. 경량화로는 못 푼다.
 *   둘 다 성공            → 그 순간은 정상(백엔드 회복). 실패 중에 다시 돌릴 것.
 *
 * ★이 파일은 **껍데기다.** 본체는 `core/llm-runtime/codex-weight-probe.ts` 하나이고
 *  `/diagnose` 슬래시 명령과 **같은 함수**를 쓴다.
 *  이전 판은 자기 `send()`·상수·판정 로직 사본(약 200줄)을 갖고 있었다. 그런데 커밋
 *  메시지엔 이미 "같은 함수를 쓴다(판정 기준 사본 0)" 라고 적혀 있었다 — **거짓이었다.**
 *  그 대가로 `/diagnose` 에만 시한을 넣었을 때 이 셸 경로는 **20분 매달림이 그대로**였다
 *  (검토 지적, 2026-07-31). 같은 판단이 두 곳에 있으면 한 곳만 고치게 된다.
 *
 * 실행: `npm run diagnose:codex`  (원격 접속 불가 인스턴스에서 사용자가 직접)
 * 부작용 0 — 도구 미등록·짧은 응답만 요청하고 결과를 저장하지 않는다.
 */
import path from "node:path";
import { loadHomeEnv } from "../core/load-env.js";
import { runCodexWeightProbe } from "../core/llm-runtime/codex-weight-probe.js";
import { getEventBus } from "../core/eventbus.js";
import { loadPlugins } from "../core/plugins/loader.js";
import { wirePlugin } from "../core/plugins/wire.js";
import { appRoot } from "../core/paths.js";

/**
 * **부팅이 하는 인증 배선을 그대로 만든다** (2026-09-01).
 *
 * ★종전엔 `import "../core/llm-runtime/auth-providers.js"` 한 줄이었는데, 그 파일은 구독
 *  인증을 플러그인으로 빼면서 **삭제됐다.** `tsc` 는 **부작용 import 를 검사하지 않아서**
 *  (값을 import 해야 TS2307 — 실측) 타입체크·빌드·회귀가 전부 초록이었고, dev 기계에서만
 *  낡은 `dist` 산출물이 가려주고 있었다. 깨끗한 설치에선 이 스크립트가
 *  ERR_MODULE_NOT_FOUND 로 죽는다 — 그리고 이 파일은 **public 에 배포된다.**
 *
 * ★등록을 여기서 직접 부르지 않는다 — 그러면 «누가 등록하나» 가 두 곳이 되고, 규칙이
 *  갈리는 순간 한쪽 사용자만 조용히 로그아웃된다. **플러그인이 진실 소스**이므로 부팅과
 *  같은 것을 로드한다.
 * ★단 `needs.auth` 를 선언한 것만 배선한다 — 전부 배선하면 http-bridge 가 포트를 잡고
 *  텔레그램 폴링까지 떠서 **라이브 데몬과 충돌**한다(회귀가 같은 이유로 같은 필터를 쓴다).
 */
const wireAuthPlugins = async (): Promise<void> => {
  const all = await loadPlugins(path.join(appRoot(), "plugins"), getEventBus());
  const authOnly = all.filter((lp) => Array.isArray(lp.manifest.needs?.auth));
  for (const lp of authOnly) {
    await wirePlugin(lp, { bus: getEventBus(), channels: [], serviceStops: [] });
  }
};

const main = async (): Promise<void> => {
  loadHomeEnv();
  await wireAuthPlugins();
  console.log(
    "codex 요청 무게 A/B — 같은 auth·같은 엔드포인트로 LEAN/HEAVY 를 번갈아 2라운드.\n",
  );
  const { lines, verdict } = await runCodexWeightProbe();
  for (const l of lines) console.log(l);
  console.log(`\n→ ${verdict}`);
  // 토큰·프로바이더 부재는 verdict 가 🔴 로 시작한다 — 셸에서 실패로 보이게 종료코드를 준다.
  if (verdict.startsWith("🔴")) {
    console.log(
      '\n   데몬이 쓰는 홈과 다를 수 있습니다 — 데몬 로그 첫 줄의 "tiguclaw home:" 값을 확인해\n' +
        "   같은 홈으로 다시 실행하세요:\n" +
        "     TIGUCLAW_HOME=<그 경로> npm run diagnose:codex        (mac/linux)\n" +
        "     $env:TIGUCLAW_HOME='<그 경로>'; npm run diagnose:codex  (Windows PowerShell)",
    );
    process.exit(1);
  }
};

void main();
