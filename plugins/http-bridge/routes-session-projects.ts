/**
 * 세션에 연결한 프로젝트 — 대시보드(📁 칩·«이 대화에 프로젝트 연결»·칩 메뉴·`/` 구획)의 입구 (2026-10-08).
 * 판단은 전부 `core/session-projects.ts` — 여기는 배관만 한다(가장자리는 판단하지 않는다).
 *  GET  /session-projects?threadKey=…   → { linked: [{name,path,description,exists,commands:[{name,description,run,common,source,pluginId?,folder?}],
 *                                           actions:[{id,icon,labelKey,value,danger?,confirmKey?}]}], available: [...] }  (read)
 *  POST /session-projects {threadKey, action:"link"|"unlink", project}                                                          (write)
 * 세션 id 는 `/messages` 와 같은 정규화(`resolveSessionId`) — 대화 턴이 보는 세션과 같아야 한다.
 * ★메뉴(커맨드·빌트인 동작)는 코어 `projectMenu` 한 곳에서 나온다 — 텔레그램 `/project open` 과 같은 목록(2026-11-03 공통 커맨드 §2.3).
 *  `run` = 비서 없이 돈다(실행형·플러그인 처리기, `runsWithoutModel`) · `common` = 모든 프로젝트 공통.
 */
import { resolveSessionId } from "../../src/core/threadkey.js";
import { runsWithoutModel } from "../../src/core/entry/command-registry.js";
import { linkProject, quoteProject, sessionProjectMenus, unlinkProject } from "../../src/core/session-projects.js";
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
  const menus = await sessionProjectMenus(tk);
  const linkedPaths = new Set(menus.map((m) => m.project.path));
  writeJson(ctx.res, 200, {
    linked: menus.map(({ project, commands, actions }) => ({
      ...project,
      commands: commands.map((c) => ({
        name: c.name,
        description: c.description,
        run: runsWithoutModel(c),
        common: c.source !== "project",
        source: c.source,
        ...(c.pluginId === undefined ? {} : { pluginId: c.pluginId }),
        ...(c.folder === undefined ? {} : { folder: c.folder }),
      })),
      actions: actions.map((a) => ({
        id: a.id,
        icon: a.icon,
        labelKey: a.labelKey,
        value: a.slash(quoteProject(project.name)),
        ...(a.danger === true ? { danger: true } : {}),
        ...(a.confirmKey === undefined ? {} : { confirmKey: a.confirmKey }),
      })),
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
