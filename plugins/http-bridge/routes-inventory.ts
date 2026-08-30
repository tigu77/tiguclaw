/**
 * **인벤토리·플러그인 라우트** — 무엇이 깔려 있고 무엇을 할 수 있나.
 *
 * ★`/plugins/action`(설치·제거·켜기·끄기)이 여기 있고 role 표에서 **admin** 이다 —
 *  플러그인은 데몬과 같은 프로세스에서 돈다(`docs/security.md §2`).
 * ★`/plugin-data/` 는 프리픽스 라우트 — 플러그인마다 한 줄씩 늘지 않게 한 줄로 받는다.
 */
import { createMemoryMcpServer } from "../../src/core/memory-mcp.js";
const IN_PROCESS_MCP_FACTORIES: Record<string, () => ReturnType<typeof createMemoryMcpServer>> = {
  memory: createMemoryMcpServer,
};

import { listSchedules } from "../../src/store/schedules.js";
import { getAllCommands } from "../../src/core/entry/command-registry.js";
import { readHomeWidgets } from "../../src/core/home-widgets.js";
import { adaptClaudeMcpServer } from "../../src/core/llm-runtime/adapters/_mcp-bridge.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { callPluginDataRoute, isPluginMedia } from "../../src/core/plugins/data-routes.js";
import { collectContextMenuContributions, collectInventory, isWhitelistedContextMenuAction } from "../../src/core/plugins/inventory.js";
import { listLivePlugins } from "../../src/core/plugins/manager.js";
import type { DisplayText } from "../../src/core/plugins/providers.js";
import { readJsonBody } from "./http-body.js";
import { Cron } from "croner";
import fs from "node:fs/promises";
import path from "node:path";
import type { RouteCtx } from "./route-ctx.js";

export const handleInventory = async (ctx: RouteCtx): Promise<void> => {
  const { res, pathname } = ctx;
  try {
    const inv = await collectInventory();
    let schedules: Array<Record<string, unknown>> = [];
    try {
      schedules = listSchedules().map((r) => {
        let nextRun: string | null = null;
        if (r.enabled && r.triggerType === "cron") {
          try {
            const dry = new Cron(r.cronExpr, {
              timezone: r.timezone,
              paused: true,
            });
            const next = dry.nextRun();
            nextRun = next === null ? null : next.toISOString();
          } catch {
            nextRun = null;
          }
        }
        // ★서버는 문장을 만들지 않는다 — 값·스펙만 보내고 화면이 만든다
        //  (`DisplayText`, 2026-08-25). 여기 쓰이던 사실은 아래 `metadata` 에 이미
        //  구조화돼 있어, 종전 문장은 같은 판단의 두 번째 사본이기도 했다.
        const state: DisplayText = { key: r.enabled ? "common.on" : "common.off" };
        const status: DisplayText = r.lastStatus ?? { key: "inv.schedule.neverRan" };
        const description: DisplayText =
          r.triggerType === "reboot"
            ? { key: "inv.schedule.reboot", params: { state, status } }
            : {
                key: "inv.schedule.cron",
                params: { cron: r.cronExpr ?? "-", next: nextRun ?? "-", state, status },
              };
        const metadata: Record<string, unknown> = {
          trigger_type: r.triggerType,
          dest_channel: r.destChannel,
        };
        if (r.triggerType === "cron") {
          metadata.cron_expr = r.cronExpr;
          metadata.timezone = r.timezone;
          if (nextRun !== null) metadata.next_run = nextRun;
        }
        if (r.destTarget !== null && r.destTarget !== "")
          metadata.dest_target = r.destTarget;
        if (r.lastStatus !== null) metadata.last_status = r.lastStatus;
        if (r.lastError !== null && r.lastError !== "")
          metadata.last_error = r.lastError;
        return {
          category: "schedule",
          name: r.label,
          description,
          source: `schedule:${r.id}`,
          enabled: r.enabled,
          metadata,
        };
      });
    } catch {
      schedules = [];
    }
    writeJson(res, 200, { ...inv, schedules });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleInventoryItem = async (ctx: RouteCtx): Promise<void> => {
  const { res, url, pathname } = ctx;
  const source = url.searchParams.get("source") ?? "";
  if (source.trim() === "") {
    writeJson(res, 400, { error: "source required" });
    return;
  }
  try {
    const inv = await collectInventory();
    const allow = new Set<string>();
    // 모든 카테고리의 파일 source(절대 경로)만 허용 집합에 편입. in-process:/builtin:/
    // schedule: 같은 비파일 source 는 path.isAbsolute 가 false → 자동 제외.
    for (const arr of [
      inv.channel,
      inv.external_plugin,
      inv.skill,
      inv.agent,
      inv.mcp,
      inv.endpoint,
      inv.command,
    ]) {
      for (const e of arr) {
        if (typeof e.source === "string" && path.isAbsolute(e.source)) {
          allow.add(e.source);
        }
      }
    }
    if (!allow.has(source)) {
      // allowlist 밖 = 임의 경로·비파일 source·부재 항목 → 읽기 거부(보안).
      writeJson(res, 403, { error: "forbidden" });
      return;
    }
    let body: string;
    try {
      body = await fs.readFile(source, "utf8");
    } catch {
      // 집합엔 있으나 파일 부재/디렉터리(예: 플러그인 dir) → 본문 없음.
      writeJson(res, 404, { error: "not found", source });
      return;
    }
    writeJson(res, 200, { source, body });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleContextMenuItems = async (ctx: RouteCtx): Promise<void> => {
  const { res, pathname } = ctx;
  try {
    const contributions = await collectContextMenuContributions();
    const items: Array<{
      id: string;
      type: string;
      label: string;
      icon?: string;
      action: { kind: "invoke_skill"; skill: string };
      group?: string;
      danger?: boolean;
    }> = [];
    for (const c of contributions) {
      c.items.forEach((raw, idx) => {
        const action = { kind: "invoke_skill" as const, skill: c.skillName };
        if (!isWhitelistedContextMenuAction(action.kind)) return; // 방어선(도달 불가 — 항상 invoke_skill).
        items.push({
          id: `skill:${c.skillName}:${idx}`,
          type: raw.on,
          label: raw.label,
          ...(raw.icon !== undefined ? { icon: raw.icon } : {}),
          action,
          ...(raw.group !== undefined ? { group: raw.group } : {}),
          ...(raw.danger !== undefined ? { danger: raw.danger } : {}),
        });
      });
    }
    writeJson(res, 200, { items, generatedAt: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleCommands = async (ctx: RouteCtx): Promise<void> => {
  const { res, pathname } = ctx;
  try {
    const cmds = await getAllCommands();
    writeJson(res, 200, { commands: cmds });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleMcpTools = async (ctx: RouteCtx): Promise<void> => {
  const { res, url, pathname } = ctx;
  const want = (url.searchParams.get("name") ?? "").trim();
  if (want === "") {
    writeJson(res, 400, { error: "name 파라미터가 필요합니다" });
    return;
  }
  try {
    const factory = IN_PROCESS_MCP_FACTORIES[want];
    if (factory === undefined) {
      // 외부 MCP 는 연결된 클라이언트가 있어야 물어볼 수 있다 — 없으면 정직하게 빈 목록.
      const note: DisplayText = { key: "inv.tools.externalOnly" };
      writeJson(res, 200, { name: want, tools: [], note });
      return;
    }
    const bridge = await adaptClaudeMcpServer(factory(), want);
    const raw = (await bridge.listTools()) as Array<{
      name?: string;
      description?: string;
      inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
    }>;
    const tools = raw.map((t) => ({
      name: String(t.name ?? ""),
      description: String(t.description ?? ""),
      params: Object.keys(t.inputSchema?.properties ?? {}),
      required: Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [],
    }));
    writeJson(res, 200, { name: want, tools });
  } catch (e) {
    writeJson(res, 500, {
      error: `도구 조회 실패: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  return;
};

export const handleHomeWidgets = async (ctx: RouteCtx): Promise<void> => {
  const { res, pathname } = ctx;
  const known = new Set(listLivePlugins().map((p) => p.name));
  const { widgets, rejected } = readHomeWidgets(known);
  // ★**어느 위젯이 값을 받아올 수 있나**(2026-08-28, 증분 5). 관례상 데이터 라우트
  //  이름 = 위젯 이름이므로, 이 목록에 없으면 그 위젯은 **poll 대상이 아니다**
  //  (Running Work 처럼 화면에서 `ctx.resource` 로 값을 받는 것). 화면이 404 를 맞고
  //  "값을 못 받았습니다" 를 띄우지 않게 **서버가 먼저 말해 준다** — 이미 계산하는
  //  값이라 새 선언을 만들지 않는다.
  const { listPluginDataRoutes } = await import(
    "../../src/core/plugins/data-routes.js"
  );
  writeJson(res, 200, { widgets, rejected, dataRoutes: listPluginDataRoutes() });
  return;
};

export const handlePluginData = async (ctx: RouteCtx): Promise<void> => {
  const { res, url, pathname } = ctx;
  const rest = pathname.slice("/plugin-data/".length).split("/");
  const plugin = decodeURIComponent(rest[0] ?? "");
  const route = decodeURIComponent(rest[1] ?? "");
  if (rest.length !== 2 || plugin === "" || route === "") {
    writeJson(res, 404, { error: "/plugin-data/<plugin>/<route> 형식이어야 합니다." });
    return;
  }
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (k !== "token") query[k] = v; // 토큰은 질의가 아니다 — 캐시 키에 섞이면 안 된다.
  }
  const r = await callPluginDataRoute(plugin, route, query);
  if (!r.ok) {
    writeJson(res, r.status, { error: r.error });
    return;
  }
  // ★**바이트도 낸다** — 지도 타일처럼 브라우저가 직접 못 받는 것(CSP `img-src 'self'`).
  //  같은 라우트·같은 캐시이고 여기서 표현만 갈린다.
  if (isPluginMedia(r.value)) {
    res.writeHead(200, {
      "Content-Type": r.value.contentType,
      // ★브라우저도 캐시하게 둔다 — 서버 TTL 과 **같은 수명**이라 둘이 갈리지 않는다.
      //  타일은 안 바뀌므로 이게 poll 마다 다시 받는 것을 막는 가장 싼 수단이다.
      "Cache-Control": `private, max-age=${Math.max(0, Math.floor(r.ttlMs / 1000))}`,
    });
    res.end(Buffer.from(r.value.body));
    return;
  }
  // ★JSON 은 **캐시하지 않는다** — 신선도 판단은 서버 TTL 한 곳에만 둔다. 브라우저까지
  //  캐시하면 "값이 왜 안 바뀌지" 를 두 곳에서 봐야 한다.
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ data: r.value, cached: r.cached }));
  return;
};

export const handlePlugins = async (ctx: RouteCtx): Promise<void> => {
  const { res, pathname } = ctx;
  const { listAllPlugins } = await import("../../src/core/plugins/manager.js");
  const { PLUGIN_SCHEMA_VERSION } = await import("../../src/core/plugins/loader.js");
  writeJson(res, 200, {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    // ★코드 갱신은 재부팅이 필요하다 — 화면이 이걸 그대로 말한다(실측: ESM 은 엔트리만
    //  무효화하면 하위 모듈이 옛것이라, 반쪽 리로드가 안 하느니 못하다).
    codeReloadRequiresRestart: true,
    // ★꺼진 것도 나온다 — 안 그러면 끄는 순간 목록에서 사라져 다시 못 켠다.
    items: (await listAllPlugins()).map((p) => ({
      name: p.name,
      source: p.source,
      version: p.version ?? null,
      needs: p.needs,
      // ★화면이 자기 언어로 그릴 수 있게 **데이터도** 보낸다 — `needs` 는 한국어 문장이라
      //  영어 로케일에서 그대로 박히면 못 읽는다(2026-08-30 구조 검토).
      needsFacts: p.needsFacts,
      // ★끌 수 없는 것 — 화면이 **토글을 아예 안 만든다**(눌러보고 알게 하지 않는다).
      core: p.core,
      capabilities: p.capabilities,
      wired: p.wired,
      enabled: p.enabled,
      // ★설명은 **언어를 안 고르고** 그대로 넘긴다(문자열 또는 언어별 객체) —
      //  고르는 건 화면 몫이다(서버는 언어를 만들지 않는다).
      meta: p.meta,
      // ★설정은 **선언 + 값**이 함께 온다 — 화면이 손으로 행을 짓지 않게 하려면
      //  "무엇을 물어볼지" 를 서버가 줘야 한다(§D.2). secret 은 값 대신 있다/없다만.
      settings: p.settings,
    })),
  });
  return;
};

export const handlePluginsAction = async (ctx: RouteCtx): Promise<void> => {
  const { req, res, pathname } = ctx;
  const body = (await readJsonBody(req)) as {
    action?: unknown;
    name?: unknown;
    key?: unknown;
    value?: unknown;
  };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (name === "") {
    writeJson(res, 400, { error: "name required" });
    return;
  }
  const m = await import("../../src/core/plugins/manager.js");
  try {
    if (action === "install") {
      writeJson(res, 200, await m.installHomePlugin(name));
      return;
    }
    if (action === "remove") {
      writeJson(res, 200, await m.removePlugin(name));
      return;
    }
    if (action === "enable" || action === "disable") {
      writeJson(res, 200, await m.setPluginEnabled(name, action === "enable"));
      return;
    }
    // 설정 한 칸 쓰기 (2026-08-28, §D) — ★검증은 코어가 한다. 여기는 주소를 값으로
    //  바꾸는 자리일 뿐이고, 모르는 키·타입 불일치·secret 거부는 전부 거기서 판정된다.
    if (action === "set-setting") {
      const key = typeof body.key === "string" ? body.key : "";
      if (key === "") {
        // ★영어 문장도 **화면 언어가 아니면** 같은 결함이다 (2026-08-31, 3라운드). 어제
        //  한국어만 쫓다가 이 자리를 놓쳤다 — 손 목록이 이 파일을 대상에서 빼고 있었다.
        writeJson(res, 400, {
          ok: false,
          reason: "key required",
          reasonKey: "plugins.reason.settingKeyRequired",
        });
        return;
      }
      const v = body.value;
      const okType =
        v === undefined || v === null ||
        typeof v === "string" || typeof v === "number" || typeof v === "boolean";
      if (!okType) {
        writeJson(res, 400, {
          ok: false,
          reason: "value 는 문자열·숫자·참거짓이어야 합니다",
          reasonKey: "plugins.reason.badValueType",
        });
        return;
      }
      const { writePluginSetting } = await import(
        "../../src/core/plugins/settings.js"
      );
      const { scanPluginManifests } = await import("../../src/core/plugins/loader.js");
      const { appRoot, getPaths } = await import("../../src/core/paths.js");
      const nodePath = (await import("node:path")).default;
      // ★선언의 정본은 **매니페스트**다 — 목록 응답을 되읽지 않는다(두 벌이면 갈린다).
      //  번들이 먼저다(로더·자산 라우트와 같은 우선순위).
      const specs =
        (
          await Promise.all(
            [nodePath.join(appRoot(), "plugins"), getPaths().commonPlugins].map((root) =>
              scanPluginManifests(root),
            ),
          )
        )
          .flat()
          .find((x) => x.manifest.name === name)?.manifest.settings ?? [];
      const r = writePluginSetting(
        name,
        specs,
        key,
        v === null ? undefined : (v as string | number | boolean | undefined),
      );
      // ★사유는 **코어가 만든 키 그대로** 옮긴다 (2026-08-30, 3라운드 D-4). 여기서 문장을
      //  다시 짓지 않는다 — 같은 판단이 두 곳이 된다.
      writeJson(
        res,
        r.ok ? 200 : 400,
        r.ok
          ? { ok: true }
          : {
              ok: false,
              reason: r.error,
              ...(r.errorKey !== undefined ? { reasonKey: r.errorKey } : {}),
              ...(r.errorArgs !== undefined ? { reasonArgs: r.errorArgs } : {}),
            },
      );
      return;
    }
  } catch (e) {
    // ★**여기가 내부 예외가 사용자 문장이 되는 경계다** (2026-08-30, 적대 검토 E조 F3).
    //  종전엔 `e.message` 를 그대로 사유로 실어 보냈고 화면이 토스트에 띄웠다 — 코어의
    //  한국어 예외(예: "플러그인 관리자가 아직 준비되지 않았습니다")가 영어 사용자에게
    //  그대로 갔다. 부팅 중에 플러그인 버튼을 누르면 닿는다.
    // ★**틀은 번역하고 상세는 그대로 붙인다.** 예외 문구는 원래 번역 대상이 아니므로
    //  번역된 척하지 않는다 — 대신 "무슨 일이 났는지" 는 화면 언어로 말한다.
    writeJson(res, 500, {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
      reasonKey: "plugins.reason.actionFailed",
      reasonArgs: { detail: e instanceof Error ? e.message : String(e) },
    });
    return;
  }
  writeJson(res, 400, {
    error: "action must be install|remove|enable|disable|set-setting",
  });
  return;
};
