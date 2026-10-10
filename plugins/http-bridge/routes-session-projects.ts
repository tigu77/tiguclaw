/**
 * 세션에 연결한 프로젝트 — 대시보드(📁 칩·«이 대화에 프로젝트 연결»·칩 메뉴·`/` 구획)의 입구 (2026-10-08).
 * 판단은 전부 `core/session-projects.ts` — 여기는 배관만 한다(가장자리는 판단하지 않는다).
 *  GET  /session-projects?threadKey=…   → { linked: [{name,path,description,exists,commands:[{name,description,run,folder?}]}], available: [...] }  (read)
 *  POST /session-projects {threadKey, action:"link"|"unlink", project}                                                          (write)
 * 세션 id 는 `/messages` 와 같은 정규화(`resolveSessionId`) — 대화 턴이 보는 세션과 같아야 한다.
 */
import { resolveSessionId } from "../../src/core/threadkey.js";
import { linkedProjects, linkProject, sessionProjectCommands, unlinkProject } from "../../src/core/session-projects.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { listProjects } from "../../src/store/projects.js";
import { bodyErrorStatus, readJsonBody } from "./http-body.js";
import type { RouteCtx } from "./route-ctx.js";

export const handleGetSessionProjects = async (ctx: RouteCtx): Promise<void> => {
  const raw = (ctx.url.searchParams.get("threadKey") ?? "").trim();
  if (raw === "") {
    writeJson(ctx.res, 400, { error: "threadKey required" });
    return;
  }
  const tk = resolveSessionId(ctx.channelName, raw, raw);
  const sections = await sessionProjectCommands(tk);
  const linkedPaths = new Set(linkedProjects(tk).map((p) => p.path));
  writeJson(ctx.res, 200, {
    linked: sections.map(({ project, commands }) => ({
      ...project,
      commands: commands.map((c) => ({ name: c.name, description: c.description, run: c.run !== undefined, ...(c.folder === undefined ? {} : { folder: c.folder }) })),
    })),
    available: listProjects()
      .filter((p) => !linkedPaths.has(p.path))
      .map((p) => ({ name: p.name, path: p.path, description: p.description })),
  });
};

export const handlePostSessionProjects = async (ctx: RouteCtx): Promise<void> => {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(ctx.req);
  } catch (e) {
    writeJson(ctx.res, bodyErrorStatus(e), { error: `invalid body: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  const raw = typeof body.threadKey === "string" ? body.threadKey.trim() : "";
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const action = body.action;
  if (raw === "" || project === "" || (action !== "link" && action !== "unlink")) {
    writeJson(ctx.res, 400, { error: "threadKey, project, action(link|unlink) required" });
    return;
  }
  const tk = resolveSessionId(ctx.channelName, raw, raw);
  if (action === "link") {
    const r = linkProject(tk, project);
    if (r.ok) writeJson(ctx.res, 200, { ok: true, name: r.project.name, already: r.already });
    else writeJson(ctx.res, r.reason === "not-registered" ? 404 : 409, { error: r.reason, candidates: r.candidates.map((p) => p.path) });
    return;
  }
  const r = unlinkProject(tk, project);
  if (r.ok) writeJson(ctx.res, 200, { ok: true, name: r.project.name });
  else writeJson(ctx.res, 404, { error: "not-linked" });
};
