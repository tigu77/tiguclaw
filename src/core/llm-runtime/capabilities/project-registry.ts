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
import { parseFrontmatter } from "./skill-registry.js";
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
 * `<path>/PROJECT.md` raw → ProjectMeta. yaml lib 추가 0 (parseFrontmatter 재사용).
 * related 는 콤마 구분 1줄(`related: A, B`) 관대 파싱. name 미지정 시 폴더명 폴백.
 */
export const parseProjectMd = (raw: string, folderName: string): ProjectMeta => {
  const fm = parseFrontmatter(raw) ?? {};
  const name = (fm.name ?? "").trim() || folderName;
  const description = (fm.description ?? "").trim();
  const s = (fm.status ?? "").trim().toLowerCase();
  const status: ProjectStatus =
    s === "paused" || s === "done" ? s : "active";
  const related = (fm.related ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r !== "");
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
          "등록된 프로젝트 목록을 반환합니다 (이름·상태·경로).",
          {},
          async () => {
            const rows = listProjects();
            if (rows.length === 0) {
              return okText("등록된 프로젝트가 없습니다.");
            }
            const lines = rows.map(
              (p) => `- ${p.name} [${p.status}] — ${p.path}`,
            );
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
      ],
    });
