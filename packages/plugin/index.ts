// packages/plugin/index.ts
/**
 * **`@tiguclaw/plugin` — 플러그인이 코어를 만지는 유일한 자리** (2026-08-28).
 *
 * ★**왜 생겼나 — 실측이 근거다.** 능력 표면은 이미 거의 다 차 있었는데(위젯·데이터 라우트·
 *  설정·secret·번역 전부 코어 수정 0으로 된다) 서드파티를 막는 건 격리가 아니라 **패키징**
 *  이었다:
 *
 *  ```
 *  홈 = ~/work/tiguclaw-v2/tiguclaw-dev  →  zod·SDK 찾음
 *  홈 = ~/.tiguclaw-devbot                →  ERR_MODULE_NOT_FOUND
 *  ```
 *
 *  돌쇠의 홈이 **레포 안**이라 node 가 상위로 올라가다 레포 `node_modules` 를 주웠을 뿐이다.
 *  홈이 레포 밖인 개발돌쇠·install·윈도우에선 안 된다
 *  ([[feedback_dev_machine_config_leak]] — 내 기계 배치가 제품 가정으로 새던 형태).
 *  같은 뿌리의 둘째 벽이 상대 경로 import(`../../../src/core/...`)였다 — 홈에 놓이면 그
 *  경로 자체가 없어서 **TypeScript 로 플러그인을 쓸 방법이 없었다.**
 *
 * ★**여기 있는 것이 곧 계약이다.** 이 파일에 없는 것을 플러그인이 쓰면 그건 사적 경로이고,
 *  다음 버전에 깨져도 우리가 약속한 바가 아니다. 반대로 **여기 있는 것은 안 깬다.**
 *
 * ★**필요가 증명된 것만 넣는다.** 이 면은 `weather`·`map` 을 실제로 옮기면서 그 둘이 요구한
 *  것으로 채웠다 — 상상으로 칸을 만들면 소비자 없이 계약이 굳는다
 *  ([[feedback_minimal_change_docs]]). 새 칸은 **두 번째 플러그인이 같은 걸 요구할 때** 연다.
 *
 * ★**타입 전용이다 — 런타임을 재수출하지 않는다.** 처음엔 `z`·`tool` 까지 내보내려 했는데
 *  재보니 그게 **빌드·배포 결정**을 끌고 들어온다: 이 패키지의 `main` 은 `index.ts` 라
 *  built 런타임(`dist/`)에서 이름으로 해석이 안 되고, 그걸 풀려면 워크스페이스 링크나
 *  퍼블리시 파이프라인이 필요하다. 타입 전용이면 **컴파일 뒤 import 자체가 사라져서**
 *  런타임 위험이 0이고, 지금 증명된 필요(=TypeScript 로 플러그인을 못 쓴다)는 그대로 풀린다.
 *  런타임 재수출은 **그게 실제로 아플 때** 연다(그때 함께 정할 것: 어떻게 배포하나).
 * ★그래서 플러그인은 `zod`·Agent SDK 를 **직접** import 한다. 홈에 깔린 플러그인은 자기
 *  폴더에서 `npm i` 하면 된다 — 그게 npm 의 보통 동작이고, 우리가 대신 만들 일이 아니다.
 *
 * ★**격리는 여전히 0이다**(설계 §H). 이 면은 격리가 아니라 **격리를 나중에 넣을 수 있게
 *  하는 것**이다 — 표면이 하나면 그때 바꿀 곳이 하나다.
 */

// ── 코어가 주는 것 (타입) ────────────────────────────────────────────────────
export type {
  /** 플러그인이 만질 수 있는 전부. 여기 없는 건 못 한다. */
  PluginHost,
  /** 이 턴이 어느 대화인가(도구 호출에만 있다 — 데이터 라우트엔 없다). */
  PluginTurn,
  /** 매니페스트 `tiguclaw.needs` 의 정규화된 형태. */
  PluginNeeds,
} from "../../src/core/plugins/host.js";

export type {
  /** `getDataRoutes()` 의 반환형 — 위젯이 모델을 안 거치고 값을 받는 길. */
  PluginDataRoutes,
  PluginDataRoute,
  /** 라우트가 **바이트**를 낼 때(지도 타일 등). 이게 아니면 JSON 으로 나간다. */
  PluginMedia,
} from "../../src/core/plugins/data-routes.js";

export type {
  /** 매니페스트 `tiguclaw.settings` 한 칸 — 화면은 이 선언에서 행을 만든다. */
  PluginSettingSpec,
  PluginSettingType,
  PluginSettingValue,
} from "../../src/core/plugins/settings.js";

// ── 도구를 만들 때 쓰는 타입 ────────────────────────────────────────────────
// ★타입만 낸다(위 참조). 값은 플러그인이 `@anthropic-ai/claude-agent-sdk` 에서 직접 받는다.
export type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
