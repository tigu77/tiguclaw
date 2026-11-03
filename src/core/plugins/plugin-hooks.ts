/**
 * **플러그인이 실어 오는 훅** — 발견(`pluginHookSources`)과 항목 판정(`classifyHookItem`) (2026-11-03 설계
 * `docs/decisions/2026-11-03-plugin-hooks-design.md`).
 *
 * 켜진 플러그인 폴더의 `hooks/hooks.json`(Claude Code 와 같은 파일·모양)을 **호출마다** 읽는다 — 캐시가 없어서 켜기·끄기·
 * 설치·제거·내용 수정이 다음 호출부터 반영된다(끄기가 신뢰를 거두는 수단이다, 설계 §3.3·§3.5).
 *
 * ★실행(`hook-runner.ts`)·인벤토리·`/status` 가 **이 파일의 판정만** 쓴다. 같은 판단을 두 자리에 두지 않는다 —
 *  실행 수 = 인벤토리 `runnable` 행 수 = `/status` 의 N 이 같은 것을 센다(설계 §3.6).
 * ★`hook-runner.ts` 가 이 파일을 import 한다. 그래서 이 파일은 `hook-runner.ts` 를 import 하지 않는다(순환 방지).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { appRoot, getPaths, pluginDataDir } from "../paths.js";
import { activePluginDirs, declaredPluginName } from "./active-dirs.js";

/** 티구클로가 실제로 내는 훅 이벤트 — 실행·인벤토리가 공유한다. 새 이벤트를 내면 여기에 더한다. */
export const EMITTED_HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PreToolUse",
  "PostToolUse",
  "SubagentStop",
] as const;

/** 훅 하드 백스톱 여유(ms) — spawn timeout 이 sh 만 죽이고 stdio 가 안 닫히는 경우 대비(`hook-runner.ts` 백스톱). */
export const HOOK_BACKSTOP_GRACE_MS = 5_000;

/** `setTimeout` 의 상한 — 넘으면 Node 가 1ms 로 줄인다(설계 §0 실측: 훅이 실행 직후 강제 종료). */
const TIMER_MAX_MS = 2_147_483_647;

/**
 * 훅 항목의 timeout(ms) — 계산은 **이 한 곳**(설계 §3.1 «timeout 판정»). 식은 종전 그대로 `(timeout ?? 60) * 1000`
 * (단위 초·기본 60·`null` 은 기본값·숫자 문자열 `"5"` 도 곱셈이 숫자로 바꾼다).
 * 실행할 수 없는 값이면 `undefined` — 0 이상의 정수(Node spawn 규칙)이고 백스톱이 타이머 상한을 넘지 않을 때만 유효하다.
 * ★곱셈의 숫자 변환 자체가 던질 수 있다(`{"toString":0}` → TypeError) — 외부 JSON 경계에서 실제로 나는 예외라 그 항목만 무효로 둔다.
 */
export const hookTimeoutMs = (item: { timeout?: unknown }): number | undefined => {
  let ms: number;
  try {
    ms = ((item.timeout ?? 60) as number) * 1000;
  } catch {
    return undefined;
  }
  return Number.isInteger(ms) && ms >= 0 && ms + HOOK_BACKSTOP_GRACE_MS <= TIMER_MAX_MS ? ms : undefined;
};

/**
 * 항목 하나의 상태(설계 §3.1). 위에서부터 처음 맞는 것:
 *  - `malformed` — 객체가 아님 · `type:"command"` 인데 `command` 가 문자열이 아님 · timeout 이 실행할 수 없는 값
 *  - `unsupported` — `type` 이 `command` 가 아님 · `args` 가 있음(exec 형식 — 지금 엔진은 몰라서 `command` 만 엉뚱하게 돈다)
 *  - `not-emitted` — 티구클로가 내지 않는 이벤트
 *  - `runnable` — 나머지. **플러그인 층의 실행 대상은 이것뿐**이다.
 * ★홈·프로젝트 층은 실행 루프에서 `malformed` 만 거른다(`args` 무시는 종전 그대로 — 설계 §3.1 «의도된 일시 차이»).
 */
export type HookItemStatus = "runnable" | "unsupported" | "not-emitted" | "malformed";

export const classifyHookItem = (event: string, item: unknown): HookItemStatus => {
  if (item === null || typeof item !== "object") return "malformed";
  const h = item as { type?: unknown; command?: unknown; args?: unknown; timeout?: unknown };
  if (h.type === "command" && typeof h.command !== "string") return "malformed";
  if (hookTimeoutMs(h) === undefined) return "malformed";
  if (h.type !== "command" || h.args !== undefined) return "unsupported";
  if (!(EMITTED_HOOK_EVENTS as readonly string[]).includes(event)) return "not-emitted";
  return "runnable";
};

/** 파일 안 항목 하나(또는 깨진 이벤트·매처 묶음 한 줄). 파일 순서 그대로다. */
export interface PluginHookEntry {
  event: string;
  /** 매처 원문(문자열이 아니면 그 묶음은 `malformed`). 미지정이면 `undefined`. */
  matcher: string | undefined;
  /** 원 항목 — 깨진 이벤트·묶음 줄이면 `undefined`. */
  item: unknown;
  status: HookItemStatus;
}

export type PluginHookInvalidReason = "unreadable" | "bad-format" | "bad-name";

export interface PluginHookSource {
  /** 매니페스트 이름(없으면 폴더 이름). 출처 줄·인벤토리·`/status` 에 그대로 나간다. */
  plugin: string;
  dir: string;
  /** `<dir>/hooks/hooks.json` */
  file: string;
  /** `loaded` = 파일이 읽혔고 모양이 맞고 이름 규칙 통과(실행 여부가 아니다) · `invalid` · `shadowed`(같은 이름의 앞 폴더가 있다). */
  status: "loaded" | "invalid" | "shadowed";
  reason?: PluginHookInvalidReason;
  /** `shadowed` 일 때 그 이름을 먼저 차지한 폴더. */
  shadowedBy?: string;
  /** `loaded` 일 때만 — `${CLAUDE_PLUGIN_ROOT}`(폴더 실경로)·`${CLAUDE_PLUGIN_DATA}`(호스트 `dataDir` 과 같은 값, 만들지 않는다). */
  root?: string;
  data?: string;
  entries: PluginHookEntry[];
}

/** 기본 뿌리 — 번들 다음 홈(커맨드 발견과 같은 관례). 인자로 바꿀 수 있는 것은 회귀가 «번들 → 홈» 순서를 임시 뿌리로 보기 위해서다. */
const defaultRoots = (): string[] => [path.join(appRoot(), "plugins"), getPaths().commonPlugins];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** 파일의 이벤트 맵을 항목 줄로 펼친다. 깨진 이벤트 값·매처 묶음은 그 자리에 `malformed` 한 줄. */
const entriesOf = (hooks: Record<string, unknown>): PluginHookEntry[] => {
  const out: PluginHookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out.push({ event, matcher: undefined, item: undefined, status: "malformed" });
      continue;
    }
    for (const g of groups) {
      const m = isPlainObject(g) ? g.matcher : undefined;
      // 매처가 문자열이 아니면(숫자 등) 매칭에서 던진다 — 그 묶음 전체를 실행할 수 없는 줄로 둔다.
      if (!isPlainObject(g) || !Array.isArray(g.hooks) || (m !== undefined && typeof m !== "string")) {
        out.push({ event, matcher: typeof m === "string" ? m : undefined, item: undefined, status: "malformed" });
        continue;
      }
      for (const item of g.hooks) {
        out.push({ event, matcher: m as string | undefined, item, status: classifyHookItem(event, item) });
      }
    }
  }
  return out;
};

/** 읽지 않는 플러그인 훅 — (플러그인, 사유, 파일)당 프로세스에 한 번만 로그(매 호출 찍으면 배경소음). */
const logged = new Set<string>();
const REASON_LOG: Record<PluginHookInvalidReason, string> = {
  unreadable: "읽을 수 없음",
  "bad-format": "형식 오류",
  "bad-name": "이름이 맞지 않음",
};
const logOnce = (s: PluginHookSource): void => {
  const why = s.status === "shadowed" ? `가려짐(${s.shadowedBy ?? ""})` : REASON_LOG[s.reason ?? "unreadable"];
  const key = `${s.plugin}\0${why}\0${s.file}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.warn(`[hook] 플러그인 ${s.plugin} 훅을 읽지 않습니다 — ${why} (${s.file})`);
};

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

/** 매니페스트가 이름을 선언했나 — 판정은 `activePluginDirs` 가 이름을 정하는 곳과 같은 함수다. */
const hasManifest = async (dir: string): Promise<boolean> => (await declaredPluginName(dir)) !== undefined;

/**
 * 이름마다 **그 이름의 훅 출처가 될 폴더** — 기본은 처음 나온 폴더(번들 뿌리가 먼저, 한 뿌리 안은 폴더 이름순).
 * ★예외 하나: 매니페스트 없는 **데이터 폴더**(`pluginDataDir(name)` 그 자리)는, 같은 이름의 매니페스트 있는 폴더가 있으면 이름을 차지하지 않는다.
 *  폴더 이름이 매니페스트 이름과 다른 플러그인(`z-n` → `n`)은 설정 저장·`dataDir` 쓰기만으로 `<home>/plugins/n` 이 생기고,
 *  이름순으로 그 폴더가 앞서 진짜 플러그인의 훅을 가렸다(2026-11-03 코드 검토 재현). 번들 쌍둥이는 번들 뿌리가 먼저라 무관하다.
 */
const claimants = async (dirs: Array<{ dir: string; name: string }>): Promise<Map<string, string>> => {
  const groups = new Map<string, string[]>();
  for (const d of dirs) groups.set(d.name, [...(groups.get(d.name) ?? []), d.dir]);
  const out = new Map<string, string>();
  for (const [name, ds] of groups) {
    let pick = ds[0] as string;
    if (ds.length > 1 && path.resolve(pick) === path.resolve(pluginDataDir(name)) && !(await hasManifest(pick))) {
      for (const d of ds.slice(1)) {
        if (await hasManifest(d)) {
          pick = d;
          break;
        }
      }
    }
    out.set(name, pick);
  }
  return out;
};

/**
 * 켜진 플러그인의 훅 출처 목록 — 번들 뿌리 → 홈 뿌리, 각 뿌리 안은 폴더 이름순(`activePluginDirs`).
 *  - **이름당 처음 나온 폴더만** 출처가 된다 — 훅 파일 유무와 무관하게 앞 폴더가 이름을 차지한다(번들 데이터 폴더가 홈 뿌리에
 *    같은 이름으로 있다 · 홈 폴더가 번들 이름을 쓰면 번들 훅처럼 보인다). 뒤 폴더는 파일이 **있을 때만** `shadowed` 한 줄.
 *    예외: 매니페스트 없는 데이터 폴더는 같은 이름의 매니페스트 있는 폴더에 자리를 내준다(`claimants`).
 *  - 파일 없음(`ENOENT`)은 훅을 안 실어 온 정상 플러그인이다 — 목록에 없다(행·로그·`/status` 0).
 *  - 이름 규칙(`isValidPluginName`)은 파일이 있는 폴더에만 본다 — 이름이 출처 줄 «[🧩 이름 훅]» 에 그대로 들어간다.
 */
export const pluginHookSources = async (roots: string[] = defaultRoots()): Promise<PluginHookSource[]> => {
  // 로더는 호스트·인벤토리를 끌어온다 — 훅 엔진이 정적으로 물면 순환이 생겨 동적으로 가져온다.
  const { isValidPluginName } = await import("./loader.js");
  const dirs: Array<{ dir: string; name: string }> = [];
  for (const root of roots) dirs.push(...(await activePluginDirs(root)));
  const claimed = await claimants(dirs);
  const out: PluginHookSource[] = [];
  for (const d of dirs) {
    const file = path.join(d.dir, "hooks", "hooks.json");
    const owner = claimed.get(d.name);
    if (owner !== d.dir) {
      if (await exists(file)) out.push({ plugin: d.name, dir: d.dir, file, status: "shadowed", shadowedBy: owner, entries: [] });
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      out.push({ plugin: d.name, dir: d.dir, file, status: "invalid", reason: "unreadable", entries: [] });
      continue;
    }
    if (!isValidPluginName(d.name)) {
      out.push({ plugin: d.name, dir: d.dir, file, status: "invalid", reason: "bad-name", entries: [] });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.hooks)) {
      out.push({ plugin: d.name, dir: d.dir, file, status: "invalid", reason: "bad-format", entries: [] });
      continue;
    }
    const root = await fs.realpath(d.dir).catch(() => d.dir);
    out.push({
      plugin: d.name,
      dir: d.dir,
      file,
      status: "loaded",
      root,
      data: pluginDataDir(d.name),
      entries: entriesOf(parsed.hooks),
    });
  }
  for (const s of out) if (s.status !== "loaded") logOnce(s);
  return out;
};

/** 플러그인별 실행 후보 수(`loaded` 출처의 `runnable` 항목) — `/status` 한 줄과 인벤토리가 세는 것과 같다. 0 인 플러그인은 빠진다. */
export const runnablePluginHookCounts = (sources: PluginHookSource[]): Array<{ plugin: string; n: number }> =>
  sources
    .filter((s) => s.status === "loaded")
    .map((s) => ({ plugin: s.plugin, n: s.entries.filter((e) => e.status === "runnable").length }))
    .filter((c) => c.n > 0);

/** 명령 안 경로 변수를 글자 그대로 바꾼다(셸 해석 없음 · 따옴표는 작성자 몫 — Claude Code 와 같다). */
export const substitutePluginVars = (command: string, vars: Record<string, string>): string => {
  let out = command;
  for (const [k, v] of Object.entries(vars)) out = out.split(`\${${k}}`).join(v);
  return out;
};
