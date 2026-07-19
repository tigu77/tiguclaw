/**
 * scheduler MCP — SDK in-process MCP server (memory.ts 동형).
 *
 * tools 4종 (contract §5):
 *  - add_schedule    — cron expression dry-parse + nextRun ISO 응답
 *  - list_schedules  — only_enabled 옵션 + 각 row 의 next_run ISO 계산
 *  - update_schedule — 부분 패치 + cron 재검증 + enable/disable 토글 흡수
 *  - delete_schedule — 멱등
 *
 * SDK 외부 노출 이름: mcp__scheduler__{tool}.
 * 권한 게이트가 차단하려면 src/auth/permissions.ts DISALLOWED_TOOLS 에 그 이름으로 추가 가능.
 *
 * cron 객체 생성·취소는 plugin entry (index.ts) 의 startSchedule/stopSchedule 가 담당.
 * 본 모듈은 *등록·조회·삭제* + 새 schedule 활성 시 cron 등록 trigger 만.
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { Cron } from "croner";
import {
  addSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  type ScheduleRow,
} from "../../../src/store/schedules.js";

const okJson = (
  obj: unknown,
): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: JSON.stringify(obj) }],
});

/** 외부에서 plugin lifecycle 콜백 주입 — add_schedule 성공 시 cron 등록 trigger. */
type LifecycleHooks = {
  onScheduleAdded?: (row: ScheduleRow) => void;
  onScheduleDeleted?: (id: number) => void;
  /** update_schedule 성공 시 갱신 row 전달 — cron 재등록/해제는 plugin index.ts 가 판단. */
  onScheduleUpdated?: (row: ScheduleRow) => void;
};

let lifecycle: LifecycleHooks = {};

export const setSchedulerLifecycleHooks = (hooks: LifecycleHooks): void => {
  lifecycle = hooks;
};

/** cron expression 안전 dry-parse + 다음 발화 시각 ISO. */
const validateCronExpr = (
  expr: string,
  timezone: string,
): { ok: true; nextRun: string | null } | { ok: false; error: string } => {
  try {
    const dry = new Cron(expr, { timezone, paused: true });
    const next = dry.nextRun();
    return { ok: true, nextRun: next === null ? null : next.toISOString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
};

const addScheduleTool = tool(
  "add_schedule",
  "새 schedule 등록. trigger_type 'cron' (default — cron 표현식 5/6 필드 또는 @daily/@hourly 매크로) 또는 'reboot' (데몬 부팅 때마다 발화, cron_expr 무시). timezone (IANA, 기본 Asia/Seoul), prompt (영역 A 가상 사용자 prompt — ★스케줄러가 이 turn 의 *답* 을 dest_channel 로 자동 전달한다. 그러니 사용자가 '이런 알림 보내줘 <문구>' 처럼 고정 문구 통지를 요청하면 prompt 를 정확히 이 틀로 써라: `다음 문구로만 짧게 정확히 답하라: '<문구>'`. 이러면 turn 이 그 문구만 답하고 스케줄러가 전달한다. '<채널>로 보내라' 같은 *능동 발송* 지시로 쓰지 마라 — 그러면 비서가 외부발송 확인 게이트에 걸려 확인 질문을 하거나 워커로 우회하고, '전송 완료' 같은 완료 보고까지 함께 전달돼 알림이 지저분해진다), dest_channel (telegram/cli/http-bridge 등), dest_target (채널별 — telegram chatId 등).",
  {
    label: z.string().min(1).max(120),
    trigger_type: z.enum(["cron", "reboot"]).optional(),
    cron_expr: z.string().max(120).optional(),
    timezone: z.string().min(1).max(64).optional(),
    prompt: z.string().min(1).max(4096),
    dest_channel: z.string().min(1).max(64),
    dest_target: z.string().max(256).optional(),
  },
  async (args) => {
    const triggerType = args.trigger_type ?? "cron";
    const tz = args.timezone ?? "Asia/Seoul";

    let nextRunIso: string | null;
    let cronExpr: string;

    if (triggerType === "reboot") {
      // reboot 트리거는 cron 표현식 의미 0 — 빈 문자열로 박고 dryrun 건너뜀.
      // 사용자가 cron_expr 전달했더라도 무시.
      cronExpr = "";
      nextRunIso = null;
    } else {
      // cron 트리거 — 기존 V1 동작 100% 보존.
      const exprArg = args.cron_expr ?? "";
      if (exprArg.trim().length === 0) {
        return okJson({
          ok: false,
          error: "invalid_cron_expr",
          detail: "cron_expr is required when trigger_type='cron'",
        });
      }
      const validation = validateCronExpr(exprArg, tz);
      if (!validation.ok) {
        return okJson({
          ok: false,
          error: "invalid_cron_expr",
          detail: validation.error,
        });
      }
      cronExpr = exprArg;
      nextRunIso = validation.nextRun;
    }

    const row = addSchedule({
      label: args.label,
      cronExpr,
      timezone: tz,
      prompt: args.prompt,
      destChannel: args.dest_channel,
      destTarget: args.dest_target ?? null,
      triggerType,
    });
    // plugin lifecycle 에 추가 알림 — cron/reboot 분기는 plugin index.ts 에서.
    try {
      lifecycle.onScheduleAdded?.(row);
    } catch (e) {
      console.error("scheduler: onScheduleAdded hook threw", e);
    }
    return okJson({
      ok: true,
      id: row.id,
      trigger_type: triggerType,
      next_run: nextRunIso,
    });
  },
);

const listSchedulesTool = tool(
  "list_schedules",
  "등록된 schedule 전체 목록. only_enabled=true 면 활성만. 각 row 에 trigger_type ('cron'|'reboot') + next_run (ISO 또는 null) 포함. reboot row 는 next_run=null (다음 daemon.boot 까지 대기 의미).",
  {
    only_enabled: z.boolean().optional(),
  },
  async (args) => {
    const rows = listSchedules({ onlyEnabled: args.only_enabled === true });
    const items = rows.map((r) => {
      let nextRun: string | null = null;
      if (r.enabled && r.triggerType === "cron") {
        const v = validateCronExpr(r.cronExpr, r.timezone);
        if (v.ok) nextRun = v.nextRun;
      }
      return {
        id: r.id,
        label: r.label,
        trigger_type: r.triggerType,
        cron_expr: r.cronExpr,
        timezone: r.timezone,
        prompt: r.prompt,
        dest_channel: r.destChannel,
        dest_target: r.destTarget,
        enabled: r.enabled,
        last_fired_at: r.lastFiredAt,
        last_status: r.lastStatus,
        last_error: r.lastError,
        next_run: nextRun,
      };
    });
    return okJson({ ok: true, items });
  },
);

const updateScheduleTool = tool(
  "update_schedule",
  "기존 schedule 수정 (부분 패치 — 준 필드만 바뀜). id 로 대상 지정. 바꿀 수 있는 것: label, trigger_type ('cron'|'reboot'), cron_expr, timezone, prompt, dest_channel, dest_target, enabled (true=활성/false=비활성 — enable/disable 토글을 이 도구로 한다. delete 대신 잠깐 끄고 싶을 때 enabled=false). cron_expr 이 바뀌거나 trigger_type 이 'cron' 인데 기존 cron_expr 이 비어있으면 유효성 검사 후 next_run 을 재계산해 응답. trigger_type='reboot' 로 전환하면 cron_expr 은 무시·초기화(다음 daemon.boot 발화). trigger_type='cron' 으로 전환하는데 저장된 cron_expr 이 없으면 cron_expr 을 반드시 함께 줘야 함. prompt 를 바꿀 때는 add_schedule 과 동일한 고정문구 규칙(`다음 문구로만 짧게 정확히 답하라: '<문구>'`)을 따른다. 존재하지 않는 id 면 ok:false, error:'not_found'.",
  {
    id: z.number().int().min(1),
    label: z.string().min(1).max(120).optional(),
    trigger_type: z.enum(["cron", "reboot"]).optional(),
    cron_expr: z.string().max(120).optional(),
    timezone: z.string().min(1).max(64).optional(),
    prompt: z.string().min(1).max(4096).optional(),
    dest_channel: z.string().min(1).max(64).optional(),
    dest_target: z.string().max(256).optional(),
    enabled: z.boolean().optional(),
  },
  async (args) => {
    const existing = getSchedule(args.id);
    if (existing === undefined) {
      return okJson({
        ok: false,
        error: "not_found",
        detail: `no schedule id=${args.id}`,
      });
    }

    // 유효한 최종 상태 기준으로 cron 검증 — 패치 후 실제 저장될 값을 미리 합성.
    const effectiveTrigger = args.trigger_type ?? existing.triggerType;
    const effectiveTz = args.timezone ?? existing.timezone;

    const patch: Parameters<typeof updateSchedule>[1] = {};
    if (args.label !== undefined) patch.label = args.label;
    if (args.timezone !== undefined) patch.timezone = args.timezone;
    if (args.prompt !== undefined) patch.prompt = args.prompt;
    if (args.dest_channel !== undefined) patch.destChannel = args.dest_channel;
    if (args.dest_target !== undefined) patch.destTarget = args.dest_target;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.trigger_type !== undefined) patch.triggerType = args.trigger_type;

    let nextRunIso: string | null;
    if (effectiveTrigger === "reboot") {
      // reboot 전환 시 cron_expr 은 의미 0 — 초기화 (add_schedule 와 동형).
      // 사용자가 cron_expr 을 함께 줬더라도 무시.
      if (args.trigger_type === "reboot") {
        patch.cronExpr = "";
      }
      nextRunIso = null;
    } else {
      // 최종 cron 표현식 = 패치값 우선, 없으면 기존값.
      const effectiveExpr = args.cron_expr ?? existing.cronExpr;
      if (effectiveExpr.trim().length === 0) {
        return okJson({
          ok: false,
          error: "invalid_cron_expr",
          detail: "cron_expr is required when trigger_type='cron'",
        });
      }
      const validation = validateCronExpr(effectiveExpr, effectiveTz);
      if (!validation.ok) {
        return okJson({
          ok: false,
          error: "invalid_cron_expr",
          detail: validation.error,
        });
      }
      if (args.cron_expr !== undefined) patch.cronExpr = args.cron_expr;
      nextRunIso = validation.nextRun;
    }

    const updated = updateSchedule(args.id, patch);
    if (updated === undefined) {
      return okJson({ ok: false, error: "not_found" });
    }
    // plugin lifecycle 에 갱신 알림 — cron 재등록/해제는 index.ts 에서 판단.
    try {
      lifecycle.onScheduleUpdated?.(updated);
    } catch (e) {
      console.error("scheduler: onScheduleUpdated hook threw", e);
    }
    return okJson({
      ok: true,
      id: updated.id,
      trigger_type: updated.triggerType,
      enabled: updated.enabled,
      next_run: nextRunIso,
    });
  },
);

const deleteScheduleTool = tool(
  "delete_schedule",
  "schedule 영구 삭제. 존재하지 않는 id 도 멱등 (deleted:false).",
  { id: z.number().int().min(1) },
  async (args) => {
    const existed = getSchedule(args.id) !== undefined;
    const deleted = deleteSchedule(args.id);
    if (existed) {
      try {
        lifecycle.onScheduleDeleted?.(args.id);
      } catch (e) {
        console.error("scheduler: onScheduleDeleted hook threw", e);
      }
    }
    return okJson({ ok: true, deleted });
  },
);

/** SDK in-process MCP server. src/index.ts 가 부팅 시 import → extraMcpServers 에 박는다. */
export const schedulerMcpServer: McpSdkServerConfigWithInstance =
  createSdkMcpServer({
    name: "scheduler",
    version: "0.1.0",
    tools: [
      addScheduleTool,
      listSchedulesTool,
      updateScheduleTool,
      deleteScheduleTool,
    ],
  });
