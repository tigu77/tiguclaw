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
import type { PluginHost } from "../../../src/core/plugins/host.js";

/**
 * ★이 턴의 사람 대화 — 감시를 «만든 대화에서» 처리하는 기준(2026-10-20 정태님). 호스트가 서버 쪽 턴 좌표로 정한다(모델 인자 아님).
 *  턴 밖(호스트 없음)이거나 사람이 없는 자리면 null → 전용 세션.
 */
type TurnSession = () => string | null;

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
      "각 실행에 필요한 정보가 현재 파일에 모두 있고 이전 실행과 비교할 필요가 없다면 0 을 권장한다 — 이어가면 앞선 실행의 판단을 다음 실행이 사실처럼 이어받는다. " +
      "★**전용 세션 감시에만** 쓴다 — 대화에서 처리되는 감시엔 줄 수 없다(사용자 대화를 감시가 잘라 낼 수는 없다).",
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

const addWatchTool = (turnSession: TurnSession) => tool(
  "add_watch",
  "새 file-watch 등록. path 절대/상대 모두 OK (절대로 정규화). pattern 옵션 = **경로 부분 문자열**(감시 경로 기준 상대 경로에 이 글자가 들어 있으면 맞음 — glob 아님: `*.json` 은 아무것도 안 걸린다) — 안 맞는 파일은 ignore. recursive=true 면 하위 폴더 무한 감시. debounce_ms 안에서 폭주 fs 이벤트는 1회로 묶임 (chokidar awaitWriteFinish). event_filter 콤마 결합 ('all'|'add'|'change'|'unlink' 또는 'add,change' 같은 결합). prompt 안의 `{path}` `{event}` 토큰은 발화 시점에 실제 값으로 치환. ★감시는 **이 대화에서 이어서 처리된다** — 변경이 생기면 이 대화에 차례가 들어와, 이 대화의 맥락(앞선 정정 포함)을 알고 판단하고, 띄운 작업도 이 대화 소유가 된다. 사람의 대화가 아닌 자리(스케줄 실행·전용 세션 감시의 실행 안)에서 등록하면 감시 전용 세션에서 돈다 — 그땐 판단에 필요한 맥락을 prompt 에 적어라. 결과 표시는 dest_channel/dest_target 으로 간다. 파일 변경만으로는 누가 바꿨는지 알 수 없으니 prompt 에 «사용자가 제출했다» 처럼 단정하지 말고 «바뀌었다» 로 적어라.",
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

    const origin = turnSession();
    if (origin !== null && args.keep_runs !== undefined && args.keep_runs !== null) {
      return okJson({ ok: false, error: "keep_runs_with_origin", detail: "이 감시는 이 대화에서 처리됩니다 — 대화를 감시가 잘라 낼 수 없어 keep_runs 를 줄 수 없습니다(생략하세요)." });
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
      originThreadKey: origin,
    });
    console.log(`[file-watch:${row.id}] '${row.label}' 등록 — 처리: ${origin ?? `전용 세션 file-watch:${row.id}`} · 결과 → ${row.destChannel}:${row.destTarget ?? "-"}`);

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
      runs_in: origin !== null ? "this_conversation" : "own_session",
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
      // 처리되는 자리 — 대화 키(만든 대화) 또는 전용 세션.
      runs_in: r.originThreadKey ?? `own_session file-watch:${r.id}`,
    }));
    return okJson({ ok: true, items });
  },
);

/**
 * 감시 수정 — **지금은 이력 정책만** 바꾼다(2026-10-19). 다른 필드(경로·패턴·프롬프트·목적지)는 감시를 다시 등록해야 하는 값이라
 *  여기 넣지 않는다(실행 중 쌓인 대기분이 옛 설정으로 이어 도는 경로가 생긴다 — 넣을 땐 이어 발화도 최신 행을 읽게 할 것).
 *  정책은 발화 때 새로 읽으므로(파사드) 감시를 다시 등록할 필요가 없다.
 */
const updateWatchTool = (turnSession: TurnSession) => tool(
  "update_watch",
  "기존 file-watch 를 고친다 — 감시를 지우고 다시 등록하지 않아도 다음 실행부터 적용된다. ①move_here=true: 이 감시를 **이 대화에서 처리**하도록 옮긴다(사용자가 «감시를 이 대화로 옮겨 줘» 라고 할 때 — 기준은 이 수정을 부른 대화, 다른 대화로는 못 옮긴다. 옮기면 keep_runs 는 지워진다). ②keep_runs: 전용 세션 감시의 이력 정책. 다른 필드는 지금 바꿀 수 없다(바꾸려면 delete_watch 뒤 add_watch). 존재하지 않는 id 면 ok:false, error:'not_found'.",
  {
    id: z.number().int().min(1),
    move_here: z.boolean().optional(),
    keep_runs: keepRunsArg,
  },
  async (args) => {
    if (args.keep_runs === undefined && args.move_here !== true) {
      return okJson({ ok: false, error: "nothing_to_update", detail: "move_here 또는 keep_runs 를 주세요." });
    }
    const before = getWatch(args.id);
    if (before === undefined) return okJson({ ok: false, error: "not_found" });
    let origin = before.originThreadKey;
    if (args.move_here === true) {
      const here = turnSession();
      if (here === null) return okJson({ ok: false, error: "no_conversation", detail: "이 턴은 사람의 대화가 아니라 옮길 대화가 없습니다." });
      origin = here;
    }
    if (origin !== null && args.keep_runs !== undefined && args.keep_runs !== null) {
      return okJson({ ok: false, error: "keep_runs_with_origin", detail: "대화에서 처리되는 감시엔 keep_runs 를 줄 수 없습니다." });
    }
    const row = updateWatch(args.id, {
      ...(args.move_here === true ? { originThreadKey: origin, keepRuns: null } : {}),
      ...(args.keep_runs !== undefined ? { keepRuns: args.keep_runs } : {}),
    });
    if (args.move_here === true) console.log(`[file-watch:${args.id}] '${before.label}' 처리 자리 변경 — ${before.originThreadKey ?? "전용 세션"} → ${origin}`);
    if (args.keep_runs !== undefined) console.log(`[file-watch:${args.id}] '${before.label}' 이력 정책 변경 — ${before.keepRuns ?? "이어감"} → ${row?.keepRuns ?? "이어감"}`);
    return okJson({ ok: true, id: args.id, keep_runs: row?.keepRuns ?? null, runs_in: row?.originThreadKey ?? `own_session file-watch:${args.id}` });
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
export const createFileWatchMcpServer = (host?: PluginHost): McpSdkServerConfigWithInstance => {
  const turnSession: TurnSession = () => host?.turnSession() ?? null;
  return createSdkMcpServer({
    name: "file-watch",
    version: "0.1.0",
    // 드물게 쓰는 «감시 고치기» 는 접는다(이름은 목록에 남고 쓸 때 스키마를 연다 — tool-load-policy).
    tools: onDemand([addWatchTool(turnSession), listWatchesTool, updateWatchTool(turnSession), deleteWatchTool], ["update_watch"]),
  });
};
