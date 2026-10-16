/**
 * 외부 MCP 서버 동적 연결 — `<home>/mcp.json` (파일=진실, 비서가 씀·부팅/턴이 읽음).
 *
 * 진실 소스 ADR: docs/decisions/2026-07-07-external-mcp-dynamic-connect.md.
 * 표준 MCP config 형태(`.mcp.json` 동형, inventory.ts 가 이미 읽는 shape — 커스텀 DSL 0):
 *   { "mcpServers": {
 *       "github": { "command": "npx", "args": [...], "env": {...} },   // stdio
 *       "docs":   { "type": "sse", "url": "https://..." }              // sse
 *   } }
 *
 * ★역할 분리:
 *  - claude 어댑터 = 이 config 를 SDK `options.mcpServers` 유니온에 *그대로* 주입(네이티브 연결).
 *  - codex/openai 어댑터 = `@modelcontextprotocol/sdk` 클라이언트로 spawn+연결 후 브리지(Phase 2).
 *  - 코어(add/list/remove 도구)는 파일만 다룬다 — 연결은 어댑터가. 단방향(코어→플러그인 참조 0).
 *
 * 견고성: 읽기 실패/손상 → 빈 맵(never-throw). 데몬 생존 우선(원칙 #3).
 */
import { isTrustedProjectDir } from "./project-trust.js";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { MCPServer } from "@openai/agents-core";
// ★시크릿 판정은 `outbound-sanitize` 가 유일 정본이다 — 여기 사본을 두면 어긋난다
//  (2026-08-01 감사: 실제로 어긋나 있었다. 사본 쪽에만 CREDENTIAL 이 있었다).
import { SECRET_KEY_NAME_RE } from "./outbound-sanitize.js";
import { getPaths } from "./paths.js";

/** stdio 서버 config (claude McpStdioServerConfig 동형). */
export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
/** sse 서버 config (claude McpSSEServerConfig 동형). */
export interface SseMcpConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}
export type ExternalMcpConfig = StdioMcpConfig | SseMcpConfig;

interface McpJsonFile {
  mcpServers?: Record<string, ExternalMcpConfig>;
}

const mcpJsonPath = (): string => path.join(getPaths().home, "mcp.json");

// ─── 프로젝트 스코프 MCP (ADR 2026-07-08) ────────────────────────────────────
// 전역 = <home>/mcp.json (크로스-프로젝트). 프로젝트 = <cwd>/.mcp.json (Claude Code 파리티,
// 그 프로젝트 위임 턴에만). 마스터/비프로젝트 턴(cwd 미지정) = 전역만.
const projectMcpPath = (cwd: string): string => path.join(cwd, ".mcp.json");

/**
 * cwd 가 프로젝트 스코프 대상인가 — 지정됨 + 홈 아님(홈은 전역 mcp.json 소유). 어댑터가
 * "프로젝트 위임 서브/매니저면 외부 MCP 를 읽는다" 게이트로도 사용(export).
 */
export const isProjectMcpCwd = (cwd?: string): cwd is string => {
  if (cwd === undefined || cwd === "") return false;
  try {
    // ★믿는 폴더만 — 등록 안 된 남의 레포의 `.mcp.json` 은 그 `command` 를 그대로 실행한다(project-trust.ts).
    return path.resolve(cwd) !== path.resolve(getPaths().home) && isTrustedProjectDir(cwd);
  } catch {
    return false;
  }
};

/**
 * 한 mcp.json/.mcp.json 파일 읽기 — **없음**(= 서버 0개, 정당한 상태)과 **못 읽음**(손상·쓰는 중)을 가른다.
 * ★연결을 매번 설정에 맞추므로 둘을 섞으면 안 된다 — 제자리 쓰기 도중이나 편집기가 반쯤 저장한 파일을 «빈 설정» 으로 읽으면
 *  붙어 있던 연결을 **전부 닫는다.** 못 읽으면 맞추기를 건너뛰고 지금 연결을 둔다. throw 0(데몬 생존).
 */
const readMcpFileState = async (
  file: string,
): Promise<{ ok: true; servers: Record<string, ExternalMcpConfig> } | { ok: false; reason: string }> => {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, servers: {} };
    return { ok: false, reason: `읽기 실패(${(e as NodeJS.ErrnoException)?.code ?? "unknown"})` };
  }
  try {
    const servers = (JSON.parse(raw) as McpJsonFile)?.mcpServers;
    if (servers === undefined || servers === null) return { ok: true, servers: {} };
    if (typeof servers !== "object") return { ok: false, reason: "mcpServers 가 객체가 아님" };
    return { ok: true, servers };
  } catch {
    // ★파서 메시지를 싣지 않는다 — V8 은 «Unexpected token» 에 원문 조각을 넣어, 따옴표 없이 적은 토큰이 로그(→ /logs 로 채팅)에
    //  찍혔다(적대 검토 F4). 크기만 남긴다.
    return { ok: false, reason: `JSON 형식 오류(${raw.length}자 — 내용은 싣지 않음)` };
  }
};

/** 한 mcp.json/.mcp.json 파일의 mcpServers 읽기 — 부재/손상 시 빈 맵(throw 0). 표시·Claude 경로용(맞추기는 위 상태판을 쓴다). */
const readMcpFile = async (file: string): Promise<Record<string, ExternalMcpConfig>> => {
  const r = await readMcpFileState(file);
  return r.ok ? r.servers : {};
};

// upsert/remove 대상 파일 — projectPath 지정 시 <projectPath>/.mcp.json, 아니면 <home>/mcp.json.
const resolveWriteFile = (projectPath?: string): string =>
  projectPath !== undefined && projectPath !== ""
    ? projectMcpPath(projectPath)
    : mcpJsonPath();

/**
 * 외부 MCP server 맵 — 전역 <home>/mcp.json + (cwd 가 프로젝트면) <cwd>/.mcp.json 병합.
 * 프로젝트가 같은 이름을 덮어쓴다(더 구체적). claude 어댑터가 네이티브 config 로 사용.
 * cwd 미지정/홈(마스터·비프로젝트 턴) = 전역만(회귀 0).
 */
export const readExternalMcpServers = async (
  cwd?: string,
): Promise<Record<string, ExternalMcpConfig>> => {
  const global = await readMcpFile(mcpJsonPath());
  if (!isProjectMcpCwd(cwd)) return global;
  const project = await readMcpFile(projectMcpPath(cwd));
  return { ...global, ...project }; // 프로젝트 우선.
};

/** 프로젝트 <cwd>/.mcp.json 만(전역 제외) — project_capabilities 표시용. */
export const readProjectMcpServers = async (
  cwd: string,
): Promise<Record<string, ExternalMcpConfig>> => {
  if (!isProjectMcpCwd(cwd)) return {};
  return readMcpFile(projectMcpPath(cwd));
};

/**
 * 같은 파일의 «읽기 → 고치기 → 쓰기» 를 **한 번에 하나씩** (2026-10-08 외부 검토 F3).
 * ★종전엔 각자 읽고 각자 써서, 서버 둘을 동시에 추가하면(병렬 도구 호출) 나중에 쓴 쪽이 먼저 쓴 쪽을 지웠다(재현 5/5).
 *  원자적 교체(rename)만으로는 이 논리적 유실이 안 막힌다 — 읽기부터 줄을 세워야 한다. 데몬 한 프로세스 안의 직렬화다.
 */
const fileQueues = new Map<string, Promise<unknown>>();
const withFileLock = async <T>(file: string, fn: () => Promise<T>): Promise<T> => {
  const prev = fileQueues.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  fileQueues.set(file, tail);
  try {
    return await run;
  } finally {
    if (fileQueues.get(file) === tail) fileQueues.delete(file);
  }
};

/**
 * 쓰기용 읽기 — **깨진 파일을 «빈 설정» 으로 읽지 않는다**, 그리고 `mcpServers` 밖의 최상위 키를 보존한다.
 * ★읽기 경로(`readMcpFile`)는 데몬 생존이 우선이라 깨지면 `{}` 인데, 쓰기가 그걸 그대로 쓰면 **다른 서버 전부와 다른 최상위 키**를
 *  지우고 덮는다(2026-10-08 적대 검토 — F3 이 막으려던 유실의 다른 입구). 없으면 빈 것, 깨졌으면 던진다.
 */
const readMcpFileForWrite = async (file: string): Promise<Record<string, unknown> & { mcpServers: Record<string, ExternalMcpConfig> }> => {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON — not overwriting it (fix or remove it first): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object — not overwriting it.`);
  }
  const top = parsed as Record<string, unknown>;
  const servers = top.mcpServers;
  return { ...top, mcpServers: servers !== null && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, ExternalMcpConfig>) : {} };
};

/**
 * 제자리 쓰기 — ★rename(원자 교체)을 쓰지 않는다 (2026-10-08 적대 검토 P4). 교체하면 심링크인 `.mcp.json` 이 일반 파일이 되고,
 *  사용자가 좁혀 둔 권한(0600 — env 에 토큰이 들어간다)이 넓어지고, 실패하면 임시 파일이 프로젝트에 남았다. 동시 쓰기 유실은
 *  위 `withFileLock` 이 막는다.
 */
const writeMcpFile = async (file: string, content: Record<string, unknown>): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(content, null, 2)}\n`, "utf8");
};

/** name→config upsert 후 파일 저장(디렉터리 ensure). projectPath = 프로젝트 .mcp.json 대상. */
export const upsertExternalMcpServer = async (
  name: string,
  config: ExternalMcpConfig,
  projectPath?: string,
): Promise<void> => {
  const file = resolveWriteFile(projectPath);
  await withFileLock(file, async () => {
    const doc = await readMcpFileForWrite(file);
    doc.mcpServers[name] = config;
    await writeMcpFile(file, doc);
  });
};

/** name 제거 후 저장. 존재 여부 반환. projectPath = 프로젝트 .mcp.json 대상. */
export const removeExternalMcpServer = async (
  name: string,
  projectPath?: string,
): Promise<boolean> => {
  const file = resolveWriteFile(projectPath);
  return withFileLock(file, async () => {
    const doc = await readMcpFileForWrite(file);
    if (!(name in doc.mcpServers)) return false;
    delete doc.mcpServers[name];
    await writeMcpFile(file, doc);
    return true;
  });
};

/** 사람이 읽는 한 줄 요약(list 도구·로그용). */
export const describeExternalMcpConfig = (
  name: string,
  c: ExternalMcpConfig,
): string =>
  "type" in c && c.type === "sse"
    ? `${name} (sse: ${c.url})`
    : `${name} (stdio: ${(c as StdioMcpConfig).command}${(c as StdioMcpConfig).args?.length ? " " + (c as StdioMcpConfig).args!.join(" ") : ""})`;

// ─── codex/openai 어댑터용 브리지 (Phase 2, ADR §1d) ─────────────────────────
// claude 는 SDK 네이티브(config 를 options.mcpServers 로)라 이 경로를 안 탄다.
// codex/openai 는 @mcp/sdk Client 로 외부 서버를 spawn+연결 → @openai/agents MCPServer
// shape 로 래핑(adaptClaudeMcpServer 동형, 단 소스가 in-process 아닌 외부 프로세스).
//
// ★설정은 매번 읽고, 연결은 맞춘다 (2026-10-16 — 정태님 «MCP 도 결국 데이터니까 그때그때 읽어들이는 방식»).
//  종전엔 전역이 프로세스당 1회·프로젝트가 첫 위임 1회 연결이라, 등록을 바꿔도 **재시작 전엔** Codex·OpenAI 에 안 보였다
//  (Claude 는 매 턴 다시 읽어 바로 보였다 — 어댑터 비대칭). 이제 연결을 받을 때마다 범위(전역/프로젝트)별로 서버 단위 비교:
//  새 것 연결 · 같은 설정은 재사용(매 턴 spawn 0) · 바뀐 것은 새로 연결하고 옛 것은 은퇴 · 빠진 것은 은퇴 · 끊긴 것은 다시 연결.
// ★턴은 **자기 래퍼**를 받는다 — 래퍼의 close() 는 «놓기» 다(어댑터가 이미 턴 끝에 부르는 자리). 은퇴한 연결은 쥔 턴이
//  0 이 될 때 실제로 닫는다 — 돌고 있는 턴이 쓰던 도구가 그 턴 도중에 끊기지 않는다.
// 실패 서버는 skip+로그(격리, #3). 실패는 영구 캐시하지 않는다(아래 RETRY_AFTER_MS).

const MCP_CALL_TIMEOUT_MS = ((): number => {
  const raw = process.env.MCP_CALL_TIMEOUT_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 660_000; // _mcp-bridge 와 동일 정책.
})();

type MCPTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];
type CallToolResultContent = Awaited<ReturnType<MCPServer["callTool"]>>;

interface CachedExt {
  server: MCPServer;
  realClose: () => Promise<void>;
  /** 연결이 끊겼나(대상 앱 종료·stdio 프로세스 사망) — 다음 맞추기가 다시 연결한다. */
  isDead: () => boolean;
}
/** 한 서버의 연결 — 설정 지문·쥔 턴 수·은퇴 여부. */
interface Conn extends CachedExt {
  fingerprint: string;
  holds: number;
  retired: boolean;
  closed: boolean;
}
/** 한 범위(전역 = "" / 프로젝트 = resolved 경로)의 연결들. 설정 읽기·맞추기는 범위마다 **한 번에 하나**(옛 읽기가 새 읽기를
 *  덮지 않게). ★연결 자체는 줄 **밖**(백그라운드)에서 한다 — 줄 안에서 기다리면 응답 없는 서버 하나가 그 범위의 **모든 턴**을
 *  SDK 연결 시한(60초)만큼 막았다(적대 검토 F2 실측: 무관한 턴이 59.5초 대기, 2분마다 반복). 끝난 연결은 그때의 설정(`desired`)과
 *  지문이 같을 때만 게시한다 — 연결 중 설정이 또 바뀌었으면 버린다. */
interface Scope {
  conns: Map<string, Conn>;
  failed: Map<string, { fingerprint: string; at: number }>;
  /** 진행 중인 연결 — `waitMs` 는 그 연결을 턴이 기다리는 최대 시간(처음 붙는 설정 `CONNECT_WAIT_MS` · 실패한 설정의 재시도 `RETRY_WAIT_MS`). */
  connecting: Map<string, { fingerprint: string; done: Promise<void>; waitMs: number }>;
  desired: Record<string, ExternalMcpConfig>;
  queue: Promise<unknown>;
  unreadableWarned: boolean;
  /** shutdown 이 닫은 범위 — 늦게 끝난 연결은 게시하지 않고 바로 닫는다(적대 검토 F3: 고아 연결). */
  closed: boolean;
}
const GLOBAL_SCOPE = "";
/** 은퇴했지만 아직 턴이 쥔 연결 — 범위 목록엔 없으니 shutdown 이 여기서 찾아 닫는다. */
const retiredHeld = new Set<Conn>();
const scopes = new Map<string, Scope>();
const scopeOf = (key: string): Scope => {
  let sc = scopes.get(key);
  if (sc === undefined) {
    sc = { conns: new Map(), failed: new Map(), connecting: new Map(), desired: {}, queue: Promise.resolve(), unreadableWarned: false, closed: false };
    scopes.set(key, sc);
  }
  return sc;
};
/**
 * 연결에 실패한 서버를 **같은 설정으로** 다시 시도하기까지의 간격.
 * ★매 턴 다시 띄우면 실패하는 서버 하나가 턴마다 프로세스를 띄우고 턴을 늦춘다(연결 시한이 SDK 기본 60초). 영구로 접으면
 *  대상 앱(Unity·Godot 에디터)을 켜도 재시작 전엔 안 붙는다 — 종전 결함 그대로다. 그 사이: 켜고 1분 안에 붙는다.
 *  설정이 바뀌면(지문이 다르면) 기다리지 않고 바로 다시 시도한다.
 */
const RETRY_AFTER_MS = 60_000;
/**
 * 턴이 **처음 붙는 서버**를 기다리는 최대 시간. 보통 몇 초 안에 뜨니 등록한 다음 턴에 바로 보이고, 그보다 느린 서버(첫 `npx` 설치,
 *  백엔드를 기다리는 서버)는 턴을 붙잡지 않고 **그다음 턴**에 붙는다.
 */
const CONNECT_WAIT_MS = 15_000;
/**
 * 실패했던 설정의 재시도를 턴이 기다리는 최대 시간. ★0 이면 대상 앱을 켠 뒤 **첫 턴엔 언제나** 도구가 없었다(재시도를 그 턴이
 *  일으키고 안 기다림 — 재검토 P2, 종전엔 첫 턴부터 붙었다). 길면 응답 없는 서버가 재시도 간격마다 턴을 그만큼 늦춘다 —
 *  켜져 있는 앱은 보통 바로 답하니 짧게 둔다(최악 비용 = 1분에 한 번, 이만큼).
 */
const RETRY_WAIT_MS = 3_000;

// ★외부 MCP 자식 pid 집합 (2026-07-28) — 정상 종료는 close() 가 맡지만 그건 async 라
//  force-exit(1500ms 백스톱)·크래시 경로에선 실행될 시간이 없다. 실측: /restart 두 건에서
//  종료 시작 2초 뒤 force exit 이 떴고 그 사이 자식 정리 로그가 없었다. 그 구멍을
//  process.on("exit") 의 **동기** 리퍼가 이 집합으로 닫는다(고아 0). 외부 MCP 는 부팅
//  reaper 도 없어 한 번 새면 영구 고아라 특히 중요하다.
const EXTERNAL_MCP_PIDS = new Set<number>();

/**
 * 추적 중인 외부 MCP 자식을 **동기로** 종료. process.on("exit") 전용(그 훅은 async 를
 * 못 기다린다). 정상 경로는 closeAllExternalMcp 가 먼저 지우므로 보통 빈 집합이다.
 * 실패는 전부 무시 — 종료 중이라 할 수 있는 게 없고, 한 건 실패가 나머지를 막으면 안 된다.
 */
let extMcpExitHookInstalled = false;
/** 최후 그물 등록(1회) — 첫 stdio 자식이 생길 때 건다(자식 없으면 훅도 없음). */
const ensureExternalMcpExitHook = (): void => {
  if (extMcpExitHookInstalled) return;
  extMcpExitHookInstalled = true;
  process.on("exit", () => {
    try {
      const n = killExternalMcpChildrenSync();
      if (n > 0) console.log(`external-mcp: exit 훅 최후 정리 — ${n}건 강제 종료`);
    } catch {
      /* 종료 중 */
    }
  });
};

export const killExternalMcpChildrenSync = (): number => {
  let killed = 0;
  for (const pid of EXTERNAL_MCP_PIDS) {
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      /* 이미 죽음/권한 — 무시 */
    }
  }
  EXTERNAL_MCP_PIDS.clear();
  return killed;
};

/**
 * 외부 MCP 자식에게 넘길 env (2026-07-31 전체검토 P0).
 *
 * ★종전엔 `process.env` 를 **통째로** 넘겼다. MCP SDK 는 이 필드를 주면 자기 안전
 *  기본값을 **통째로 대체**한다(`stdio.js`: `{...getDefaultEnvironment(), ...serverParams.env}`,
 *  기본값은 HOME·LOGNAME·PATH·SHELL·TERM·USER 6개뿐이고 주석에 "deemed safe to inherit").
 *  즉 SDK 가 일부러 막아둔 걸 우리가 되돌렸다. 실측(실제 자식 spawn 후 env 덤프):
 *  ANTHROPIC_API_KEY · CLAUDE_CODE_OAUTH_TOKEN · OPENAI_API_KEY ·
 *  OPENAI_CODEX_OAUTH_TOKEN · OPENAI_CODEX_OAUTH_REFRESH · TELEGRAM_BOT_TOKEN ·
 *  HTTP_BRIDGE_TOKEN · GOOGLE_GENERATIVE_AI_API_KEY — 8종이 그대로 상속됐다.
 *
 *  `add_mcp_server` 는 **비서가 스스로 쓰라고 만든 도구**다. 사용자가 검토하지 않은 npm
 *  패키지가 그 자리에 오는 게 정상 경로이고, 악성/침해 패키지 하나면 계정 3종이 넘어간다.
 *
 * 정책: **allowlist 가 아니라 판정**이다 — 시크릿으로 보이는 키를 뺀다(이름 열거는
 * 드리프트한다). 서버가 **명시적으로 요구한** env(`config.env`)는 그대로 넘긴다 —
 * 그건 사용자가 mcp.json 에 직접 적은 것이라 의도된 위임이다.
 */

/**
 * 자식 프로세스에 물려줄 env — 시크릿류는 빼고, `mcp.json` 에 사용자가 직접 적은
 * `env` 만 의도된 위임으로 통과시킨다.
 *
 * ★export 인 이유(2026-07-31): 이게 모듈 안에 숨어 있던 탓에 이걸 지킨다는 회귀 검사가
 *  **grep 과 항등식**으로 쓰였고, 경계를 통째로 되돌려도 스위트가 초록이었다.
 *  `parentEnv` 를 주입받는 것도 같은 이유다 — `process.env` 를 흔들지 않고 판정만 볼 수 있다.
 *
 * ⚠**이 함수는 경계 전체가 아니다.** 유일한 호출부는 아래 `connectOne`(codex/openai
 *  브리지 경로)이고, claude 어댑터는 config 를 SDK 에 그대로 넘겨 **자기가 spawn** 한다
 *  (`claude-agent-sdk.ts` 의 `options.mcpServers`) — 그 경로는 여기를 지나지 않는다.
 *  claude CLI 는 `env` 를 줘도 부모 env 를 **대체가 아니라 병합**하므로 config 로는 못 막는다.
 *  미해결 갭 = `docs/decisions/2026-07-31-review-round3.md` A1/C1.
 */
export const buildChildEnv = (
  extra?: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    // 시크릿류는 상속시키지 않는다. ★단 값이 **실제 파일 경로**면 비밀이 아니라 위치다(`GOOGLE_APPLICATION_CREDENTIALS`·
    //  `AWS_SHARED_CREDENTIALS_FILE`) — 지우면 gcloud·aws·terraform 이 깨진다(2026-10-09 재검토).
    if (SECRET_KEY_NAME_RE.test(k) && !(path.isAbsolute(v) && existsSync(v))) continue;
    base[k] = v;
  }
  // 명시 지정분은 그대로(사용자가 mcp.json 에 적은 의도된 위임 — 시크릿이어도 통과).
  return { ...base, ...(extra ?? {}) };
};

const connectOne = async (
  name: string,
  config: ExternalMcpConfig,
): Promise<CachedExt> => {
  const client = new Client(
    { name: `tiguclaw-ext-${name}`, version: "1.0.0" },
    { capabilities: {} },
  );
  // 끊김 표시 — 전송이 닫히면(자식 종료·SSE 끊김) SDK 가 부른다. 다음 맞추기가 이걸 보고 다시 연결한다.
  let dead = false;
  client.onclose = () => {
    dead = true;
  };
  const transport =
    "type" in config && config.type === "sse"
      ? new SSEClientTransport(new URL(config.url))
      : new StdioClientTransport({
          command: (config as StdioMcpConfig).command,
          args: (config as StdioMcpConfig).args,
          env: buildChildEnv((config as StdioMcpConfig).env),
        });
  // 실제 프로세스 spawn(stdio) 또는 SSE 연결. 실패하면 SDK 가 스스로 닫는다(`Client.connect` 의 catch → close) — 재시도가
  //  자식을 쌓지 않는 근거다(회귀 mcp-config-hot-reload ⑧ 이 지킨다).
  await client.connect(transport);
  // SSE 는 연결 오류를 onclose 가 아니라 **전송의** onerror 로만 알린다(SDK sse.js) — 그대로 두면 끊겨도 «살아 있음» 이라 다시
  //  연결할 길이 없었다(적대 검토 F5). ★클라이언트의 onerror 가 아니라 전송의 것에 건다 — 클라이언트 쪽은 깨진 메시지·늦은 응답
  //  같은 비치명 오류도 내서, 한 건에 매번 재연결(서버 세션 상태 유실)했다(재검토 P3). 연결 뒤에 감싼다(connect 가 자기 것을 건다).
  if (transport instanceof SSEClientTransport) {
    const prev = transport.onerror;
    transport.onerror = (err) => {
      dead = true;
      prev?.(err);
    };
  }
  // 자식 pid 등록 — 동기 리퍼(killExternalMcpChildrenSync)의 대상. SSE 전송은 자식이
  // 없으므로 pid 도 없다(instanceof 로 구분 — stdio 만 등록).
  if (transport instanceof StdioClientTransport) {
    const pid = transport.pid;
    if (typeof pid === "number" && pid > 0) {
      EXTERNAL_MCP_PIDS.add(pid);
      ensureExternalMcpExitHook(); // 자식이 생겼다 = 최후 그물 필요(1회, 멱등).
    }
  }
  const server: MCPServer = {
    cacheToolsList: false, // SDK 에 넘기는 건 턴별 래퍼(leaseOf)다 — 거기와 같게.
    get name() {
      return name;
    },
    async connect() {
      /* 이미 연결됨(persistent) — no-op */
    },
    async close() {
      /* ★no-op — per-turn 일괄 close 가 외부 연결을 끊지 않게. 실종료=closeAllExternalMcp. */
    },
    async listTools(): Promise<MCPTool[]> {
      const res = await client.listTools();
      return res.tools as unknown as MCPTool[];
    },
    async callTool(
      toolName: string,
      args: Record<string, unknown> | null,
    ): Promise<CallToolResultContent> {
      const res = await client.callTool(
        { name: toolName, arguments: args ?? {} },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS },
      );
      return res.content as CallToolResultContent;
    },
    async invalidateToolsCache() {
      /* cache 미사용 */
    },
  };
  // 정상 종료 시 추적에서 뺀다 — 안 그러면 exit 훅이 이미 죽은 pid 를 다시 kill 하며
  // "최후 정리 N건" 을 잘못 찍는다(그 로그는 "정상 정리를 못 탔다"는 신호여야 한다).
  const trackedPid =
    transport instanceof StdioClientTransport ? transport.pid : null;
  return {
    server,
    realClose: async () => {
      try {
        await client.close();
      } finally {
        if (typeof trackedPid === "number") EXTERNAL_MCP_PIDS.delete(trackedPid);
      }
    },
    isDead: () => dead,
  };
};

/** 실제로 닫는다(멱등) — 은퇴했고 쥔 턴이 없을 때, 또는 shutdown. */
const closeConn = async (c: Conn): Promise<void> => {
  if (c.closed) return;
  c.closed = true;
  retiredHeld.delete(c);
  try {
    await c.realClose();
  } catch {
    /* 이미 죽었을 수 있음 */
  }
};

const scopeLabel = (key: string): string => (key === GLOBAL_SCOPE ? "" : `[project ${key}] `);

/** 은퇴 — 더는 새 턴에 내주지 않는다. 쥔 턴이 없으면 바로 닫고, 있으면 마지막 턴이 놓을 때 닫는다. */
const retire = (sc: Scope, key: string, name: string, c: Conn, why: string): void => {
  sc.conns.delete(name);
  c.retired = true;
  console.log(`external-mcp: ${scopeLabel(key)}'${name}' ${why} — ${c.holds === 0 ? "닫음" : `쥔 턴 ${c.holds}개가 끝나면 닫음`}.`);
  if (c.holds === 0) void closeConn(c);
  else retiredHeld.add(c);
};

/** 서버 하나를 백그라운드로 연결한다 — 끝나면 그때의 설정과 지문이 같을 때만 게시, 아니면(바뀜·빠짐·종료) 바로 닫는다. */
const startConnect = (sc: Scope, key: string, name: string, config: ExternalMcpConfig, fingerprint: string, waitMs: number): void => {
  const entry = { fingerprint, waitMs, done: Promise.resolve() };
  entry.done = (async () => {
    try {
      const ext = await connectOne(name, config);
      const want = sc.desired[name];
      if (sc.closed || want === undefined || JSON.stringify(want) !== fingerprint || sc.conns.has(name)) {
        await ext.realClose().catch(() => undefined);
        return;
      }
      sc.conns.set(name, { ...ext, fingerprint, holds: 0, retired: false, closed: false });
      sc.failed.delete(name);
      console.log(`external-mcp: ${scopeLabel(key)}'${name}' 연결됨 (${describeExternalMcpConfig(name, config)}).`);
    } catch (e) {
      // ★지금 시도일 때만 실패로 적는다 — 설정이 바뀌어 대체된 옛 시도가 늦게 실패하면, 그 사이 붙은 연결 위에 실패 기록이 남아
      //  그 연결이 끊겼을 때 최대 1분 다시 안 붙었다(재검토 P3).
      if (sc.closed || sc.connecting.get(name) !== entry) return;
      // 격리 — 한 서버 실패가 나머지·데몬을 죽이지 않게(#3).
      sc.failed.set(name, { fingerprint, at: Date.now() });
      console.error(
        `external-mcp: ${scopeLabel(key)}'${name}' 연결 실패 — skip, 같은 설정이면 ${RETRY_AFTER_MS / 1000}초 뒤 다시 시도 (${e instanceof Error ? e.message : String(e)}).`,
      );
    } finally {
      if (sc.connecting.get(name) === entry) sc.connecting.delete(name);
    }
  })();
  sc.connecting.set(name, entry);
};

/** 한 범위를 설정에 맞춘다 — 범위의 줄 안에서만, **기다리지 않고**(연결은 백그라운드). */
const reconcile = (sc: Scope, key: string, servers: Record<string, ExternalMcpConfig>): void => {
  sc.desired = servers;
  for (const [name, c] of [...sc.conns]) {
    const want = servers[name];
    if (want === undefined) retire(sc, key, name, c, "설정에서 빠짐");
    else if (JSON.stringify(want) !== c.fingerprint) retire(sc, key, name, c, "설정이 바뀜 — 새로 연결");
    else if (c.isDead()) retire(sc, key, name, c, "연결이 끊겨 있음 — 다시 연결");
  }
  for (const name of [...sc.failed.keys()]) if (servers[name] === undefined) sc.failed.delete(name);
  for (const [name, config] of Object.entries(servers)) {
    if (sc.conns.has(name)) continue;
    const fingerprint = JSON.stringify(config);
    if (sc.connecting.get(name)?.fingerprint === fingerprint) continue; // 이미 붙는 중
    const failed = sc.failed.get(name);
    const retry = failed !== undefined && failed.fingerprint === fingerprint;
    if (retry && Date.now() - failed.at < RETRY_AFTER_MS) continue;
    startConnect(sc, key, name, config, fingerprint, retry ? RETRY_WAIT_MS : CONNECT_WAIT_MS);
  }
};

/** 턴 하나가 쥐는 래퍼 — close() = 놓기(멱등). 은퇴한 연결은 마지막으로 쥔 턴이 놓을 때 닫힌다. */
const leaseOf = (c: Conn): MCPServer => {
  c.holds += 1;
  let released = false;
  return {
    // ★목록 캐시 끔 — @openai/agents 는 도구 목록을 **프로세스 전역**에 서버 이름 키로 캐시해, 같은 이름의 서버를 바꿔도 옛 도구를
    //  계속 냈다(적대 검토 F1 실측: 새 도구가 재시작 전까지 안 보이고 옛 이름 호출은 «not found»). 턴마다 어차피 probe 가 목록을 읽는다.
    cacheToolsList: false,
    get name() {
      return c.server.name;
    },
    async connect() {
      /* 이미 연결됨 — no-op */
    },
    async close() {
      if (released) return;
      released = true;
      c.holds -= 1;
      if (c.retired && c.holds === 0) await closeConn(c);
    },
    listTools: () => c.server.listTools(),
    callTool: (toolName, args) => c.server.callTool(toolName, args),
    async invalidateToolsCache() {
      /* cache 미사용 */
    },
  };
};

/** 범위 하나를 지금 설정에 맞추고(줄 안) 붙는 중인 것을 짧게 기다린 뒤(줄 밖) 그 연결들을 쥔다. 쥐는 순간의 `sc.conns` 엔
 *  은퇴하지 않은 연결만 있다 — 은퇴는 목록에서 빼는 것과 동시라 쥐기와 사이에 끼지 않는다. */
const acquireScope = (key: string, file: string): Promise<MCPServer[]> => {
  const sc = scopeOf(key);
  const run = sc.queue.then(async () => {
    const r = await readMcpFileState(file);
    if (r.ok) {
      sc.unreadableWarned = false;
      reconcile(sc, key, r.servers);
    } else if (!sc.unreadableWarned) {
      // 못 읽으면 지금 연결을 그대로 둔다 — 쓰는 중이거나 반쯤 저장된 파일로 연결을 닫지 않는다. 같은 상태가 이어지면 한 번만 말한다.
      sc.unreadableWarned = true;
      console.warn(`external-mcp: ${scopeLabel(key)}설정 파일을 못 읽음 — 지금 연결 ${sc.conns.size}개를 그대로 둔다 (${file}: ${r.reason}).`);
    }
    // 지금 설정에 남아 있는 것만 기다린다 — 설정에서 뺀(또는 바뀐) 서버의 연결을 다음 턴이 계속 기다리던 것(재검토 P3).
    return [...sc.connecting.entries()]
      .filter(([name, p]) => sc.desired[name] !== undefined && JSON.stringify(sc.desired[name]) === p.fingerprint)
      .map(([, p]) => p);
  });
  sc.queue = run.catch(() => undefined);
  return run.then(async (pending) => {
    // **짧게** 기다린다(줄 밖) — 느린 것은 다음 턴에, 기다리는 동안 다른 턴은 막히지 않는다.
    await Promise.all(pending.map((p) => waitAtMost(p.done, p.waitMs)));
    return [...sc.conns.values()].map(leaseOf);
  });
};

/** p 를 최대 ms 만큼 기다린다(시한이 지나도 p 는 계속 돈다). */
const waitAtMost = async (p: Promise<void>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    p,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
};

/**
 * codex/openai 어댑터가 턴마다 호출 — 지금 설정에 맞춘 외부 MCP 브리지(턴별 래퍼). ★받은 래퍼는 턴 끝에 **반드시 close()**
 * (= 놓기) 한다 — 안 놓으면 설정이 바뀐 옛 연결이 shutdown 까지 안 닫힌다.
 * cwd 가 프로젝트면 그 프로젝트 <cwd>/.mcp.json 을 전역에 더한다(같은 이름이면 프로젝트 우선 — 가려진 전역 래퍼는 바로 놓는다).
 * 마스터/비프로젝트 턴(cwd 미지정) = 전역만.
 */
export const getConnectedExternalMcpBridges = async (
  cwd?: string,
): Promise<MCPServer[]> => {
  const globalBridges = await acquireScope(GLOBAL_SCOPE, mcpJsonPath());
  if (!isProjectMcpCwd(cwd)) return globalBridges;
  const key = path.resolve(cwd);
  const projectBridges = await acquireScope(key, projectMcpPath(key));
  if (projectBridges.length === 0) return globalBridges;
  const names = new Set(projectBridges.map((b) => b.name));
  const kept: MCPServer[] = [];
  for (const b of globalBridges) {
    if (names.has(b.name)) await b.close(); // 프로젝트가 같은 이름을 덮어씀 — 쓰지 않을 래퍼는 바로 놓는다.
    else kept.push(b);
  }
  return kept.concat(projectBridges);
};

/** 데몬 shutdown 시 외부 MCP 프로세스 실제 종료(orphan 0). 전역 + 프로젝트 모두 — 쥔 턴과 무관하게 닫는다. */
export const closeAllExternalMcp = async (): Promise<void> => {
  const all = [...scopes.values()];
  scopes.clear();
  for (const sc of all) {
    sc.closed = true; // 진행 중인 연결은 끝나는 대로 스스로 닫는다(게시 안 함).
    for (const c of sc.conns.values()) await closeConn(c);
    sc.conns.clear();
  }
  for (const c of [...retiredHeld]) await closeConn(c);
};
