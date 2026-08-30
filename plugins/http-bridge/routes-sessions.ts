/**
 * **세션 라우트** — 목록·이름·보관.
 *
 * ★세션은 **채널과 무관한 대화 단위**다(v0.7.0). 여기 셋은 그 목록을 보여주고 이름을
 *  붙이고 접는다 — 내부 좌표(`worker:`·`agent:` 등)는 목록에서 빠진다.
 */
import { writeJson } from "../../src/core/net/write-json.js";
import { DEFAULT_SESSION_ID } from "../../src/core/threadkey.js";
import { setSessionArchived } from "../../src/store/channel-session.js";
import { getFirstUserText, getRecentChatLog } from "../../src/store/chat-log.js";
import { SESSION_STORAGE_CHANNEL, getSessionModelProfile, listThreads, sessionDisplayName, setThreadName } from "../../src/store/sessions.js";
import { readJsonBody } from "./http-body.js";
import type { RouteCtx } from "./route-ctx.js";

export const handleSessions = async (ctx: RouteCtx): Promise<void> => {
  const { res } = ctx;
  try {
    // 사용자에게 보이는 목록 — 프로브·검증 흔적 제외(대시보드 세션 목록과 /sessions 공통 기준).
    const threads = listThreads({ excludeInternal: true });
    const sessions = threads.map((t) => {
      // 프리뷰 — 그 스레드 최근 1건 text 요약(80자 슬라이스). 첨부-only(text="")는
      // 스킵되어 빈 프리뷰(undefined)로 graceful.
      const recent = getRecentChatLog({ threadKey: t.threadKey, limit: 1 });
      const previewText = recent.length > 0 ? recent[recent.length - 1]!.text : "";
      const preview =
        previewText.trim() !== ""
          ? previewText.replace(/\s+/g, " ").slice(0, 80)
          : undefined;
      // 세션 모델 프로파일(대시보드 드롭다운 상태 복원용, additive — 기존 소비자 무영향,
      // ADR model-dropdown §3-c). 미기재 세션 → null(드롭다운 default 로 hydrate).
      const modelProfile = getSessionModelProfile(
        SESSION_STORAGE_CHANNEL,
        t.threadKey,
      );
      return {
        threadKey: t.threadKey,
        lastUsedAt: t.lastUsedAt,
        ...(t.model !== null ? { model: t.model } : {}),
        ...(preview !== undefined ? { preview } : {}),
        ...(t.name !== null ? { name: t.name } : {}),
        // ★표시명은 **서버가 정한다** — 클라가 각자 파생하면 같은 세션이 채널마다
        //  다른 이름으로 보인다(실제로 그랬다: 대시보드 `세션3` vs 텔레그램 생키).
        displayName: sessionDisplayName(
          t.threadKey,
          t.name,
          // ★*첫* 발화다(최근 아님) — 최근으로 파생하면 이름이 매 턴 바뀐다.
          getFirstUserText(t.threadKey),
        ),
        modelProfile: modelProfile ?? null,
      };
    });
    writeJson(res, 200, {
      sessions,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: msg });
  }
  return;
};

export const handleSessionName = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let nbody: Record<string, unknown>;
  try {
    nbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const threadKey =
    typeof nbody.threadKey === "string" ? nbody.threadKey.trim() : "";
  if (threadKey === "") {
    writeJson(res, 400, { error: "threadKey required" });
    return;
  }
  const nameIn =
    typeof nbody.name === "string" ? nbody.name : null;
  try {
    setThreadName(threadKey, nameIn);
    // 정규화된 값을 응답에 반영 — store 는 changes count 만 반환하므로 여기서
    // 동일 정규화 규칙(trim·60캡·빈값→null)을 재적용해 클라 로컬 동기화값을 만든다.
    const normName =
      nameIn === null || nameIn.trim() === ""
        ? null
        : nameIn.trim().slice(0, 60);
    writeJson(res, 200, { ok: true, threadKey, name: normName });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};

export const handleSessionArchive = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let abody: Record<string, unknown>;
  try {
    abody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const threadKey =
    typeof abody.threadKey === "string" ? abody.threadKey.trim() : "";
  if (threadKey === "") {
    writeJson(res, 400, { error: "threadKey required" });
    return;
  }
  if (threadKey === DEFAULT_SESSION_ID) {
    writeJson(res, 400, { error: "기본 세션은 보관할 수 없습니다" });
    return;
  }
  const archived = abody.archived !== false; // 미지정 = 보관.
  try {
    // 보관 = 바인딩 해제까지 한 동작(setSessionArchived). 대시보드 탭 닫기가 오는
    // **주 경로**인데 종전엔 여기만 바인딩을 안 풀어, 방이 목록에 없는 세션에 계속 묶였다.
    const { unboundRooms } = setSessionArchived(threadKey, archived);
    writeJson(res, 200, { ok: true, threadKey, archived, ...(unboundRooms > 0 ? { unboundRooms } : {}) });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 500, { error: m });
  }
  return;
};
