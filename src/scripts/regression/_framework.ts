/**
 * 회귀 스위트 뼈대 (2026-07-28, 딥리뷰 H).
 *
 * ★왜 있나: 검증 하네스를 154개 만들었지만 전부 일회용(`_workspace/`)이라 **한 번 돌고
 *  다시는 안 돌았다.** 그래서 "어제 고친 게 오늘 또 깨졌는지"를 사람이 기억해야 했다.
 *  여기 올라온 것만이 매 CI·매 릴리스에서 다시 돈다.
 *
 * 승격 기준(넣기 전에 스스로 물을 것):
 *  1. **싸다** — 수 초 안에 끝난다(외부 네트워크·LLM 호출 없음).
 *  2. **결정적이다** — 같은 입력이면 같은 결과(타이밍 의존·플래키 금지).
 *  3. **격리돼 있다** — 임시 홈/사본만 건드린다. 라이브 데몬·홈·DB 를 절대 안 만진다.
 *  4. **회귀를 잡은 적이 있다** — 실제 사고에서 나온 것. "있으면 좋은 테스트"는 제외.
 * 브라우저(CDP)·라이브 데몬이 필요한 검증은 여기 넣지 않는다(별도 수동 스위트).
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { FAKE_NETWORK } from "../../core/llm-runtime/regression-model-guard.js";

export interface Assertion {
  /** 사람이 읽는 단언 — 실패 시 그대로 보고된다. */
  readonly name: string;
  readonly ok: boolean;
  /** Explicitly unmeasured platform-specific case; never counted as a pass. */
  readonly skip?: string;
  /** 실제 관측값(실패 진단용). 통과해도 남긴다 — "왜 통과했나"가 보여야 한다. */
  readonly got: string;
}

export const skip = (name: string, reason: string): Assertion => ({ name, ok: false, got: reason, skip: reason });

export interface RegressionCheck {
  /** 스위트 안에서 유일한 짧은 이름. */
  readonly name: string;
  /** 이 검사가 지키는 회귀 — 무엇이 깨졌었나(사고 이력). */
  readonly guards: string;
  run: () => Promise<Assertion[]>;
}

/**
 * 격리 확인 — 러너를 거치지 않고 개별 체크를 직접 import 하면 **라이브 홈/DB** 를 친다.
 * (실측: 한 검사가 실제 codex 쿨다운 행을 지웠다.) 러너가 임시 홈을 잡았는지 확인하고,
 * 아니면 즉시 던진다 — 조용히 라이브를 만지는 것보다 요란하게 실패하는 게 낫다.
 */
export const assertIsolated = (): void => {
  const home = process.env.TIGUCLAW_HOME ?? "";
  if (!/tiguclaw-regression-/.test(home)) {
    throw new Error(
      `회귀 검사는 격리된 임시 홈에서만 돈다 — 지금 TIGUCLAW_HOME=${home || "(미설정)"}. ` +
        "`npm run test:regression` 으로 실행하세요.",
    );
  }
  if (process.env.DATA_DIR !== undefined) {
    throw new Error("DATA_DIR 이 설정돼 있으면 격리가 깨진다 — 러너가 지운다.");
  }
};

export const assert = (name: string, ok: boolean, got: unknown): Assertion => ({
  name,
  ok,
  got: typeof got === "string" ? got : JSON.stringify(got),
});

/**
 * 검사 안에서 쓰는 시한 — **매달리지 말고 실패하라**.
 *
 * ★실측(2026-07-28): detached 를 뺀 변이 상태로 스위트를 돌렸더니 손자가 안 죽어
 *  `wait` 가 영원히 반환되지 않았고, 스위트가 **끝나지 않았다**. CI 에서 무한 대기는
 *  빨간불보다 나쁘다(원인이 안 보이고 러너 시한까지 자원을 문다). 그래서 회귀를
 *  기다리는 모든 지점은 자기 시한을 들고, 넘기면 그 사실 자체를 실패로 보고한다.
 */
export const within = async <T>(
  ms: number,
  what: string,
  p: Promise<T>,
): Promise<{ value: T } | { timedOut: string }> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<{ timedOut: string }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: `${what} 이(가) ${ms}ms 안에 안 끝남` }), ms);
  });
  try {
    const r = await Promise.race([p.then((value) => ({ value })), guard]);
    return r;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
/**
 * **자식을 띄우고 시한까지 기다린다 — 넘기면 죽인다** (2026-09-20).
 *
 * ★★`within()` 은 시한을 넘기면 **그냥 돌아온다.** 자식은 계속 산다. 세 검사가 각자 손으로
 *  `spawn` 과 `within` 을 엮고 있었고, **셋 다 kill 을 빠뜨렸다** — 같은 것을 세 번 적으면
 *  세 번 다 같은 곳을 빠뜨린다([[feedback_simple_composable_no_duplication]] 의
 *  «이음매에서 새면 린트 말고 이음매를 없애라»).
 * ★★**맥에선 원리적으로 안 보인다.** 고아 자식이 러너 홈의 파일을 붙들고 있어도 POSIX 는
 *  그냥 지운다. Windows 에서만 `EBUSY` 가 되고, 그래서 한 번도 안 드러났다.
 * ★주의 — 이것이 그 `EBUSY` 의 범인이라는 **증거는 아직 없다**(두 검사 모두 그 기계에서
 *  초록이었다 = 시한을 안 넘겼다). 범인과 무관하게 **결함은 결함**이라 닫는다.
 */
export const spawnWithin = async (
  ms: number,
  what: string,
  argv: string[],
  opts: SpawnOptions = {},
): Promise<{ out: string; err: string; timedOut: boolean }> => {
  const p = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let so = "";
  let se = "";
  p.stdout?.on("data", (d: Buffer) => (so += d.toString()));
  p.stderr?.on("data", (d: Buffer) => (se += d.toString()));
  const ended = new Promise<void>((resolve) => {
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
  const r = await within(ms, what, ended);
  if (!("value" in r)) {
    // ★시한을 넘겼다 — **죽인다.** 안 죽이면 고아가 러너 홈을 붙들고, 그 뒤 정리가 실패한다.
    try {
      p.kill("SIGKILL");
    } catch {
      /* 이미 죽었으면 할 일이 없다 */
    }
    return { out: so, err: se, timedOut: true };
  }
  return { out: so, err: se, timedOut: false };
};

/**
 * 대시보드 js 조각을 node 에서 실제로 돌릴 때 필요한 **화면 문구 함수 대역**.
 *
 * ★2026-08-25 화면 문구를 카탈로그로 옮기면서 `i18n(…)` 이 생겼는데, 그 함수는 브라우저
 *  전역에만 있다. 실행 기반 검사 7개가 한꺼번에 `ReferenceError: i18n is not defined` 로 터졌다
 *  — 그물이 제 몫을 한 것이다(소스 린트였으면 조용히 통과했다).
 *
 * ★그리고 **항등 함수(`(s) => s`)로는 안 된다** (2026-08-25 키 규약 통일). 키가 곧 한국어
 *  문장이던 동안엔 맞았지만, 추상 키로 옮기자 화면 문구를 보는 단언들이 전부 `chat.empty`
 *  같은 키를 받았다 — **표시 문구를 상태로 쓰던 것과 같은 부류가 검사 쪽에도 있었다.**
 *  진짜 카탈로그를 태우면 단언은 그대로 살고, 키가 카탈로그에 없으면 문구가 안 나오므로
 *  **그 자체가 그물 하나**가 된다. 브라우저 `i18n` 과 규칙을 맞춘다(없으면 키 자체,
 *  `{name}` 만 채우고 값 없는 자리표시자는 남긴다).
 */
const KO_CATALOG = JSON.parse(
  readFileSync(new URL("../../../locales/ko.json", import.meta.url), "utf8"),
) as Record<string, string>;
export const JS_I18N_STUB =
  `const __KO = ${JSON.stringify(KO_CATALOG)};` +
  `const i18n = (k, p) => { const r = typeof __KO[k] === "string" ? __KO[k] : k; ` +
  `return p ? r.replace(/\\{(\\w+)\\}/g, (w, n) => (p[n] === undefined ? w : String(p[n]))) : r; };`;

/**
 * `vm.createContext` 에 넣는 `i18n` — `JS_I18N_STUB` 과 **같은 규칙**이다.
 * ★두 자리가 각자 스텁을 들면(실제로 그랬다: 항등 함수 두 벌) 키 규약이 바뀔 때 한쪽만
 *  낡는다. 정본을 여기 하나 둔다([[feedback_simple_composable_no_duplication]]).
 */
export const i18nForContext = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string => {
  const raw = typeof KO_CATALOG[key] === "string" ? KO_CATALOG[key] : key;
  return params === undefined
    ? raw
    : raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
        params[name] === undefined ? whole : String(params[name]),
      );
};

/**
 * 플러그인 소스를 **빌드 프로그램에 끌어들이지 않고** 실행한다.
 *
 * ★`npm run build` 는 `tsconfig.json`(rootDir=`src`, include=`src`)을 쓴다 — 회귀가
 *  `plugins/…` 를 **리터럴로** import 하면(정적이든 `await import("…")` 이든 tsc 는 둘 다
 *  정적으로 따라간다) `TS6059` 로 **빌드 전체가 깨진다.** 2026-09-01 실측: DEV·배포 트리
 *  양쪽에서 `rc=2`. `npm run typecheck` 는 `tsconfig.check.json`(rootDir=`.`)이라
 *  **통과해서 안 보였다** — 설정이 둘인데 하나만 검사하고 있었다.
 *
 * ★**이게 왜 문제인가는 「사용자 업데이트가 깨져서」가 아니다** — 처음에 그렇게 적었고
 *  틀렸다. 전수로 세어보면 `npm run build` 를 부르는 코드 경로는 **0개**다: `/update` 는
 *  `tsc -p tsconfig.build.json`(rootDir=`.`), 설치·dep-free 갱신은 `build:prod`. 실제
 *  소비처는 **공개 CI** 뿐이다. 즉 이건 사고가 아니라 **경계 게이트가 빨강이 되는 것**이고,
 *  `plugin-widget-end-to-end.ts` 가 이미 그 프레임으로 적어뒀다 —
 *  *"`npm run build` 는 「src 가 src 밖을 정적으로 짚지 않는가」를 보는 유일한 자리"*.
 *  재지 않고 쓴 «전 사용자» 라는 말이 인접한 두 파일을 서로 반대로 만들 뻔했다.
 *
 * 지정자를 **계산**하면 tsc 가 못 따라가 프로그램에 안 들어온다. 타입은 호출부가 자기가
 * 쓸 모양만 적는다 — `typeof import("…")` 을 쓰면 그 파일이 **다시** 프로그램에 들어와
 * 원래 문제로 돌아간다.
 */
export const loadPluginModule = async <T>(relFromThisDir: string): Promise<T> =>
  (await import(new URL(relFromThisDir, import.meta.url).href)) as T;

/**
 * 가짜 `fetch` 에 **명시적 fake 표식**을 붙인다 — 회귀의 실제 모델 호출 차단 가드가 fetch 로만
 * 통신하는 입구(Codex)를 이 스텁 아래서는 통과시킨다(`regression-model-guard.ts`).
 */
export const fakeNetwork = <F extends (...args: never[]) => unknown>(fn: F): F =>
  Object.assign(fn, { [FAKE_NETWORK]: true });
