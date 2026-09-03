// src/core/plugins/manager.ts
/**
 * **돌고 있는 플러그인을 켜고 끄는 자리** — 재부팅 없이 (2026-08-28).
 *
 * ★정태님: *"실제로 대시보드에서 외부 플러그인을 설치한다고 했을 때 재부팅 없이 가능한
 *  거야? 목록을 보여주고 설치 및 제거하는 거지. 이게 돼야 진짜 맞는 거잖아."* — 맞다.
 *  **재부팅이 필요하면 그건 설치가 아니라 배포다.**
 *
 * ★재보니 절반은 이미 됐다: 자산은 요청마다 디스크를 읽고, 위젯 빌더는 지연 로드되고,
 *  MCP 레지스트리는 **턴마다** 읽히므로 새 도구가 다음 턴에 보인다. 없던 건 **되돌리는
 *  길**이었다 — 레지스트리에 넣기만 하고 빼는 함수가 0이었고, *"이 플러그인이 무엇을
 *  등록했나"* 를 아무도 안 적어 뒀다. 그건 `wirePlugin` 이 `dispose` 를 돌려주게 해서 풀었다.
 *
 * ★**정직한 한계 둘**:
 *  ① **코드는 안 사라진다.** ESM 은 언로드가 없다 — 제거는 *"더 이상 불리지 않는다"* 까지고,
 *     이미 잡힌 클로저·참조는 프로세스에 남는다. 진짜 언로드는 프로세스 경계가 필요하다(§H).
 *  ② **갱신은 캐시를 우회해야 한다.** 같은 경로를 다시 `import` 하면 **같은 객체**다(실측).
 *     그래서 재설치는 URL 에 지문을 붙인다. 옛 인스턴스가 남긴 타이머·리스너는 `stop` 이
 *     회수해야 하고, 안 하면 새는 건 플러그인 책임이다 — 그래서 `stop` 이 계약이다.
 */
import {
  loadPlugins,
  scanPluginManifests,
  type LoadedPlugin,
  type PluginMeta,
} from "./loader.js";
import { wirePlugin, type WirePluginDeps, type WireResult } from "./wire.js";
import { describeNeeds, needsFacts, type NeedFact } from "./host.js";
import { bundledDeclaredNames, isCoreModule, isSelfReferentialModule } from "./inventory.js";
import { settingsForClient } from "./settings.js";
import { appRoot, getPaths } from "../paths.js";
import { setModuleDisabled } from "../settings.js";
import path from "node:path";

export interface LivePlugin {
  readonly name: string;
  /** 어디서 왔나 — `bundled`(앱과 함께) 또는 `home`(사용자가 깐 것). */
  readonly source: "bundled" | "home";
  readonly dir: string;
  readonly capabilities: readonly string[];
  /** 플러그인 자기 버전 — 목록에 보여주고, 갱신 여부를 사람이 판단하는 근거. */
  readonly version?: string;
  /** 사람이 읽는 요구사항 한 줄 — 목록·설치 안내가 **같은 문장**을 쓴다. */
  readonly needs: string;
  /**
   * 같은 선언의 **데이터 판** — 화면이 자기 언어로 그린다.
   *
   * ★위 `needs` 문장과 **한 곳(`needsFacts`)에서 같이 나온다.** 문장만 있던 시절 영어
   *  사용자가 목록에서 한국어를 봤고, 하필 `docs/security.ko.md §2` 가 *"설치 전에 여기서
   *  읽으세요"* 라고 가리키는 면이었다.
   */
  readonly needsFacts: readonly NeedFact[];
  readonly wired: readonly string[];
  readonly dispose: () => Promise<void>;
}

const LIVE = new Map<string, LivePlugin>();

/**
 * 배선 재료 — 부팅이 한 번 준다.
 *
 * ★인자로 들고 다니지 않는 이유: 설치·켜기를 부르는 곳은 **브리지 엔드포인트**인데 거기엔
 *  `bus`·`channels`·`serviceStops` 가 없다. 호출부마다 넘기게 하면 그 세 개가 코드 여기저기로
 *  퍼지고, 그게 나중에 격리를 넣을 때 걷어내야 할 결합이 된다. 한 곳에 둔다.
 */
let DEPS: WirePluginDeps | undefined;

/** 부팅이 배선 재료를 넘겨준다. 이게 없으면 런타임 설치·켜기가 안 된다(정직하게 거절). */
export const initPluginManager = (deps: WirePluginDeps): void => {
  DEPS = deps;
};

const needDeps = (): WirePluginDeps => {
  if (DEPS === undefined) {
    throw new Error("플러그인 관리자가 아직 준비되지 않았습니다(부팅 중일 수 있습니다)");
  }
  return DEPS;
};

/** 부팅 배선이 끝난 플러그인을 등록한다 — 그래야 나중에 뺄 수 있다. */
export const trackPlugin = (
  lp: LoadedPlugin,
  source: "bundled" | "home",
  wired: WireResult,
): void => {
  LIVE.set(lp.manifest.name, {
    name: lp.manifest.name,
    source,
    dir: lp.pluginDir,
    capabilities: lp.capabilities,
    ...(lp.manifest.version !== undefined ? { version: lp.manifest.version } : {}),
    needs: describeNeeds(lp.manifest.needs ?? {}),
    // ★화면이 번역할 수 있게 **데이터도** 싣는다 — 위 문장은 로그·폴백용이다.
    needsFacts: needsFacts(lp.manifest.needs ?? {}),
    wired: wired.wired,
    dispose: wired.dispose,
  });
};

/** 지금 돌고 있는 것. */
export const listLivePlugins = (): LivePlugin[] => [...LIVE.values()];

export interface PluginListItem {
  readonly name: string;
  readonly source: "bundled" | "home";
  readonly version?: string;
  readonly needs: string;
  readonly needsFacts: readonly NeedFact[];
  /**
   * 끌 수 없는 것인가 — 화면이 **토글을 아예 안 만들게** 한다.
   * ★거절만 하면 사용자는 눌러보고서야 안다. 못 하는 걸 할 수 있는 것처럼 보여주지 않는다.
   */
  readonly core: boolean;
  /** 끄면 지금 보고 있는 화면이 사라지는가 — 화면이 확인을 받는 근거(막지는 않는다). */
  readonly selfReferential: boolean;
  readonly capabilities: readonly string[];
  readonly wired: readonly string[];
  /** 지금 돌고 있나. 꺼진 것도 목록엔 나온다(안 그러면 다시 못 켠다). */
  readonly enabled: boolean;
  /** 사람이 알아야 할 것(설명·만든 사람·링크·라이선스) — npm 표준 필드에서 온다. */
  readonly meta: PluginMeta;
  /**
   * 설정 **선언 + 현재 값** — 화면은 이걸로 행을 만든다(§D.2).
   *
   * ★`secret` 은 값을 안 싣는다(`hasSecret` 만). 이 응답은 브라우저로 나간다.
   */
  readonly settings: ReturnType<typeof settingsForClient>;
}

/**
 * **꺼진 것까지 포함한 목록** — 대시보드가 이걸 본다.
 *
 * ★`LIVE` 만 보여주면 끄는 순간 사라져 **다시 켤 수가 없다**(일방통행 문). 그래서 두 뿌리의
 *  매니페스트를 훑되, **코드는 실행하지 않는다**(`scanPluginManifests`).
 * ★같은 이름이면 **번들이 이긴다** — 로더·자산 라우트와 같은 우선순위다.
 */
/**
 * 플러그인 조작(설치·제거·켜기·끄기)의 **공통 응답**.
 *
 * ★한 모양을 **세 곳이 각자 적고 있었다** — 그래서 번역 키를 다는데 두 곳이 조용히 빠졌다
 *  (2026-08-30, 적대 검토 C조 C3). 계약은 한 번만 적는다.
 *
 * ★`reason` 은 **로그·폴백용 한 문장**이고, `reasonKey` 가 화면이 자기 언어로 그리는
 *  근거다. 종전엔 문장만 있어서 영어 사용자가 토스트에서 한국어를 만났다 — `needsFacts`
 *  때 이미 겪고 고친 것과 **같은 부류**다(문장만 실으면 그 언어가 곧 화면 언어가 된다).
 */
export interface PluginActionResult {
  ok: boolean;
  reason?: string;
  reasonKey?: string;
  reasonArgs?: Record<string, string>;
}

/**
 * **이 이름은 번들 것인가 — 디스크가 답한다.**
 *
 * ★사고(2026-08-30, 적대 검토 B-1): 같은 질문에 **두 답**이 있었다. 부팅은 디스크를 봤고
 *  (`bundledNames`), 설치 문은 **돌고 있는 것**을 봤다(`LIVE.get(name)?.source`). 그래서
 *  번들 쌍둥이가 꺼져 있으면 홈 플러그인이 그 이름으로 들어왔다. 실측 재현:
 *
 *  ```
 *  실제로 도는 것: home · 9.9.9-EVIL · network:attacker.test + outbound
 *  화면의 그 행 : bundled · 0.1.0 · "외부 미선언(모름)"
 *  ```
 *
 *  이름·버전만 틀린 게 아니라 **권한 표시가 틀렸다** — 화면은 "밖으로 아무것도 안 합니다"
 *  라고 하는데 나가겠다고 선언한 코드가 돌고 있었다. `docs/security.ko.md §2` 가 "목록에서
 *  출처가 보입니다" 라고 약속하는 바로 그 자리다.
 *
 * ★**로드 성공이 아니라 이름의 존재**로 판정한다. 종전 부팅 판정은 *로드에 성공한* 번들만
 *  셌으므로, 번들 하나가 깨지면 그 이름이 홈에 열렸다. 번들 이름은 예약된 것이지
 *  그날 잘 떴느냐에 달린 게 아니다.
 *
 * ★**답은 `bundledDeclaredNames` 한 곳에만 있다** (2026-08-30, 3라운드 D-3). 종전엔 여기서
 *  `scanPluginManifests` 를 따로 불렀는데 그건 **스키마를 통과해야** 이름이 산다 — 실측으로
 *  번들 하나의 `entry` 한 줄을 지우니 예약이 10→9 로 줄어 그 이름이 열렸고, 같은 순간
 *  `isSelfReferentialModule` 은 여전히 `true` 였다. 위에서 없앤 *"같은 질문에 두 답"* 이
 *  한 겹 아래서 그대로 난 것이다.
 */
export const bundledPluginNames = async (): Promise<Set<string>> => bundledDeclaredNames();

export const listAllPlugins = async (): Promise<PluginListItem[]> => {
  const roots: Array<{ root: string; source: "bundled" | "home" }> = [
    { root: path.join(appRoot(), "plugins"), source: "bundled" },
    { root: getPaths().commonPlugins, source: "home" },
  ];
  const seen = new Map<string, PluginListItem>();
  for (const { root, source } of roots) {
    for (const m of await scanPluginManifests(root)) {
      if (seen.has(m.manifest.name)) continue; // 번들이 먼저다.
      const live = LIVE.get(m.manifest.name);
      seen.set(m.manifest.name, {
        name: m.manifest.name,
        source,
        ...(m.manifest.version !== undefined ? { version: m.manifest.version } : {}),
        needs: describeNeeds(m.manifest.needs ?? {}),
        needsFacts: needsFacts(m.manifest.needs ?? {}),
        core: isCoreModule(m.manifest.name),
        // 끄면 이 화면이 사라진다 — 화면이 **확인을 받을 근거**(막지는 않는다).
        selfReferential: isSelfReferentialModule(m.manifest.name),
        meta: m.manifest.meta ?? {},
        capabilities: m.capabilities,
        wired: live?.wired ?? [],
        enabled: live !== undefined,
        settings: settingsForClient(m.manifest.name, m.manifest.settings ?? []),
      });
    }
  }
  return [...seen.values()];
};

/**
 * 제거 — 등록한 것을 전부 되돌리고 목록에서 뺀다.
 *
 * ★**번들은 못 뺀다.** 앱과 함께 오는 것을 런타임에 끄면 되돌릴 길이 애매해지고, 그건
 *  `modules.disabled`(설정) 의 일이다 — 그쪽은 재부팅 시 반영되고 기록으로 남는다.
 *  [[project_self_dev_flag_gate]] 와 같은 결: 되돌릴 수 없게 만들지 않는다.
 */
export const removePlugin = async (
  name: string,
): Promise<PluginActionResult> => {
  const live = LIVE.get(name);
  if (live === undefined) return { ok: false, reason: "그런 플러그인이 없습니다", reasonKey: "plugins.reason.unknown" };
  if (live.source === "bundled") {
    return {
      ok: false,
      reason: "번들 플러그인은 제거하지 않습니다 — 설정의 모듈 비활성으로 끄세요.",
      reasonKey: "plugins.reason.bundledNoRemove",
    };
  }
  // ★**기록을 먼저** 쓴다 — `setPluginEnabled` 와 같은 규율이다(비가역을 뒤로: 던지면
  //  아무 일도 안 일어난다). 종전엔 여기 기록이 **아예 없어서** 「제거」가 재시작까지만
  //  유효했다: 폴더는 남고(확인 문구도 그렇게 말한다) 로더가 다시 스캔해 **되살아났다.**
  //  사용자는 껐다고 믿는데 업데이트·크래시 복구 한 번에 그 플러그인이 다시 돈다.
  setModuleDisabled(name, true);
  await live.dispose();
  LIVE.delete(name);
  console.log(`[plugin-manager] 제거: ${name} (배선 해제 + 비활성 기록 — 폴더는 남는다)`);
  return { ok: true };
};

/**
 * 끄기·켜기 — **재부팅 없이**, 그리고 설정에 기록한다 (2026-08-28).
 *
 * ★제거와 다르다: 폴더는 그대로 두고 **배선만 걷는다.** 그래서 **번들에도 된다** —
 *  번들은 제거할 수 없지만 끌 수는 있고, 그게 사용자가 실제로 원하는 것이다.
 * ★기록이 있어야 재부팅 뒤에도 유지된다 — `settings.json` 의 `modules` 가 그 자리다
 *  (없으면 켜짐 · 어느 레이어든 `enabled:false` 면 꺼짐).
 * ★**서버 코드 변경은 이걸로 못 고친다.** 껐다 켜도 ESM 캐시 때문에 옛 코드가 돈다
 *  (실측: 엔트리만 무효화하면 하위 모듈은 옛것 그대로 — 반만 새것인 상태가 더 나쁘다).
 *  그건 프로세스 경계가 필요하고, 그래서 **갱신과 격리는 같은 문제**다(설계 §H).
 */
export const setPluginEnabled = async (
  name: string,
  enabled: boolean,
): Promise<PluginActionResult & { codeReloaded: boolean }> => {
  // ★**가드를 맨 앞에** 둔다 (2026-08-30, 적대 검토 C조 P1). 두 가지가 같이 걸린다:
  //  ①`setModuleDisabled` 로 가는 문이 **둘**이었는데 거절은 `routes-settings.ts` 에만
  //   있었다 — 플러그인 화면은 그냥 통과해 **브리지가 실제로 꺼졌다**(재시작 전까지
  //   대시보드 API 사망). 문마다 달면 세 번째 문에서 또 샌다 → 판정 자리로 내렸다.
  //  ②그 판정은 **아무 의존도 필요 없다.** `needDeps()` 뒤에 두면 부팅 중엔 거절이 아니라
  //   "관리자 미준비" 로 떨어지고, 데몬 없이는 검사도 못 한다.
  if (!enabled && isCoreModule(name)) {
    return {
      ok: false,
      reason: `${name} 은(는) 끌 수 없습니다 — 끄면 다시 켤 화면 자체가 사라집니다.`,
      reasonKey: "plugins.reason.core",
      reasonArgs: { name },
      codeReloaded: false,
    };
  }
  const deps = needDeps();
  const live = LIVE.get(name);
  if (!enabled) {
    // ★**가드를 문이 아니라 여기 둔다** (2026-08-30, 적대 검토 C조 P1). 종전엔 거절이
    //  `routes-settings.ts`(모듈 화면)에만 있었는데 `setModuleDisabled` 로 가는 문이 **둘**
    //  이었다 — 플러그인 화면(`/plugins/action`)은 그냥 통과해서 **브리지를 끌 수 있었다**
    //  (재시작 전까지 대시보드 API 사망). 문마다 달면 세 번째 문에서 또 샌다.
    if (live === undefined) return { ok: false, reason: "그런 플러그인이 없습니다", reasonKey: "plugins.reason.unknown", codeReloaded: false };
    // ★**기록을 먼저** 쓴다 (2026-08-29, 적대 검토 P-2). 종전엔 `dispose()` → `LIVE.delete`
    //  → 기록 순서였는데, 설정 파일이 깨져 있으면 마지막 줄이 던져 **배선은 걷혔는데 기록은
    //  안 남는** 반쪽 상태가 됐다: 사용자는 실패(500)를 받고, 플러그인은 지금 꺼져 있고,
    //  재시작하면 되살아난다. 비가역인 쪽을 뒤에 둔다 — 던지면 아무 일도 안 일어난다.
    setModuleDisabled(name, true);
    await live.dispose();
    LIVE.delete(name);
    console.log(`[plugin-manager] 끔: ${name}`);
    return { ok: true, codeReloaded: false };
  }
  // 켜기 — 설정을 먼저 되돌려야 로더의 `isModuleActive` 가 통과시킨다.
  setModuleDisabled(name, false);
  if (live !== undefined) return { ok: true, codeReloaded: false }; // 이미 돌고 있다.
  const roots: Array<{ root: string; source: "bundled" | "home" }> = [
    { root: path.join(appRoot(), "plugins"), source: "bundled" },
    { root: getPaths().commonPlugins, source: "home" },
  ];
  for (const { root, source } of roots) {
    // ★**해제를 `loadPlugins` 앞에** 둔다 (2026-08-30, 적대 검토 2R B-3). 처음엔 뒤에
  //  뒀는데 그 기록을 읽는 게이트가 **`loadPlugins` 안**에 있다(`isModuleActive` →
  //  `skip <name>: user-disabled`). 해제가 **자기를 막는 문 뒤에** 있었던 것이다 —
  //  그래서 제거했다 다시 설치하면 멀쩡한 폴더를 두고 *"유효한 플러그인을 못 찾았습니다"*
  //  라고 답했다. 내가 고치려던 것보다 나쁜 결과였다(꺼진 채 뜨는 게 아니라 아예 실패).
  //
  //  ★**설치는 "켜라"는 뜻이다.** 훑어서 지우지 않는다 — 홈이 일시적으로 비면 사용자의
  //  결정을 날린다. 사용자가 지금 요청한 **그 이름 하나만**.
  setModuleDisabled(name, false);
  const found = (await loadPlugins(root, deps.bus)).find((p) => p.manifest.name === name);
    if (found === undefined) continue;
    const wired = await wirePlugin(found, deps);
    trackPlugin(found, source, wired);
    console.log(`[plugin-manager] 켬: ${name} (${source}) · ${describeNeeds(found.manifest.needs ?? {})}`);
    // ★**코드는 새로 안 읽혔다** — ESM 캐시가 옛 모듈을 준다. 정직하게 알린다.
    return { ok: true, codeReloaded: false };
  }
  return {
    ok: false,
    reason: `${name} 을(를) 어느 뿌리에서도 못 찾았습니다`,
    reasonKey: "plugins.reason.notFoundAnywhere",
    reasonArgs: { name },
    codeReloaded: false,
  };
};

/**
 * 설치 — `<home>/plugins/<name>` 을 지금 읽어 배선한다(재부팅 없이).
 *
 * @param name 홈 플러그인 폴더 이름. 폴더는 **이미 거기 있어야** 한다 — 이 함수는 파일을
 *   가져오지 않는다(원격 다운로드는 격리 이후다, 설계 §H).
 *
 * ★같은 이름이 이미 살아 있으면 **먼저 되돌린다** — 그게 "재설치" 다.
 * ★번들과 이름이 겹치면 거부한다: 홈에서 코어 플러그인을 가로채는 건 공격면이다.
 */
export const installHomePlugin = async (
  name: string,
): Promise<
  PluginActionResult & {
    needs?: string;
    needsFacts?: readonly NeedFact[];
    wired?: readonly string[];
  }
> => {
  const deps = needDeps();
  // ★**돌고 있는 것이 아니라 디스크에 있는 이름**을 본다 — 번들 쌍둥이가 꺼져 있거나 로드에
  //  실패한 순간 이 문이 열려 있었다(B-1). 부팅과 같은 판정을 쓴다.
  if ((await bundledPluginNames()).has(name)) {
    return { ok: false, reason: "같은 이름의 번들 플러그인이 있습니다(번들이 이깁니다)", reasonKey: "plugins.reason.nameReserved" };
  }
  // ★**해제를 `loadPlugins` 앞에** 둔다 (2026-08-30, 적대 검토 2R B-3). 처음엔 뒤에
  //  뒀는데 그 기록을 읽는 게이트가 **`loadPlugins` 안**이다(`isModuleActive` →
  //  `skip <name>: user-disabled`). 해제가 **자기를 막는 문 뒤에** 있었던 것 — 그래서
  //  제거했다 다시 설치하면 멀쩡한 폴더를 두고 *"유효한 플러그인을 못 찾았습니다"* 라고
  //  답했다. 내가 고치려던 것(꺼진 채 뜸)보다 **나쁜 결과**였다.
  //
  //  ★훑어서 지우지 않는다 — 홈이 일시적으로 비면 사용자 결정을 날린다. 지금 요청한
  //  **그 이름 하나만**.
  setModuleDisabled(name, false);
  const root = getPaths().commonPlugins;
  // ★로더를 **그대로 쓴다** — 매니페스트 검사·권한 파싱·클래스 요구가 부팅과 같은 판정이어야
  //  한다. 여기서 따로 읽으면 그게 두 번째 사본이고, 둘은 반드시 갈린다.
  const found = (await loadPlugins(root, deps.bus)).find((p) => p.manifest.name === name);
  if (found === undefined) {
    return {
      ok: false,
      reason: `${path.join(root, name)} 에서 유효한 플러그인을 못 찾았습니다(로그에 사유가 있습니다)`,
      reasonKey: "plugins.reason.invalidFolder",
      reasonArgs: { path: path.join(root, name) },
    };
  }
  // 재설치 — 먼저 되돌린다. ★여기서 읽는다(가드가 쓰던 변수를 재활용하지 않는다):
  //  가드는 *디스크의 번들 이름*을, 이것은 *지금 도는 인스턴스*를 묻는다. 다른 질문이다.
  const existing = LIVE.get(name);
  if (existing !== undefined) await existing.dispose();
  const wired = await wirePlugin(found, deps);
  trackPlugin(found, "home", wired);
  const needs = describeNeeds(found.manifest.needs ?? {});
  console.log(`[plugin-manager] 설치: ${name} · ${needs} · 꽂힘 [${wired.wired.join(", ")}]`);
  return { ok: true, needs, needsFacts: needsFacts(found.manifest.needs ?? {}), wired: wired.wired };
};
