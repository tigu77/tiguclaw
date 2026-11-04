/**
 * 자식: `removed-plugin-leftovers` 의 한 칸(또는 데이터 보존 단계)을 **자기 격리 홈**에서 돌리고 관측값 한 줄을 낸다.
 *
 * ★단언하지 않는다 — 관측만 한다. 판정은 부모가 9칸 관측을 다 모은 **뒤에** 한다(설계 §6.2 «관측 먼저, 단언 나중»).
 *  그래야 제거 직전 사본(기대값이 «후» 라 빨강이 정상)에서도 칸별 관측이 끝까지 나온다.
 * ★자식인 이유: `getPaths()` 가 메모이즈라 칸마다 홈을 바꾸려면 프로세스를 갈라야 하고, 홈 코드 플러그인의 ESM import 캐시도
 *  칸끼리 섞이면 안 된다(같은 경로를 두 칸이 import 하면 두 번째는 모듈 본문이 안 돈다).
 *
 * 입력(env): `TIGUCLAW_HOME` = 칸 홈(부모가 만들고 채움) · `LEFTOVER_MODE` = `cell` | `data`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MARK = "@@LEFTOVER-OBS@@";
const MODE = process.env.LEFTOVER_MODE ?? "cell";
const HOME = path.resolve(process.env.TIGUCLAW_HOME ?? "");

type Lines = { log: string[]; warn: string[]; error: string[] };

/** 한 호출 동안 콘솔 줄을 잡는다 — 뿌리별로 따로 부르려고 호출 단위다(로더 로그 줄엔 뿌리 경로가 없다). */
const capture = async <T>(fn: () => Promise<T>, norm: (s: string) => string): Promise<[T, Lines]> => {
  const lines: Lines = { log: [], warn: [], error: [] };
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (k: keyof Lines) => (...a: unknown[]): void => {
    lines[k].push(norm(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(" ")));
  };
  console.log = grab("log");
  console.warn = grab("warn");
  console.error = grab("error");
  try {
    return [await fn(), lines];
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
};

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);

const main = async (): Promise<void> => {
  // 데이터 보존의 seed 단계는 **업그레이드 전 상태를 심기만** 한다 — 로더·훑기를 돌리면 그 첫 부팅이 바꾼 것이 기준에 섞인다.
  const seedOnly = MODE === "data" && process.env.LEFTOVER_STAGE === "seed";
  const { appRoot } = await import("../../core/paths.js");
  const APP = appRoot();
  // macOS 의 `/tmp` 는 `/private/tmp` 링크라 레지스트리(realpath)와 로더(resolve)가 다른 모양을 낸다 — 둘 다 같은 자리로 본다.
  const HOME_REAL = await fs.realpath(HOME);
  // 임시 경로만 바꾼다 — 메시지 나머지는 그대로 둔다(경고 내용을 지우지 않는다). 매 실행 달라지는 pid·임시 토큰 값도 자리표로.
  const norm = (s: string): string =>
    s
      .split(HOME_REAL).join("<HOME>")
      .split(HOME).join("<HOME>")
      .split(APP).join("<APP>")
      .replace(/\(node:\d+\)/g, "(node:<PID>)")
      .replace(/(ephemeral token: )[0-9a-f]+/g, "$1<TOKEN>");
  // 최초 import 도 관측한다 — 모듈 본문의 console.error 는 loadPlugins() 전에 난다.
  const [{ createEventBus, loadPlugins }, loaderImportLines] = await capture(async () => ({
    ...await import("../../core/eventbus.js"),
    ...await import("../../core/plugins/loader.js"),
  }), norm);
  const bus = createEventBus();
  const pluginErrors: string[] = [];
  bus.subscribe((e) => {
    if (e.type === "plugin.error") pluginErrors.push(norm(JSON.stringify(e.payload ?? {})));
  });

  const none = async () => [] as Awaited<ReturnType<typeof loadPlugins>>;
  const [bundled, bundledLines] = await capture(() => (seedOnly ? none() : loadPlugins(path.join(APP, "plugins"), bus)), norm);
  const [home, homeLines] = await capture(() => (seedOnly ? none() : loadPlugins(path.join(HOME, "plugins"), bus)), norm);

  const roots = [HOME, HOME_REAL].map((h) => path.join(h, "plugins", "self-growth") + path.sep);
  const fromHomeGrowth = (items: ReadonlyArray<{ name: string; filePath?: string }>): string[] =>
    items
      .filter((i) => typeof i.filePath === "string" && roots.some((r) => path.resolve(i.filePath!).startsWith(r)))
      .map((i) => i.name)
      .sort();
  const [assets, scanLines] = await capture(async () => {
  const { discoverSkills } = await import("../../core/llm-runtime/capabilities/skill-registry.js");
  const { discoverAgents } = await import("../../core/llm-runtime/capabilities/agent-registry.js");
  const { discoverCommands } = await import("../../core/entry/command-registry.js");
  const { discoverEndpoints } = await import("../../core/entry/endpoint-registry.js");
    return seedOnly ? { skills: [], agents: [], commands: [], endpoints: [] } : {
      skills: fromHomeGrowth(await discoverSkills(HOME)),
      agents: fromHomeGrowth(await discoverAgents(HOME)),
      commands: fromHomeGrowth(await discoverCommands(HOME)),
      endpoints: fromHomeGrowth(await discoverEndpoints(HOME)),
    };
  }, norm);

  const obs: Record<string, unknown> = {
    bundledLoaded: bundled.map((p) => p.manifest.name).sort(),
    homeLoaded: home.map((p) => p.manifest.name).sort(),
    // 홈 코드 플러그인 entry 가 생성 시 남기는 흔적(네트워크·외부 쓰기 0).
    trace: await exists(path.join(HOME, "home-plugin-ran.txt")),
    loaderImportLines,
    bundledLines,
    homeLines,
    scanLines,
    assets,
    pluginErrors,
  };

  if (MODE === "data") {
    // 데이터 보존 1단계 — 읽기만 한다. 2단계(명시적 쓰기)는 부모가 바이트·값을 비교한 뒤 `LEFTOVER_STAGE=write` 로 따로 부른다.
    const { initStore, getDb } = await import("../../store/sessions.js");
    initStore();
    const stage = process.env.LEFTOVER_STAGE ?? "read";
    if (stage === "seed") {
      // 업그레이드 전 설치본이 갖고 있을 DB 행 — 성장 메모리 활성 1·보관 1 + 결과 열이 찬 skill_usage 1.
      const day = 24 * 60 * 60 * 1000;
      const t0 = Date.now() - 300 * day;
      const ins = getDb().prepare(
        `INSERT INTO memories (type, name, description, body, created_at, updated_at, access_count, last_accessed, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      ins.run("feedback", "feedback_growth_regr_live", "옛 성장 교훈(활성)", "본문 L", t0, t0 + day, 7, t0 + 2 * day, null);
      ins.run("reference", "growth_regr_archived", "옛 성장 제안(보관)", "본문 A", t0, t0 + day, 3, t0 + 3 * day, t0 + 4 * day);
      getDb()
        .prepare(`INSERT INTO skill_usage (skill_name, invoke_count, last_used_at, success_count, fail_count) VALUES (?, ?, ?, ?, ?)`)
        .run("regr-skill", 11, t0 + 5 * day, 8, 3);
    }
    const { formatSelfGrowthDirectives, formatMemoryIndex } = await import("../../core/prompt-assembly.js");
    const { confirmFeedback } = await import("../../core/llm-runtime/capabilities/directives-mcp.js");
    const { countArchivedMemories } = await import("../../store/memory.js");
    const { listDirectives } = await import("../../store/self-growth-md.js");
    if (stage === "seed") {
      /* 관측 없음 — 아래에서 심은 값만 낸다(비교 기준) */
    } else if (stage === "read") {
      obs.injected = formatSelfGrowthDirectives();
      obs.list = (await confirmFeedback({ action: "list" })).text;
      obs.memoryIndex = formatMemoryIndex(1_000_000);
      obs.archived = countArchivedMemories();
    } else {
      const set = await confirmFeedback({ action: "set", key: "regr-new-b", text: "새 사용자 규칙 B" });
      const afterSet = await listDirectives();
      const retire = await confirmFeedback({ action: "retire", key: "regr-auto-a2" });
      const afterRetire = await listDirectives();
      obs.set = set;
      obs.afterSet = afterSet;
      obs.retire = retire;
      obs.afterRetire = afterRetire;
      obs.selfGrowthBody = await fs.readFile(path.join(HOME, "SELF_GROWTH.md"), "utf8");
    }
    obs.db = {
      memories: getDb().prepare(
        `SELECT type, name, description, body, created_at, updated_at, access_count, last_accessed, archived_at
         FROM memories WHERE name LIKE 'feedback_growth_%' OR name LIKE 'growth_%' ORDER BY name`,
      ).all(),
      skillUsage: getDb().prepare(`SELECT * FROM skill_usage ORDER BY skill_name`).all(),
    };
  }

  process.stdout.write(`\n${MARK}${JSON.stringify(obs)}\n`, () => process.exit(0));
};

main().catch((e: unknown) => {
  process.stdout.write(`\n${MARK}${JSON.stringify({ crashed: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) })}\n`, () => process.exit(0));
});
