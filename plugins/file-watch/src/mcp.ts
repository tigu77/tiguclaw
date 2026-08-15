/**
 * file-watch MCP — SDK in-process MCP server.
 *
 * tools 3종 (contract §4):
 *  - add_watch    — 등록 + path 존재성 dryrun 검증 + lifecycle hook (watcher 즉시 활성)
 *  - list_watches — only_enabled 옵션 + 각 row shape
 *  - delete_watch — 멱등
 *
 * SDK 외부 노출 이름: mcp__file-watch__{tool}.
 * scheduler MCP server 동형 패턴 (`plugins/scheduler/src/mcp.ts`).
 *
 * watcher 객체 생성·취소는 plugin entry (index.ts) 의 register/unregister.
 * 본 모듈은 *등록·조회·삭제* + 새 watch 활성 시 lifecycle hook 호출만.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  addWatch,
  deleteWatch,
  getWatch,
  listWatches,
  type WatchRow,
} from "../../../src/store/watches.js";

const okJson = (
  obj: unknown,
): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: JSON.stringify(obj) }],
});

/** 외부에서 plugin lifecycle 콜백 주입 — add_watch 성공 시 watcher 등록 trigger. */
type LifecycleHooks = {
  onWatchAdded?: (row: WatchRow) => void;
  onWatchDeleted?: (id: number) => void;
};

let lifecycle: LifecycleHooks = {};

export const setFileWatchLifecycleHooks = (hooks: LifecycleHooks): void => {
  lifecycle = hooks;
};

const addWatchTool = tool(
  "add_watch",
  "새 file-watch 등록. path 절대/상대 모두 OK (절대로 정규화). pattern (glob 부분 문자열) 옵션 — 매치 안 되는 경로는 ignore. recursive=true 면 하위 폴더 무한 감시. debounce_ms 안에서 폭주 fs 이벤트는 1회로 묶임 (chokidar awaitWriteFinish). event_filter 콤마 결합 ('all'|'add'|'change'|'unlink' 또는 'add,change' 같은 결합). prompt 안의 `{path}` `{event}` 토큰은 발화 시점에 실제 값으로 치환.",
  {
    label: z.string().min(1).max(120),
    path: z.string().min(1).max(1024),
    pattern: z.string().max(256).optional(),
    recursive: z.boolean().optional(),
    debounce_ms: z.number().int().min(0).max(60000).optional(),
    event_filter: z.string().min(1).max(64).optional(),
    prompt: z.string().min(1).max(4096),
    dest_channel: z.string().min(1).max(64),
    dest_target: z.string().max(256).optional(),
  },
  async (args) => {
    // path 존재성 dryrun. chokidar 가 부재 path 도 수용 (나중에 생기면 발화) 하지만
    // 사용자 의도 정합 위해 명시 검증 — 부재 시 user-friendly error.
    const absPath = path.resolve(args.path);
    if (!fs.existsSync(absPath)) {
      return okJson({
        ok: false,
        error: "path_not_found",
        detail: `path does not exist: ${absPath}`,
      });
    }

    const row = addWatch({
      label: args.label,
      path: absPath,
      pattern: args.pattern ?? null,
      recursive: args.recursive ?? true,
      debounceMs: args.debounce_ms ?? 500,
      eventFilter: args.event_filter ?? "all",
      prompt: args.prompt,
      destChannel: args.dest_channel,
      destTarget: args.dest_target ?? null,
    });

    // plugin lifecycle 에 추가 알림 — watcher 즉시 활성.
    try {
      lifecycle.onWatchAdded?.(row);
    } catch (e) {
      console.error("file-watch: onWatchAdded hook threw", e);
    }

    return okJson({
      ok: true,
      id: row.id,
      path: absPath,
    });
  },
);

const listWatchesTool = tool(
  "list_watches",
  "등록된 file-watch 전체 목록. only_enabled=true 면 활성만. 각 row 의 last_path/last_event/last_status 포함.",
  {
    only_enabled: z.boolean().optional(),
  },
  async (args) => {
    const rows = listWatches({ onlyEnabled: args.only_enabled === true });
    const items = rows.map((r) => ({
      id: r.id,
      label: r.label,
      path: r.path,
      pattern: r.pattern,
      recursive: r.recursive,
      debounce_ms: r.debounceMs,
      event_filter: r.eventFilter,
      prompt: r.prompt,
      dest_channel: r.destChannel,
      dest_target: r.destTarget,
      enabled: r.enabled,
      last_fired_at: r.lastFiredAt,
      last_path: r.lastPath,
      last_event: r.lastEvent,
      last_status: r.lastStatus,
      last_error: r.lastError,
    }));
    return okJson({ ok: true, items });
  },
);

const deleteWatchTool = tool(
  "delete_watch",
  "file-watch 영구 삭제. 존재하지 않는 id 도 멱등 (deleted:false).",
  { id: z.number().int().min(1) },
  async (args) => {
    const existed = getWatch(args.id) !== undefined;
    const deleted = deleteWatch(args.id);
    if (existed) {
      try {
        lifecycle.onWatchDeleted?.(args.id);
      } catch (e) {
        console.error("file-watch: onWatchDeleted hook threw", e);
      }
    }
    return okJson({ ok: true, deleted });
  },
);

/**
 * SDK in-process MCP server **팩토리** — 부를 때마다 새 인스턴스.
 * (scheduler 와 동일한 이유 — 프로세스 싱글턴이면 동시 턴에서 깨진다. 2026-08-10.)
 */
export const createFileWatchMcpServer = (): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "file-watch",
    version: "0.1.0",
    tools: [addWatchTool, listWatchesTool, deleteWatchTool],
  });
