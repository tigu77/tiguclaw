/**
 * 데이터 기반 커스텀 HTTP 엔드포인트 registry — `command-registry.ts` 완전 동형.
 *
 * 진실 소스:
 *  - architect contract: `_workspace/custom-endpoints_architect.md` (§1·§2·§3·§4).
 *  - 동형 패턴: `command-registry.ts`(매-요청 발견·3-source walk·dedup·frontmatter 재사용).
 *
 * 한 줄: 엔드포인트 = **슬래시 명령의 HTTP 판**. `<home>/endpoints/<name>.md`(frontmatter +
 *  프롬프트 템플릿)를 http-bridge 가 매-요청 발견해 서빙한다. 임의 코드 0 = 데이터만.
 *  재시작 불요. command-registry 의 walk/dedup/frontmatter 인프라를 그대로 재사용 — 신규
 *  파서·신규 dep 0 (E-I2).
 *
 * 안전(§4):
 *  - 정의 `mode` 기본 `restricted` → http-bridge 가 `toolPolicy:{mode:"none"}` 로 실행(도구 0).
 *  - `role` 기본 `write`(read 폴백 금지 — 무인 트리거, E-I8).
 *  - 빌트인 경로 보호는 *서빙 레벨*(http-bridge 가 빌트인 분기 뒤에서만 findEndpoint 호출).
 *    registry 자체는 빌트인 인지 책임 없음 — 발견·정규화만.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../llm-runtime/capabilities/skill-registry.js";
import { dedupeBySource } from "../llm-runtime/capabilities/dedup-by-source.js";
import { appRoot, getPaths } from "../paths.js";

export type EndpointMethod = "GET" | "POST";
export type EndpointRole = "read" | "write" | "admin";
export type EndpointMode = "restricted" | "full";

export interface Endpoint {
  /** 파일 basename (확장자 제외). dedup 충돌 키 + 인덱스/threadKey 식별자. */
  name: string;
  /** 정규화된 라우트 경로 ("/weather"). 슬래시 시작 강제·소문자·끝 슬래시 제거. */
  routePath: string;
  /** 정규화된 HTTP 메서드. MVP = GET|POST. 기본 POST. */
  method: EndpointMethod;
  /** 인증 게이트 role. 기본 write(read 폴백 금지 — 무인 트리거). bridge-tokens 동형. */
  role: EndpointRole;
  /** 실행 제한. restricted(기본) = toolPolicy none, full = 전체 도구(소유자 명시만). */
  mode: EndpointMode;
  /**
   * 실행 **모델 프로파일 이름**(settings.json `models.profiles` 키, 예 `high`).
   * 빈 문자열 = 미지정 = 기본 풀(현행). 프로파일 이름만 받는다 — 벤더 모델명을 데이터
   * 파일에 박으면 모델 교체 때 같이 썩는다(에이전트 `model:` 과 같은 취지).
   */
  model: string;
  /** frontmatter `label`(인덱스 표시용). 없으면 "". */
  label: string;
  /** frontmatter `desc`(인덱스 표시용). 없으면 "". */
  desc: string;
  /** absolute .md path. expandEndpoint 가 매 호출 read. */
  filePath: string;
  /** 발견 출처 — "user" | "project" | "plugin". */
  source: "user" | "project" | "plugin";
  /** source === "plugin" 시 plugin id. */
  pluginId?: string;
}

/**
 * 라우트 경로 정규화 (§1 필드 규칙):
 *  - 슬래시로 시작 강제(`weather` → `/weather`).
 *  - 소문자.
 *  - 끝 슬래시 제거(단, 루트 "/" 보존 — 하지만 빌트인 충돌이라 실사용 X).
 * 빈 입력은 빈 문자열 반환(호출자가 스킵 판정).
 */
const normalizeRoutePath = (raw: string): string => {
  let p = raw.trim().toLowerCase();
  if (p === "") return "";
  if (!p.startsWith("/")) p = `/${p}`;
  // 끝 슬래시 제거 (루트 "/" 는 그대로).
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
};

/** method 정규화 — 대문자. MVP는 GET/POST 만, 그 외는 POST 폴백. */
const normalizeMethod = (raw: string | undefined): EndpointMethod => {
  const m = (raw ?? "").trim().toUpperCase();
  return m === "GET" ? "GET" : "POST";
};

/** role 정규화 — 기본 write(read 폴백 금지, E-I8). 미지정/무효 → write. */
const normalizeRole = (raw: string | undefined): EndpointRole => {
  const r = (raw ?? "").trim().toLowerCase();
  return r === "read" || r === "admin" ? r : "write";
};

/** mode 정규화 — 기본 restricted(E-I7). full 은 명시만. */
const normalizeMode = (raw: string | undefined): EndpointMode => {
  const m = (raw ?? "").trim().toLowerCase();
  return m === "full" ? "full" : "restricted";
};

/**
 * 세 source walk → 모든 엔드포인트 정의 회수 (command-registry.discoverCommands 동형).
 * cwd 기본값 `process.cwd()` → 무인자 호출은 home/plugin 중심 발견(회귀 무관, 신규 기능).
 * cwd 는 user/project 발견에만 영향 — plugins 줄은 앱 번들(appRoot, cwd 무관).
 * 미존재 디렉터리는 빈 배열(데몬 생존 — fs 실패 격리).
 *
 * 동일 name 충돌 dedup(`dedupeBySource`): project > user > plugin override, 이름당 1개.
 */
export const discoverEndpoints = async (
  cwd: string = process.cwd(),
): Promise<Endpoint[]> => {
  const userRoot = getPaths().commonEndpoints;
  const projectRoot = path.join(cwd, "endpoints");
  // 플러그인 2루트 (command-registry 2026-05-27 패턴): 번들(appRoot) + 유저 설치(<home>/plugins).
  const bundledPluginsRoot = path.join(appRoot(), "plugins");
  const homePluginsRoot = getPaths().commonPlugins;

  const [userEps, projectEps, bundledPluginEps, homePluginEps] =
    await Promise.all([
      walkEndpointsDir(userRoot, "user"),
      walkEndpointsDir(projectRoot, "project"),
      walkPluginsEndpoints(bundledPluginsRoot),
      walkPluginsEndpoints(homePluginsRoot),
    ]);

  return dedupeBySource([
    ...userEps,
    ...projectEps,
    ...bundledPluginEps,
    ...homePluginEps,
  ]);
};

/**
 * 단일 endpoints 디렉터리 walk — 안의 `*.md` 파일 직접 순회 (walkCommandsDir 동형).
 * 부재 디렉터리는 빈 배열.
 */
const walkEndpointsDir = async (
  root: string,
  source: "user" | "project" | "plugin",
): Promise<Endpoint[]> => {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return [];
  }

  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(rootReal, { withFileTypes: true });
  } catch {
    return [];
  }

  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => path.join(rootReal, e.name))
    .sort((a, b) => a.localeCompare(b));

  const loaded = await Promise.all(
    mdFiles.map((filePath) => loadSingleEndpoint(filePath, source)),
  );
  return loaded.filter((e): e is Endpoint => e !== null);
};

/** `<root>/<plugin>/endpoints/` walk — walkPluginsCommands 동형. */
const walkPluginsEndpoints = async (
  pluginsRoot: string,
): Promise<Endpoint[]> => {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const pluginDirs = entries
    .filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules",
    )
    .map((e) => ({ id: e.name, dir: path.join(pluginsRoot, e.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const perPlugin = await Promise.all(
    pluginDirs.map(async ({ id, dir }) => {
      const epsDir = path.join(dir, "endpoints");
      const eps = await walkEndpointsDir(epsDir, "plugin");
      return eps.map((e) => ({ ...e, pluginId: id }));
    }),
  );

  return perPlugin.flat();
};

/**
 * 단일 정의 .md → Endpoint 객체. loadSingleCommand 동형이나 frontmatter 가 **필수**
 * (`path` 가 라우트 식별자라 없으면 서빙 불가). frontmatter 부재·`path` 부재 시 null 스킵
 * (command-registry 의 name-empty 스킵 동형). read 실패도 null.
 */
const loadSingleEndpoint = async (
  filePath: string,
  source: "user" | "project" | "plugin",
): Promise<Endpoint | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const name = path.basename(filePath, ".md").trim();
  if (name === "") return null;

  const frontmatter = parseFrontmatter(raw);
  // path 필수 — 없으면 서빙 불가 정의이므로 스킵(깨진 정의가 인덱스 오염 X).
  const routePath = normalizeRoutePath(frontmatter?.path ?? "");
  if (routePath === "") return null;

  return {
    name,
    routePath,
    method: normalizeMethod(frontmatter?.method),
    role: normalizeRole(frontmatter?.role),
    mode: normalizeMode(frontmatter?.mode),
    // ★실행 프로파일 (2026-08-01) — 엔드포인트도 에이전트·스킬과 같은 **데이터**이고,
    //  에이전트는 이미 자기 정의에 `model` 을 선언한다. 같은 부류인데 하나만 못 하는 건
    //  비대칭이다(능력은 데이터). **프로파일 이름만** 받는다 — 데이터 파일에 벤더 모델명을
    //  박으면 모델이 바뀔 때 같이 썩는다. 프로파일은 의도("high")를 선언하므로 따라온다.
    //  미지정 = 현행(기본 풀) — 회귀 0.
    model: (frontmatter?.model ?? "").trim(),
    label: (frontmatter?.label ?? "").trim(),
    desc: (frontmatter?.desc ?? "").trim(),
    filePath: path.resolve(filePath),
    source,
  };
};

/**
 * (routePath, method) 정확 매치 1개. 미발견 undefined. http-bridge 가 매-요청 호출(E-I1).
 *  - routePath 는 호출 측 pathname 그대로(빌트인 미매칭 후) — 동일 정규화로 비교.
 *  - 발견 정의가 여럿이면 discoverEndpoints 가 이미 name dedup 했으므로, routePath+method
 *    충돌은 정의 작성자 책임(첫 매치 반환). 빌트인 충돌은 http-bridge 가 분기 순서로 차단.
 */
export const findEndpoint = async (
  routePath: string,
  method: string,
  cwd: string = process.cwd(),
): Promise<Endpoint | undefined> => {
  const targetPath = normalizeRoutePath(routePath);
  const targetMethod = normalizeMethod(method);
  if (targetPath === "") return undefined;
  const endpoints = await discoverEndpoints(cwd);
  return endpoints.find(
    (e) => e.routePath === targetPath && e.method === targetMethod,
  );
};

/**
 * 정의 본문(frontmatter 제거) → 파라미터 치환된 최종 프롬프트. expandCommand 동형.
 *  - 본문에서 frontmatter 블록 제거.
 *  - `$BODY`/`$ARGUMENTS`(alias) → raw body 문자열, `$QUERY` → query string 치환(§3).
 *    단순 문자열 replaceAll — JSON path 추출·타입 강제 0(E-I3, 후속 YAGNI).
 *  - read 실패 시 undefined.
 *
 * ★`$QUERY` 에서 **인증 파라미터는 잘라낸다** (2026-07-31 전체검토 P0, 실증됨).
 *  이 배포는 EventSource 가 헤더를 못 실어서 `?token=` 을 1급 인증 수단으로 쓴다. 그런데
 *  `$QUERY` 가 `url.search` 를 통째로 넘겨서, 엔드포인트를 호출한 사용자의 **write 토큰**이
 *  ①프롬프트로 들어가 외부 LLM 제공자에게 송신되고 ②`endpoint.call` 이벤트에 실려
 *  **read 토큰 청취자**에게 흘러가고 ③`transcripts` 에 평문으로 영구 적재됐다(FTS 색인까지).
 *  실증: read 토큰만으로 SSE 를 듣다가 write 토큰을 획득해 `POST /messages` 200 성공.
 *  `redactSecrets` 로는 못 막는다 — 그건 **env 값 매칭**인데 이 토큰은 `bridge_tokens` DB
 *  발급본이라 env 에 없다(즉 role 계층이 스스로 찍어낸 자격증명만 열려 있었다).
 *  → 프롬프트에 인증 값이 **애초에 안 들어가게** 한다(사후 redact 가 아니라 미생성).
 */
const AUTH_QUERY_PARAMS = new Set(["token", "access_token", "api_key", "apikey", "key"]);

/** 인증 파라미터를 뺀 query string. 나머지 파라미터·순서는 보존한다. */
export const stripAuthParams = (query: string): string => {
  const q = query.startsWith("?") ? query.slice(1) : query;
  if (q === "") return query;
  const kept: string[] = [];
  let removed = 0;
  for (const pair of q.split("&")) {
    if (pair === "") continue;
    const name = decodeURIComponent(pair.split("=")[0] ?? "").toLowerCase();
    if (AUTH_QUERY_PARAMS.has(name)) {
      removed += 1;
      continue;
    }
    kept.push(pair);
  }
  // 잘렸다는 사실은 남긴다 — 조용히 지우면 "왜 파라미터가 없지" 로 오진한다.
  const suffix = removed > 0 ? `${kept.length > 0 ? "&" : ""}__auth_removed=${removed}` : "";
  const body = kept.join("&") + suffix;
  return body === "" ? "" : `?${body}`;
};
export const expandEndpoint = async (
  ep: Endpoint,
  params: { body: string; query: string },
): Promise<string | undefined> => {
  let raw: string;
  try {
    raw = await fs.readFile(ep.filePath, "utf8");
  } catch {
    return undefined;
  }
  const body = stripFrontmatter(raw).trim();
  return body
    .replaceAll("$BODY", params.body)
    .replaceAll("$ARGUMENTS", params.body)
    .replaceAll("$QUERY", stripAuthParams(params.query));
};

/**
 * 정의 본문에서 frontmatter 블록 제거 → 순수 프롬프트 템플릿 반환.
 * command-registry.stripFrontmatter 동형(인프라 재사용이나 module-private 이라 복제 1개).
 */
const stripFrontmatter = (raw: string): string => {
  const head = raw.replace(/^﻿/, "");
  if (!head.startsWith("---")) return raw;
  const afterOpen = head.slice(3);
  const closeMatch = afterOpen.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (closeMatch === null || closeMatch.index === undefined) return raw;
  const bodyStart = 3 + closeMatch.index + closeMatch[0].length;
  return head.slice(bodyStart);
};

/**
 * 엔드포인트 인덱스 (list_endpoints 도구·도움말 등 향후 활용). formatCommandIndex 동형.
 * 비어 있으면 빈 문자열.
 */
export const formatEndpointIndex = (
  endpoints: ReadonlyArray<Endpoint>,
): string => {
  if (endpoints.length === 0) return "";
  const lines = endpoints.map((e) => {
    const tail = e.label || e.desc ? ` — ${e.label || e.desc}` : "";
    return `- ${e.method} ${e.routePath} (${e.role}/${e.mode})${tail}`;
  });
  return lines.join("\n");
};
