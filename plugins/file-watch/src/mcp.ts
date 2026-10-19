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
  updateWatch,
  type WatchRow,
} from "../../../src/store/watches.js";
import { KEEP_RUNS_MAX } from "../../../src/store/trigger-runs.js";
import { onDemand } from "../../../src/core/llm-runtime/tool-load-policy.js";

/** 이력 정책 인자 — add_watch·update_watch 가 같은 정의를 쓴다(스케줄 `keep_runs` 와 같은 뜻). */
const keepRunsArg = z
  .number()
  .int()
  .min(0)
  .max(KEEP_RUNS_MAX)
  .nullable()
  .optional()
  .describe(
    "이력 정책 — 생략·null = 이전 실행 대화를 계속 이어감(기본), 0 = 매번 새로 시작, N = 직전 N회만 이어감. " +
      "각 실행에 필요한 정보가 현재 파일에 모두 있고 이전 실행과 비교할 필요가 없다면 0 을 권장한다 — 이어가면 앞선 실행의 판단을 다음 실행이 사실처럼 이어받는다.",
  );

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
  "새 file-watch 등록. path 절대/상대 모두 OK (절대로 정규화). pattern 옵션 = **경로 부분 문자열**(감시 경로 기준 상대 경로에 이 글자가 들어 있으면 맞음 — glob 아님: `*.json` 은 아무것도 안 걸린다) — 안 맞는 파일은 ignore. recursive=true 면 하위 폴더 무한 감시. debounce_ms 안에서 폭주 fs 이벤트는 1회로 묶임 (chokidar awaitWriteFinish). event_filter 콤마 결합 ('all'|'add'|'change'|'unlink' 또는 'add,change' 같은 결합). prompt 안의 `{path}` `{event}` 토큰은 발화 시점에 실제 값으로 치환. ★감시 실행은 이 대화가 아니라 **감시 전용 세션**에서 돈다 — 이 대화의 이력을 모르니 판단에 필요한 맥락은 prompt 에 적어라. 파일 변경만으로는 누가 바꿨는지 알 수 없으니 prompt 에 «사용자가 제출했다» 처럼 단정하지 말고 «바뀌었다» 로 적어라.",
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
    keep_runs: keepRunsArg,
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
      keepRuns: args.keep_runs ?? null,
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
      keep_runs: r.keepRuns,
    }));
    return okJson({ ok: true, items });
  },
);

/**
 * 감시 수정 — **지금은 이력 정책만** 바꾼다(2026-10-19). 다른 필드(경로·패턴·프롬프트·목적지)는 감시를 다시 등록해야 하는 값이라
 *  여기 넣지 않는다(실행 중 쌓인 대기분이 옛 설정으로 이어 도는 경로가 생긴다 — 넣을 땐 이어 발화도 최신 행을 읽게 할 것).
 *  정책은 발화 때 새로 읽으므로(파사드) 감시를 다시 등록할 필요가 없다.
 */
const updateWatchTool = tool(
  "update_watch",
  "기존 file-watch 의 이력 정책(keep_runs)을 바꾼다 — 감시를 지우고 다시 등록하지 않아도 다음 실행부터 적용된다. 다른 필드는 지금 바꿀 수 없다(바꾸려면 delete_watch 뒤 add_watch). 존재하지 않는 id 면 ok:false, error:'not_found'.",
  {
    id: z.number().int().min(1),
    keep_runs: keepRunsArg,
  },
  async (args) => {
    if (args.keep_runs === undefined) return okJson({ ok: false, error: "nothing_to_update", detail: "keep_runs 를 주세요(null = 계속 이어감)." });
    const before = getWatch(args.id);
    if (before === undefined) return okJson({ ok: false, error: "not_found" });
    const row = updateWatch(args.id, { keepRuns: args.keep_runs });
    console.log(`[file-watch:${args.id}] '${before.label}' 이력 정책 변경 — ${before.keepRuns ?? "이어감"} → ${row?.keepRuns ?? "이어감"}`);
    return okJson({ ok: true, id: args.id, keep_runs: row?.keepRuns ?? null });
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
    // 드물게 쓰는 «이력 정책 바꾸기» 는 접는다(이름은 목록에 남고 쓸 때 스키마를 연다 — tool-load-policy).
    tools: onDemand([addWatchTool, listWatchesTool, updateWatchTool, deleteWatchTool], ["update_watch"]),
  });
