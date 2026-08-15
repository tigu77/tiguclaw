/**
 * 프로젝트 레지스트리 in-process MCP — register/list/update/forget 도구 + PROJECT.md 파서.
 *
 * ★단방향 정합 (ADR docs/decisions/2026-07-06-projects-feature.md §0): 프로젝트는
 * 데이터+컨벤션으로 산다. 코어는 "프로젝트"를 모른다 — 이 capability 가 파일(PROJECT.md)을
 * 파싱해 얇은 store 인덱스(store/projects.ts)에 upsert 할 뿐. 진실은 각 폴더의 PROJECT.md.
 *
 * 양 어댑터(codex·claude) 동일 등록 = LLM-agnostic(#2, 어댑터 분기 0). send-file/todo 동형
 * in-process MCP factory. enter_project(진입=cwd)은 P2 항목이라 여기 미포함(register 계열만).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { parseFrontmatter, discoverSkills } from "./skill-registry.js";
import { discoverAgents } from "./agent-registry.js";
import {
  readProjectMcpServers,
  describeExternalMcpConfig,
} from "../../external-mcp.js";
import {
  upsertProject,
  listProjects,
  forgetProject,
  type ProjectStatus,
} from "../../../store/projects.js";

const okText = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

// ─── PROJECT.md 파서 (컨벤션 — 코어 아님) ────────────────────────────────────
export interface ProjectMeta {
  /** frontmatter name (미지정 시 폴더 basename 폴백). */
  name: string;
  description: string;
  /** 미지정/무효 → "active". */
  status: ProjectStatus;
  /** 연관 프로젝트 — 경로 또는 등록 name (해소는 대시보드가). 콤마 1줄 관대 파싱. */
  related: string[];
  /** frontmatter 이후 본문 (마크다운 그대로). */
  body: string;
}

/** frontmatter 닫는 `---` 이후 본문 추출 (parseFrontmatter 는 key:value 만 반환). */
const extractBody = (raw: string): string => {
  const head = raw.replace(/^﻿/, "");
  if (!head.startsWith("---")) return head.trim();
  const afterOpen = head.slice(3);
  const closeMatch = afterOpen.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (closeMatch === null || closeMatch.index === undefined) return "";
  return afterOpen.slice(closeMatch.index + closeMatch[0].length).trim();
};

/**
 * related 관대 파싱 — **콤마 1줄(`related: A, B`) 과 YAML 리스트(`related:` 다음 `- item`
 * 라인들) 둘 다 지원**(ADR §1 약속). parseFrontmatter 는 라인별 key:value 라 리스트 형식을
 * 못 잡으므로, 여기서 raw frontmatter 블록을 직접 스캔해 보강. yaml lib 추가 0.
 */
const extractRelated = (raw: string, fmValue: string): string[] => {
  const items: string[] = [];
  const unquote = (s: string) => s.replace(/^["']|["']$/g, "").trim();
  // 1) 콤마 1줄 형식(parseFrontmatter 가 준 값).
  for (const r of fmValue.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    items.push(unquote(r));
  }
  // 2) YAML 리스트 형식 — frontmatter 블록에서 `related:` 다음의 `- item` 라인 수집.
  const fmMatch = raw.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    let inList = false;
    for (const line of fmMatch[1].split(/\r?\n/)) {
      if (/^\s*related\s*:/.test(line)) { inList = true; continue; }
      if (!inList) continue;
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      if (m) { items.push(unquote(m[1])); continue; }
      if (line.trim() === "") continue; // 빈 줄은 통과.
      inList = false; // 다른 key 시작 → 리스트 종료.
    }
  }
  return [...new Set(items.filter((s) => s !== ""))]; // 순서 보존 dedupe.
};

/**
 * `<path>/PROJECT.md` raw → ProjectMeta. yaml lib 추가 0 (parseFrontmatter 재사용).
 * name 미지정 시 폴더명 폴백. related 는 콤마 1줄·YAML 리스트 둘 다(extractRelated).
 */
export const parseProjectMd = (raw: string, folderName: string): ProjectMeta => {
  const fm = parseFrontmatter(raw) ?? {};
  const name = (fm.name ?? "").trim() || folderName;
  const description = (fm.description ?? "").trim();
  const s = (fm.status ?? "").trim().toLowerCase();
  const status: ProjectStatus =
    s === "paused" || s === "done" ? s : "active";
  const related = extractRelated(raw, fm.related ?? "");
  return { name, description, status, related, body: extractBody(raw) };
};

// ─── 등록 로직 (register/update 공용) ────────────────────────────────────────
const registerFromDisk = async (
  projectPath: string,
): Promise<{ ok: true; meta: ProjectMeta } | { ok: false; error: string }> => {
  const abs = path.resolve(projectPath);
  const mdPath = path.join(abs, "PROJECT.md");
  let raw: string;
  try {
    raw = await fs.readFile(mdPath, "utf8");
  } catch {
    return {
      ok: false,
      error: `PROJECT.md 를 찾지 못했습니다: ${mdPath}. 먼저 그 폴더에 PROJECT.md 를 작성하세요 (frontmatter: name·description·status·related).`,
    };
  }
  const meta = parseProjectMd(raw, path.basename(abs));
  upsertProject({
    path: abs,
    name: meta.name,
    status: meta.status,
    description: meta.description,
  });
  return { ok: true, meta };
};

// ─── MCP factory ─────────────────────────────────────────────────────────────
export const createProjectRegistryMcpServer =
  (): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
      name: "projects",
      version: "1.0.0",
      tools: [
        tool(
          "project_register",
          "폴더를 프로젝트로 등록합니다. 그 폴더의 PROJECT.md(frontmatter: name·description·status(active/paused/done)·related)를 읽어 프로젝트 레지스트리에 넣어 대시보드에 노출합니다. PROJECT.md 가 없으면 먼저 작성하세요.",
          { path: z.string().min(1) },
          async (args) => {
            const r = await registerFromDisk(args.path);
            return r.ok
              ? okText(
                  `프로젝트 '${r.meta.name}' 등록됨 (status: ${r.meta.status}). 대시보드 프로젝트 탭에 표시됩니다.`,
                )
              : errText(r.error);
          },
        ),
        tool(
          "project_update",
          "등록된 프로젝트의 PROJECT.md 를 다시 읽어 레지스트리(name·status·description)를 갱신합니다. PROJECT.md 를 고친 뒤 반영할 때 사용.",
          { path: z.string().min(1) },
          async (args) => {
            const r = await registerFromDisk(args.path);
            return r.ok
              ? okText(
                  `프로젝트 '${r.meta.name}' 갱신됨 (status: ${r.meta.status}).`,
                )
              : errText(r.error);
          },
        ),
        tool(
          "project_list",
          "등록된 프로젝트 목록을 반환합니다 (이름·상태·요약·경로). 요약(description)은 레지스트리 캐시에서 오므로 PROJECT.md 를 깊이 읽지 않고도 '무슨 프로젝트가 있는지' 싸게 파악됩니다. 특정 프로젝트의 에이전트/스킬·본문 맥락은 project_capabilities(path) 로.",
          {},
          async () => {
            const rows = listProjects();
            if (rows.length === 0) {
              return okText("등록된 프로젝트가 없습니다.");
            }
            // 요약(description) 포함 — 캐시 값이라 파일 read 0(스케일: N개여도 이 도구
            // 호출 1회, 프롬프트 상시 무게 0). 요약 없으면 생략.
            const lines = rows.map((p) => {
              const desc =
                p.description !== null && p.description.trim() !== ""
                  ? ` — ${p.description.trim()}`
                  : "";
              return `- ${p.name} [${p.status}]${desc}\n    ${p.path}`;
            });
            return okText(`등록된 프로젝트 ${rows.length}개:\n${lines.join("\n")}`);
          },
        ),
        tool(
          "project_forget",
          "프로젝트를 레지스트리에서 등록 해제합니다 (PROJECT.md 파일과 폴더는 그대로 둡니다).",
          { path: z.string().min(1) },
          async (args) => {
            forgetProject(path.resolve(args.path));
            return okText(`프로젝트 등록을 해제했습니다: ${path.resolve(args.path)}`);
          },
        ),
        tool(
          "project_capabilities",
          "폴더의 능력을 스캔해 그 폴더 전용 에이전트/스킬 명세 + PROJECT.md 메타(요약)를 반환합니다. 일을 위임(spawn_agent path=…)하거나 스킬을 쓰기(invoke_skill path=…) 전에, 그 폴더에 어떤 에이전트(name·설명·모델 등급)와 스킬(name·설명)이 있는지 파악할 때 사용. PROJECT.md 의 노트/할 일 등 자세한 본문 맥락이 필요하면 Read 로 그 파일을 직접 읽으세요(토큰 절약 — 여기선 요약만). 진실은 디스크라 매 호출 최신 스캔.",
          { path: z.string().min(1) },
          async (args) => {
            const abs = path.resolve(args.path);
            // 폴더 존재 확인 (throw 0 — 없으면 에러텍스트).
            try {
              const st = await fs.stat(abs);
              if (!st.isDirectory()) {
                return errText(`폴더가 아닙니다: ${abs}`);
              }
            } catch {
              return errText(`폴더를 찾지 못했습니다: ${abs}`);
            }
            // PROJECT.md 메타(요약)만 — 본문(노트)은 토큰 절약 위해 제외(마스터가 필요 시
            // Read 로 on-demand). frontmatter 는 가벼워 유지(name/status/description/related).
            let metaLine: string;
            try {
              const raw = await fs.readFile(path.join(abs, "PROJECT.md"), "utf8");
              const meta = parseProjectMd(raw, path.basename(abs));
              metaLine = `프로젝트: ${meta.name} [${meta.status}] — ${meta.description}\n`;
              if (meta.related.length > 0) {
                metaLine += `연관: ${meta.related.join(", ")}\n`;
              }
            } catch {
              metaLine = `프로젝트 폴더: ${abs} (PROJECT.md 없음 — 미등록 폴더)\n`;
            }
            // 전용 에이전트/스킬 — discover*(abs) 중 source==="project" 만 (대시보드
            // /projects/detail 과 동일 필터, 스캔 로직 재사용).
            const [allSkills, allAgents] = await Promise.all([
              discoverSkills(abs).catch(() => []),
              discoverAgents(abs).catch(() => []),
            ]);
            const agents = allAgents.filter((a) => a.source === "project");
            const skills = allSkills.filter((s) => s.source === "project");
            const agentLines =
              agents.length === 0
                ? "  (전용 에이전트 없음)"
                : agents
                    .map(
                      (a) =>
                        `  - ${a.name} (모델: ${a.model ?? "default"}) — ${a.description}`,
                    )
                    .join("\n");
            const skillLines =
              skills.length === 0
                ? "  (전용 스킬 없음)"
                : skills
                    .map((s) => `  - ${s.name} — ${s.description}`)
                    .join("\n");
            // 전용 MCP — <abs>/.mcp.json (프로젝트 스코프). 이 프로젝트로 위임(spawn_agent
            // path=…)하면 그 도구가 그 서브에 노출된다. 전역 MCP 는 어디서나이므로 여기 제외.
            const projectMcp = await readProjectMcpServers(abs); // never-throw(내부 catch).
            const mcpNames = Object.keys(projectMcp);
            const mcpLines =
              mcpNames.length === 0
                ? "  (전용 MCP 없음)"
                : mcpNames
                    .map((n) => `  - ${describeExternalMcpConfig(n, projectMcp[n]!)}`)
                    .join("\n");
            return okText(
              `${metaLine}경로: ${abs}\n\n전용 에이전트 (${agents.length}):\n${agentLines}\n\n전용 스킬 (${skills.length}):\n${skillLines}\n\n전용 MCP (${mcpNames.length}):\n${mcpLines}`,
            );
          },
        ),
      ],
    });
