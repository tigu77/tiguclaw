/**
 * **운영 라우트** — 건강·로그·업데이트·재시작.
 *
 * ★`/self-update`·`/log-clear`·`/restart` 는 **비가역**이라 role 표에서 `admin` 이다
 *  (회귀 `bridge-role-table-complete` 가 그 등급을 못으로 박는다). 한자리에 모아두면
 *  "이 파일 안의 것은 전부 위험하다" 가 한눈에 보인다.
 */
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import path from "node:path";

// 앱 버전 = 레포 루트 package.json(데몬 cwd=repoRoot). 하드코딩 stale 방지 — /health 가 이걸
// 반환하고 대시보드 헤더가 표시한다. 읽기 실패 시 "unknown".
const VERSION: string = (() => {
  try {
    const raw = readFileSync(nodePath.join(process.cwd(), "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v !== "" ? v : "unknown";
  } catch {
    return "unknown";
  }
})();

import { getInflightTurns } from "../../src/core/inflight-turns.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { appRoot } from "../../src/core/paths.js";
import fs from "node:fs/promises";

import type { RouteCtx } from "./route-ctx.js";

export const handleHealth = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  const buffer_size = ctx.bus ? ctx.bus.history().length : 0;
  // ★진행 중 메인 턴 — "살아있나" 가 아니라 "지금 누구를 위해 일하나" (2026-08-01 A5).
  //  재시작 전 확인용. 미등록이면 null 로 답한다(0 과 구분 — 모르는 걸 안전으로 읽으면
  //  그게 사고의 형상이었다).
  const inflight = getInflightTurns();
  writeJson(res, 200, {
    ok: true,
    version: VERSION,
    // ★프로세스 가동시간 — "이게 **새 프로세스인가**" 의 유일한 답 (2026-08-21 검토 F5).
    //  업데이트 후 복귀 판정에 쓴다. version 으로는 안 된다(sync 는 대개 버전을 안 올린다).
    uptime_ms: Math.round(process.uptime() * 1000),
    buffer_size,
    subscribers: ctx.sseClients.size,
    channel_handler: ctx.channelHandler !== null,
    active_turns: inflight === null ? null : inflight.count,
    active_turn_threads: inflight === null ? null : inflight.keys,
  });
  return;
};

export const handleLogStatus = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  const { readLogFileStatus } = await import("../../src/core/log-file-admin.js");
  writeJson(res, 200, readLogFileStatus());
  return;
};

export const handleLogClear = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  const { clearTodayLog, readLogFileStatus } = await import(
    "../../src/core/log-file-admin.js"
  );
  const result = clearTodayLog();
  // 비운 뒤 상태를 같이 준다 — 화면이 다시 조회하지 않아도 되고, "정말 비워졌나" 를
  // 결과가 스스로 증명한다(성공을 말만 하지 않는다).
  writeJson(res, result.ok ? 200 : 500, { ...result, status: readLogFileStatus() });
  return;
};

export const handleUpdateAvailability = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  const { checkUpdateAvailability } = await import(
    "../../src/core/update-availability.js"
  );
  const { sourceRoot } = await import("../../src/core/paths.js");
  writeJson(res, 200, await checkUpdateAvailability(sourceRoot()));
  return;
};

export const handleUpdateChangelog = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  const { readUpdateChangelog } = await import(
    "../../src/core/update-availability.js"
  );
  const { sourceRoot } = await import("../../src/core/paths.js");
  writeJson(res, 200, await readUpdateChangelog(sourceRoot()));
  return;
};

export const handleSelfUpdate = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  const { runSelfUpdate } = await import("../../src/core/self-update.js");
  // restart 는 부팅 시 박힌 전역 레지스트리(setSelfUpdateRestart)가 처리한다 —
  // 도구(update_self) 경로와 같은 배선.
  const result = await runSelfUpdate({});
  writeJson(res, 200, result);
  return;
};

export const handleRestart = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  if (ctx.bus === null) {
    // observer 미연결 = 재시작 트리거 경로 없음. 거짓 200 금지.
    writeJson(res, 503, { error: "control bus not started" });
    return;
  }
  ctx.bus.publish({
    type: "control.restart",
    ts: Date.now(),
    payload: { source: "http-bridge:dashboard" },
  });
  // 데몬이 곧 종료되므로 즉시 ack(이 응답 후 graceful shutdown 진행).
  writeJson(res, 202, { ok: true, restarting: true });
  return;
};

export const handleChangelog = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  // ★경로는 **하나**다 — `appRoot()/CHANGELOG.md`(헌법 SYSTEM.md 와 같은 분류).
  //  개발 레포엔 루트에 그 파일이 없지만(오버레이가 정본), 그 차이는 **빌드 스크립트**
  //  (`bin/copy-dist-assets.mjs`)가 흡수한다 — 제품 코드에 dev 사정을 넣지 않는다.
  let md = "";
  try {
    md = await fs.readFile(path.join(appRoot(), "CHANGELOG.md"), "utf8");
  } catch {
    /* 없으면 빈 값 — 화면이 "찾지 못했습니다" 를 띄운다 */
  }
  // 없으면 빈 값으로 정직하게 — 화면이 "찾지 못했습니다" 를 띄운다(빈 화면 금지).
  writeJson(res, 200, { markdown: md });
  return;
};
