/**
 * **프로젝트 라우트** — 목록·능력·상세·잊기·이름 변경.
 *
 * ★프로젝트 = 폴더 + `PROJECT.md`. `/projects/detail` 이 제일 무거운데(123줄) 스킬·에이전트·
 *  훅·스케줄을 한 화면에 모으기 때문이다 — 그 조립이 여기 있다.
 */
import { promises as fsp } from "node:fs";
import { listHooksForInventory } from "../../src/core/entry/hook-runner.js";
import { describeExternalMcpConfig, readProjectMcpServers } from "../../src/core/external-mcp.js";
import { discoverAgents } from "../../src/core/llm-runtime/capabilities/agent-registry.js";
import { parseProjectMd } from "../../src/core/llm-runtime/capabilities/project-registry.js";
import { discoverSkills } from "../../src/core/llm-runtime/capabilities/skill-registry.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { listJobs } from "../../src/core/worker-jobs.js";
import { forgetProject, listProjects, upsertProject } from "../../src/store/projects.js";
import { readJsonBody } from "./http-body.js";
import fs from "node:fs/promises";
import nodePath from "node:path";
import path from "node:path";
import type { RouteCtx } from "./route-ctx.js";

export const handleProjects = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  try {
    // 각 프로젝트에 현재 실행 중 에이전트 수(runningAgents) 부착 — 그리드 카드의
    // "🤖 N 실행 중" 배지용. in-memory listJobs(running) 을 job.cwd 로 귀속(G2).
    const running = listJobs({ runningOnly: true, limit: 500 });
    const rows = listProjects().map((p) => ({
      ...p,
      runningAgents: running.filter(
        (j) =>
          j.cwd !== undefined &&
          nodePath.resolve(j.cwd) === nodePath.resolve(p.path),
      ).length,
    }));
    writeJson(res, 200, rows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleProjectCapability = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  const projectPath = url.searchParams.get("path") ?? "";
  const kind = url.searchParams.get("kind") ?? "";
  const name = url.searchParams.get("name") ?? "";
  if (projectPath.trim() === "" || name.trim() === "") {
    writeJson(res, 400, { error: "path·name required" });
    return;
  }
  if (kind !== "skill" && kind !== "agent") {
    writeJson(res, 400, { error: "kind 는 skill 또는 agent" });
    return;
  }
  try {
    const found =
      kind === "skill"
        ? (await discoverSkills(projectPath).catch(() => [])).find(
            (x) => x.source === "project" && x.name === name,
          )
        : (await discoverAgents(projectPath).catch(() => [])).find(
            (x) => x.source === "project" && x.name === name,
          );
    if (found === undefined) {
      writeJson(res, 404, { error: `이 프로젝트의 ${kind} '${name}' 을 찾을 수 없습니다.` });
      return;
    }
    const raw = await fs.readFile(found.filePath, "utf8");
    // 상한 — 브라우저 DOM 에 통째로 붓지 않는다(비대화 방지). 넘으면 잘렸다고 말한다.
    const CAP = 64 * 1024;
    const body = raw.length > CAP ? `${raw.slice(0, CAP)}\n\n…(${raw.length - CAP}자 생략 — 전문은 ${found.filePath})` : raw;
    writeJson(res, 200, { name: found.name, kind, body });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleProjectDetail = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  const projectPath = url.searchParams.get("path") ?? "";
  if (projectPath.trim() === "") {
    writeJson(res, 400, { error: "path required" });
    return;
  }
  try {
    const mdPath = nodePath.join(projectPath, "PROJECT.md");
    let raw: string;
    try {
      raw = await fsp.readFile(mdPath, "utf8");
    } catch {
      // PROJECT.md 부재/폴더 없음 → 404 (best-effort, throw 0).
      writeJson(res, 404, {
        error: "PROJECT.md not found",
        path: projectPath,
      });
      return;
    }
    const folderName = nodePath.basename(projectPath);
    const meta = parseProjectMd(raw, folderName);

    // 프로젝트 전용 스킬/에이전트 — discover*(path) 중 source==="project" 만.
    const [allSkills, allAgents] = await Promise.all([
      discoverSkills(projectPath).catch(() => []),
      discoverAgents(projectPath).catch(() => []),
    ]);
    const skills = allSkills
      .filter((s) => s.source === "project")
      .map((s) => ({ name: s.name, description: s.description }));
    const agents = allAgents
      .filter((a) => a.source === "project")
      .map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model ?? null, // 모델 티어(high/mid/low 또는 provider:model). 대시보드 표시.
      }));
    // 프로젝트 전용 훅 — `<path>/settings.json` 의 hooks (project 스코프만).
    // ★사용자 결정 2026-08-23: "훅 목록은 오히려 인벤토리나 각 프로젝트별로 보여주면".
    //  훅은 원래 user(런타임 홈) + project 2층이라 분배가 구조를 그대로 따라간다 —
    //  전역은 인벤토리, 그 폴더에서만 도는 것은 여기. 판정은 `listHooksForInventory`
    //  한 곳이고 여기선 scope 로 거른다(스킬·에이전트가 `source==="project"` 로 거르는
    //  것과 같은 꼴 — 새 규칙 0).
    const hooks = listHooksForInventory(projectPath)
      .filter((h) => h.scope === "project")
      .map((h) => ({ event: h.event, matcher: h.matcher, command: h.command }));
    // 프로젝트 전용 MCP — <path>/.mcp.json (프로젝트 스코프). 대시보드 상세에 노출.
    const projectMcp = await readProjectMcpServers(projectPath).catch(() => ({}));
    const mcp = Object.entries(projectMcp).map(([name, cfg]) => ({
      name,
      desc: describeExternalMcpConfig(name, cfg),
    }));

    // related 해소 — 각 항목(경로 또는 등록 name)을 등록 목록에서 name/path 로.
    // 못 찾으면 path=null(텍스트로만 표시). 상대경로는 프로젝트 폴더 기준 절대화 후 매칭.
    let registered: ReturnType<typeof listProjects>;
    try {
      registered = listProjects();
    } catch {
      registered = [];
    }
    const related = meta.related.map((ref: string) => {
      const trimmed = ref.trim();
      const abs = nodePath.isAbsolute(trimmed)
        ? trimmed
        : nodePath.resolve(projectPath, trimmed);
      const byPath = registered.find(
        (p) => p.path === abs || p.path === trimmed,
      );
      if (byPath !== undefined) {
        return { name: byPath.name, path: byPath.path };
      }
      const byName = registered.find((p) => p.name === trimmed);
      if (byName !== undefined) {
        return { name: byName.name, path: byName.path };
      }
      return { name: trimmed, path: null };
    });

    // recentJobs — 이 프로젝트(cwd) 에서 실행된/실행 중인 서브에이전트 잡(G2 귀속).
    // in-memory listJobs 를 실행 cwd 로 필터(spawn_agent(path=X)가 job.cwd=X 기록).
    // running 먼저(startedAt desc, listJobs 기본 정렬) → 최대 20건. 무귀속(cwd 미기록)
    // 잡은 자연 제외. 대시보드가 "이 프로젝트에서 작업 중/최근 서브에이전트" 로 렌더.
    const projAbs = nodePath.resolve(projectPath);
    const recentJobs = listJobs({ limit: 200 })
      .filter(
        (j) => j.cwd !== undefined && nodePath.resolve(j.cwd) === projAbs,
      )
      .slice(0, 20)
      .map((j) => ({
        jobId: j.jobId,
        kind: j.kind,
        agentName: j.agentName ?? j.label,
        modelTier: j.modelTier ?? null,
        status: j.status,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt ?? null,
        task: j.task,
      }));

    writeJson(res, 200, {
      meta: {
        name: meta.name,
        description: meta.description,
        status: meta.status,
        related: meta.related,
        body: meta.body,
      },
      skills,
      agents,
      mcp,
      hooks,
      related,
      recentJobs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleProjectForget = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let pbody: Record<string, unknown>;
  try {
    pbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const pathIn =
    typeof pbody.path === "string" ? pbody.path.trim() : "";
  if (pathIn === "") {
    writeJson(res, 400, { error: "path required" });
    return;
  }
  try {
    forgetProject(pathIn);
    writeJson(res, 200, { ok: true, path: pathIn });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleProjectRename = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let pbody: Record<string, unknown>;
  try {
    pbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const pathIn = typeof pbody.path === "string" ? pbody.path.trim() : "";
  const name = typeof pbody.name === "string" ? pbody.name.trim() : "";
  if (pathIn === "" || name === "") {
    writeJson(res, 400, { error: "path and name required" });
    return;
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    writeJson(res, 400, { error: "name must not contain control characters" });
    return;
  }
  const abs = nodePath.resolve(pathIn);
  const projects = listProjects();
  const registered = projects.find((p) => nodePath.resolve(p.path) === abs);
  if (registered === undefined) {
    writeJson(res, 404, { error: "project not registered" });
    return;
  }
  const duplicate = projects.find(
    (p) => nodePath.resolve(p.path) !== abs && p.name === name,
  );
  if (duplicate !== undefined) {
    writeJson(res, 409, { error: "project name already exists" });
    return;
  }
  try {
    const mdPath = path.join(registered.path, "PROJECT.md");
    const raw = await fs.readFile(mdPath, "utf8");
    let next: string;
    if (raw.startsWith("---\n")) {
      const end = raw.indexOf("\n---", 4);
      if (end >= 0) {
        const fm = raw.slice(4, end);
        const rest = raw.slice(end);
        const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const nameLine = `name: "${escaped}"`;
        const nextFm = /^name\s*:/m.test(fm)
          ? fm.replace(/^name\s*:.*$/m, nameLine)
          : `${nameLine}\n${fm}`;
        next = `---\n${nextFm}${rest}`;
      } else {
        next = raw;
      }
    } else {
      const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const escapedDescription = (registered.description ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      next = `---\nname: "${escapedName}"\ndescription: "${escapedDescription}"\nstatus: ${registered.status}\n---\n\n${raw}`;
    }
    if (next === raw) {
      writeJson(res, 400, { error: "invalid PROJECT.md frontmatter" });
      return;
    }
    await fs.writeFile(mdPath, next, "utf8");
    const folderName = path.basename(registered.path);
    const meta = parseProjectMd(next, folderName);
    upsertProject({ path: registered.path, ...meta });
    writeJson(res, 200, { ok: true, path: registered.path, name: meta.name });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};
