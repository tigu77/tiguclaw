/**
 * 데이터 기반 커스텀 HTTP 엔드포인트 — 등록/조회/삭제 MCP 도구 (region 파트).
 *
 * 진실 소스: architect contract `_workspace/custom-endpoints_architect.md`
 *  (§4-A 등록 게이트는 *스킬* 책임, §5 도구 = 기계적 검증/쓰기, 불변식 E-I5·E-I7·E-I8).
 * 동형 패턴: `worker-registry.ts` `createWorkerMcpServer` (LLM-agnostic createSdkMcpServer 1개,
 *  어댑터 분기 0). daemon 완료분(endpoint-registry·http-bridge·router) 미변경 — import 만.
 *
 * 경계 (누가 뭘 하나, E-I10):
 *  - 안전 *판단*(위험 프롬프트 무인실행 회색지대) = `schedule-safety-check` 스킬 일반화(별건).
 *  - 본 도구 = *기계적* 검증·정규화·충돌거부·쓰기/삭제/목록만. 위험 판단 안 함.
 *  - 실행 제한(mode restricted → toolPolicy none)은 http-bridge 가 서빙 시 적용(daemon 완료).
 *
 * 도구 3종:
 *  - register_endpoint → `<home>/endpoints/<name>.md` 작성(frontmatter + 본문=prompt).
 *  - list_endpoints    → discoverEndpoints → formatEndpointIndex.
 *  - delete_endpoint   → `<home>/endpoints/<name>.md` 삭제(name 또는 path 로 식별).
 *
 * 검증·정규화 (도구 책임 — daemon 인계 규칙 그대로):
 *  - path 정규화: 슬래시 시작 강제·소문자·끝슬래시 제거(endpoint-registry 와 동일 규칙).
 *  - 빌트인 5경로 충돌 거부(/messages·/events·/health·/inventory·/providers).
 *  - 기존 name 충돌 거부(overwrite 명시 시에만 덮어쓰기).
 *  - mode 기본 restricted 강제(full 은 호출자 명시만, E-I7). role 기본 write(E-I8).
 *  - name = path 에서 파생(`/daily-summary` → `daily-summary.md`).
 *
 * 어댑터 등록 가드: 각 어댑터가 `!toolsNone && depth === 0 && workerDepth === 0` turn 에만
 *  등록 — worker/spawn 도구와 *동일* 가드. lean(toolPolicy none = restricted 엔드포인트 턴)
 *  이면 미등록 → 엔드포인트가 또 엔드포인트를 만드는 재귀가 자연 차단된다.
 */
import { createOurMcpServer } from "./_our-mcp.js";
import { promises as fs } from "node:fs";
import { isSafeCapabilityName } from "./_names.js";
import path from "node:path";
import {
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getPaths } from "../../paths.js";
import {
  discoverEndpoints,
  formatEndpointIndex,
  type EndpointMethod,
  type EndpointMode,
  type EndpointRole,
} from "../../entry/endpoint-registry.js";

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * 빌트인 라우트 — 등록 충돌 거부 대상 (§4-C, E-I4). http-bridge 빌트인 분기가 코드상
 * 먼저라 물리적으로 도달 불가하지만, 등록 레벨에서도 명시 거부해 깨진 정의를 막는다.
 * (서빙 레벨 보호는 파일 직접 작성 시 백스톱.)
 */
const BUILTIN_ROUTES: ReadonlySet<string> = new Set([
  "/messages",
  "/events",
  "/health",
  "/inventory",
  "/providers",
]);

/**
 * 라우트 경로 정규화 — endpoint-registry.normalizeRoutePath 와 *동일 규칙*(round-trip
 * 일관성: register 가 쓴 path 를 findEndpoint 가 같은 정규화로 매치). module-private
 * 라 복제 1개(인프라 재사용이나 export 표면 최소).
 *  - 슬래시 시작 강제 / 소문자 / 끝 슬래시 제거.
 */
const normalizeRoutePath = (raw: string): string => {
  let p = raw.trim().toLowerCase();
  if (p === "") return "";
  if (!p.startsWith("/")) p = `/${p}`;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
};

/** method 정규화 — 대문자. MVP는 GET/POST 만, 그 외는 POST 폴백(registry 동형). */
const normalizeMethod = (raw: string | undefined): EndpointMethod => {
  const m = (raw ?? "").trim().toUpperCase();
  return m === "GET" ? "GET" : "POST";
};

/** role 정규화 — 기본 write(read 폴백 금지, E-I8). 미지정/무효 → write. */
const normalizeRole = (raw: string | undefined): EndpointRole => {
  const r = (raw ?? "").trim().toLowerCase();
  return r === "read" || r === "admin" ? r : "write";
};

/** mode 정규화 — 기본 restricted(E-I7). full 은 호출자 명시만. */
const normalizeMode = (raw: string | undefined): EndpointMode => {
  const m = (raw ?? "").trim().toLowerCase();
  return m === "full" ? "full" : "restricted";
};

/**
 * path → name 파생 (`/daily-summary` → `daily-summary`). 파일 basename 식별자.
 * 정규화된 routePath 의 선행 슬래시 제거 + 내부 슬래시는 하이픈으로(파일명 안전).
 * 빈 결과는 "" (호출자가 거부).
 */
const deriveName = (routePath: string): string =>
  routePath
    .replace(/^\/+/, "")
    .replace(/\//g, "-")
    .trim();

/**
 * name 안전성 — 디렉터리 탈출/숨김파일 방지. 영문 소문자·숫자·하이픈·언더스코어만.
 * (path 파생이라 정상 입력은 통과. 방어적 가드.)
 */
// 이름 판정은 `_names.ts` 단일 정본 — 사본을 두면 조용히 갈린다(2026-08-01).
const isSafeName = isSafeCapabilityName;

/** frontmatter 값 escape — 줄바꿈 제거(파서가 라인 단위라 멀티라인 불가) + 따옴표 래핑. */
const fmValue = (raw: string): string => {
  const oneLine = raw.replace(/[\r\n]+/g, " ").trim();
  // parseFrontmatter 가 둘러싼 따옴표를 벗기므로 항상 큰따옴표로 감싼다(콜론 안전).
  return `"${oneLine.replace(/"/g, "'")}"`;
};

export const createEndpointToolsMcpServer = (): McpSdkServerConfigWithInstance => {
  const registerEndpoint = tool(
    "register_endpoint",
    "데이터 기반 커스텀 HTTP 엔드포인트를 만듭니다(슬래시 명령의 HTTP 판). " +
      "<home>/endpoints/<name>.md 정의 파일을 작성하면 http-bridge 가 매-요청 발견해 서빙합니다(재시작 불요). " +
      "prompt 는 엔드포인트가 호출될 때 실행할 프롬프트 템플릿이며, 본문에 $BODY(POST 본문)·$QUERY(쿼리스트링)·$ARGUMENTS($BODY alias) placeholder 를 쓸 수 있습니다. " +
      "★mode 가 프롬프트의 성격을 정합니다 — **restricted(기본) 은 순수 백엔드**입니다: 도구 0 + 비서 인격·정책 없음. 이때 prompt 본문이 **그대로 시스템 프롬프트가 되므로 자기완결로 쓰세요** — 역할('당신은 …의 백엔드입니다')·입력 형식·**출력 형식**을 본문 안에 다 적습니다. 반대로 '설명 문장 금지'·'인사말 붙이지 마라' 같은 **방어 문장은 쓰지 마세요**(맞설 인격이 없습니다). **full 은 비서로서 실행**됩니다 — 전체 도구 + 헌법(승인 게이트 포함). 외부 송신·파일쓰기가 필요할 때만, 사용자가 명시 동의했을 때 씁니다. " +
      "호출하려면 bridge 토큰이 필요합니다. 위험할 수 있는 프롬프트(삭제·외부 송신·자동 실행)는 등록 전 사용자 확인을 거치세요.",
    {
      path: z
        .string()
        .min(1)
        .describe("라우트 경로(예 '/daily-summary'). 슬래시 없으면 자동 추가·소문자화. 빌트인 경로(/messages·/events·/health·/inventory·/providers) 금지."),
      prompt: z
        .string()
        .min(1)
        .describe("엔드포인트 호출 시 실행할 프롬프트 템플릿(본문). $BODY(POST 본문)·$QUERY·$ARGUMENTS placeholder 사용 가능. ★restricted 면 이 본문이 **그대로 시스템 프롬프트**가 된다 — 역할·입력·출력 형식을 자기완결로 담아라."),
      method: z
        .enum(["GET", "POST"])
        .optional()
        .describe("HTTP 메서드. 기본 POST."),
      role: z
        .enum(["read", "write", "admin"])
        .optional()
        .describe("호출에 필요한 토큰 role. 기본 write(무인 트리거라 read 폴백 금지)."),
      mode: z
        .enum(["restricted", "full"])
        .optional()
        .describe("실행 제한. 기본 restricted = 순수 백엔드(도구 0 + 인격 없음 → prompt 본문이 곧 시스템 프롬프트, 자기완결로 작성). full = 비서로서 실행(전체 도구 + 헌법) — 사용자 명시 동의 시에만."),
      label: z
        .string()
        .optional()
        .describe("인덱스 표시용 짧은 이름(예 '일일 요약')."),
      description: z
        .string()
        .optional()
        .describe("엔드포인트 설명(인덱스 표시용)."),
      overwrite: z
        .boolean()
        .optional()
        .describe("true 면 같은 이름의 기존 엔드포인트를 덮어씁니다. 기본 false(충돌 시 거부)."),
    },
    async (args) => {
      try {
        // 1) path 정규화 + 빌트인 충돌 거부.
        const routePath = normalizeRoutePath(args.path);
        if (routePath === "") {
          return errText("path 가 비어 있습니다. 유효한 라우트 경로를 지정하세요(예 '/daily-summary').");
        }
        if (BUILTIN_ROUTES.has(routePath)) {
          return errText(
            `'${routePath}' 는 빌트인 예약 경로라 엔드포인트로 등록할 수 없습니다. ` +
              `예약 경로: ${[...BUILTIN_ROUTES].join(", ")}. 다른 경로를 쓰세요.`,
          );
        }

        // 2) name 파생 + 안전성.
        const name = deriveName(routePath);
        if (!isSafeName(name)) {
          return errText(
            `path '${args.path}' 에서 안전한 파일 이름을 만들 수 없습니다(영문 소문자·숫자·하이픈만). 다른 경로를 쓰세요.`,
          );
        }

        // 3) 기존 name 충돌 거부(overwrite 명시 시에만 덮어쓰기).
        const endpointsDir = getPaths().commonEndpoints;
        const filePath = path.join(endpointsDir, `${name}.md`);
        if (args.overwrite !== true) {
          let exists = false;
          try {
            await fs.access(filePath);
            exists = true;
          } catch {
            exists = false;
          }
          if (exists) {
            return errText(
              `엔드포인트 '${name}' 가 이미 존재합니다(${filePath}). 덮어쓰려면 overwrite: true 를 지정하거나, 먼저 delete_endpoint 로 삭제하세요.`,
            );
          }
        }

        // 4) 정규화된 메타 — mode 기본 restricted, role 기본 write 강제.
        const method = normalizeMethod(args.method);
        const role = normalizeRole(args.role);
        const mode = normalizeMode(args.mode);
        const label = (args.label ?? "").trim();
        const desc = (args.description ?? "").trim();

        // 5) frontmatter + 본문=prompt 조립. parseFrontmatter 가 읽을 단순 key:value.
        const fmLines = [
          `path: ${routePath}`,
          `method: ${method}`,
          `role: ${role}`,
          `mode: ${mode}`,
        ];
        if (label !== "") fmLines.push(`label: ${fmValue(label)}`);
        if (desc !== "") fmLines.push(`desc: ${fmValue(desc)}`);
        const fileBody = `---\n${fmLines.join("\n")}\n---\n${args.prompt.trim()}\n`;

        // 6) 디렉터리 ensure(백스톱 — ensureHome 이 이미 만들지만 멱등) + 쓰기.
        await fs.mkdir(endpointsDir, { recursive: true });
        await fs.writeFile(filePath, fileBody, "utf8");

        // ★두 갈래를 **같은 말로** 설명한다 — 도구만 말하고 인격을 빼면, 등록한 사람이
        //  본문을 자기완결로 써야 한다는 걸 모른 채 방어 문장을 계속 쓴다(2026-08-02).
        const modeNote =
          mode === "restricted"
            ? "실행 모드 restricted = 순수 백엔드(도구 0 + 비서 인격 없음). 위 prompt 본문이 그대로 시스템 프롬프트가 되므로 역할·입력·출력 형식을 본문 안에 자기완결로 두세요. 전체 도구가 필요하면 mode: full 로 다시 등록하세요."
            : "실행 모드 full = 비서로서 실행(전체 도구 + 헌법·승인 게이트). 위험 작업에 주의하세요.";
        return okText(
          `엔드포인트 '${name}' 를 등록했습니다.\n` +
            `- 경로: ${method} ${routePath}\n` +
            `- role: ${role} / mode: ${mode}\n` +
            `- 파일: ${filePath}\n` +
            `${modeNote}\n` +
            `호출하려면 bridge 토큰(role ${role} 이상)이 필요합니다.`,
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const listEndpoints = tool(
    "list_endpoints",
    "등록된 커스텀 HTTP 엔드포인트 목록을 조회합니다. 사용자가 '어떤 엔드포인트가 있어?' 류로 물을 때 사용하세요.",
    {},
    async () => {
      try {
        const endpoints = await discoverEndpoints();
        const index = formatEndpointIndex(endpoints);
        if (index === "") {
          return okText("등록된 커스텀 엔드포인트가 없습니다.");
        }
        return okText(`## 커스텀 엔드포인트\n\n${index}`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const deleteEndpoint = tool(
    "delete_endpoint",
    "등록된 커스텀 HTTP 엔드포인트를 삭제합니다. name 또는 path 중 하나로 식별합니다(<home>/endpoints/<name>.md 삭제).",
    {
      name: z
        .string()
        .optional()
        .describe("삭제할 엔드포인트 이름(파일 basename, 예 'daily-summary')."),
      path: z
        .string()
        .optional()
        .describe("삭제할 엔드포인트 경로(예 '/daily-summary'). name 미지정 시 path 에서 파생."),
    },
    async (args) => {
      try {
        // name 우선, 없으면 path 에서 파생.
        let name = (args.name ?? "").trim().toLowerCase();
        if (name === "" && args.path !== undefined) {
          name = deriveName(normalizeRoutePath(args.path));
        }
        if (name === "") {
          return errText("삭제할 엔드포인트의 name 또는 path 를 지정하세요.");
        }
        if (!isSafeName(name)) {
          return errText(`'${name}' 는 유효한 엔드포인트 이름이 아닙니다.`);
        }

        const endpointsDir = getPaths().commonEndpoints;
        const filePath = path.join(endpointsDir, `${name}.md`);
        try {
          await fs.unlink(filePath);
        } catch {
          return errText(
            `엔드포인트 '${name}' 를 찾을 수 없습니다(${filePath}). list_endpoints 로 목록을 확인하세요.`,
          );
        }
        return okText(`엔드포인트 '${name}' 를 삭제했습니다(${filePath}).`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return createOurMcpServer({
    name: "endpoints",
    version: "1.0.0",
    tools: [registerEndpoint, listEndpoints, deleteEndpoint],
  });
};
