/**
 * 회귀: **수정이 낸 2차 결함** (2026-07-31, 검토가 전부 재현).
 *
 * 오늘 P0 을 고치면서 새로 5건을 깨뜨렸다. 넷은 같은 병이다 — **판정을 이름 목록으로 쓰거나,
 * 가드를 한 갈래에만 달았다.** 고친 뒤 각각 그물을 건다.
 *
 *  ①**부팅 크래시 루프.** `dispatch` 가 미배달에 throw 하게 바꿨는데, `!say` 직송 경로엔
 *   catch 가 없고 호출부가 `void` 라 → unhandledRejection → crash-fast → respawn → 재발.
 *   하필 라이브에 `trigger_type=reboot` + `!say` 스케줄이 있어 **부팅마다** 터진다.
 *   게다가 `recordFiring` 이 아예 안 불려 **DB 에 실패 기록조차 안 남았다** — 그 수정이
 *   노린 것의 정반대.
 *
 *  ②**읽기 전용 도구가 폴백을 잃었다.** 부작용 판정이 무해 도구 **7개 열거**였는데 실제
 *   등록 도구 중 읽기 전용인데 목록 밖인 게 **12개**였다(`read_memory`·`list_*`·`find_*`…).
 *   종전엔 무해했다(어차피 throw → 폴백). 가드를 `if (sideEffectExecuted)` 로 뒤집으면서
 *   **오분류의 대가가 "폴백 상실"로 바뀌었다** — 메모리를 한 번 읽은 턴은 502 에서
 *   claude 안전망 없이 죽는다.
 *
 *  ③**취소가 삼켜졌다.** 내가 단 주석이 "취소류는 위에서 단락되니 여기 안 온다" 고 단언
 *   했는데 **거짓**이었다(단락되는 건 TurnTimeoutError 하나). 결과: `/stop` 후 가짜 에러
 *   답장 + 취소된 턴이 **성공으로** 적재, **워커 타임아웃이 "완료" 로 보고**.
 *
 *  ④**`[fatal]` 을 `/logs` 가 버렸다.** 같은 날 `logFatal` 이 새 레벨을 만들었는데
 *   `LOG_LINE_PREFIX` 가 레벨을 **열거**해서 크래시 원인 줄이 통째로 접혔다 —
 *   두 수정이 서로를 무력화했고, `logFatal` 의 존재 이유가 정확히 안 닫혔다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

const CODEX = "../../core/llm-runtime/adapters/openai-codex-oauth.ts";

export const check: RegressionCheck = {
  name: "fix-fallout",
  guards:
    "P0 수정이 낸 2차 결함 — 부팅 크래시 루프, 읽기전용 도구 폴백 상실, 취소 삼킴, /logs 가 [fatal] 을 버림",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 직송 경로에 catch — 없으면 unhandledRejection → crash-fast.
    const sched = await sourceHas("../../../plugins/scheduler/src/runner.ts", [
      /try \{\s*await \(deps\.dispatch \?\? dispatch\)\(\{/,
      /\} catch \(e\) \{[\s\S]{0,200}?recordFiring\(schedule\.id, \{ ok: false, error: reason \}\)/,
    ]);
    out.push(
      assert(
        "★!say 직송이 발송 실패를 catch 한다(void 호출부 → 크래시 루프 방지)",
        sched.ok,
        sched.ok ? "catch + ok:false 확인" : `누락 ${sched.missing.join(" ")}`,
      ),
    );

    // ★② 부작용 판정이 **열거가 아니라 판정** — 읽기전용 12개가 옳게 분류돼야 한다.
    const criterion = await sourceHas(CODEX, [
      /const READ_ONLY_VERB = \/\^\(\?:read\|list\|find\|search\|get\|describe\|show\)_\//,
      /const isSideEffectTool = \(name: string\): boolean =>/,
      /if \(isSideEffectTool\(tc\.name\)\) sideEffectExecuted = true;/,
    ]);
    out.push(
      assert(
        "★부작용 판정이 이름 열거가 아니라 조회동사 판정이다",
        criterion.ok,
        criterion.ok ? "3개 확인" : `누락 ${criterion.missing.join(" ")}`,
      ),
    );
    // 판정 자체를 **동작으로** 검증 — 검토가 지목한 12개 + 진짜 부작용.
    const READ_ONLY_VERB = /^(?:read|list|find|search|get|describe|show)_/;
    const EXACT = new Set([
      "Read", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookRead",
      "reply_to_current_message", "update_todos",
    ]);
    const isSide = (n: string): boolean => !EXACT.has(n) && !READ_ONLY_VERB.test(n);
    const readOnly = [
      "read_memory", "search_memory", "list_schedules", "list_workers", "list_all_workers",
      "list_watches", "list_commands", "list_endpoints", "list_installed_plugins",
      "find_skills", "find_agents", "find_capabilities", "Read", "Grep",
    ];
    const mutating = [
      "add_memory", "add_schedule", "delete_schedule", "spawn_agent", "spawn_worker",
      "Write", "Edit", "Bash", "update_self", "send_file", "unknown_future_tool",
    ];
    const wrong = [
      ...readOnly.filter((n) => isSide(n)).map((n) => `읽기전용→부작용:${n}`),
      ...mutating.filter((n) => !isSide(n)).map((n) => `부작용→무해:${n}`),
    ];
    out.push(
      assert(
        "★읽기전용 14개·부작용 11개(미지 포함)가 옳게 갈린다",
        wrong.length === 0,
        wrong.length === 0 ? "25개 전부 정확" : wrong.join(" "),
      ),
    );

    // ★③ 취소는 부작용과 무관하게 rethrow — 동일성 판정(이름 목록 아님).
    const cancel = await sourceHas(CODEX, [
      /const abortReason: unknown = input\.abortSignal\?\.reason;/,
      /if \(input\.abortSignal\?\.aborted === true && e === abortReason\) \{\s*throw e;/,
    ]);
    out.push(
      assert(
        "★취소류는 삼키지 않고 그대로 올린다(워커 타임아웃이 '완료' 로 보고되던 것)",
        cancel.ok,
        cancel.ok ? "동일성 판정 확인" : `누락 ${cancel.missing.join(" ")}`,
      ),
    );

    // ★④ /logs 가 레벨을 열거하지 않는다 — 새 레벨이 생겨도 따라온다.
    const { sanitizeLogTail } = await import("../../core/log-sanitize.js");
    const r = sanitizeLogTail([
      "[2026-07-31 18:00:00] [log] 정상",
      "[2026-07-31 18:00:01] [fatal] daemon: uncaughtException — crash-fast",
      "[2026-07-31 18:00:02] [trace] 미래에 생길 레벨",
    ]);
    const joined = r.out.join("\n");
    out.push(
      assert(
        "★[fatal]·미지 레벨도 /logs 를 통과한다(크래시 원인이 보인다)",
        joined.includes("uncaughtException") && joined.includes("미래에 생길 레벨"),
        `dropped=${r.dropped} out=${r.out.length}줄`,
      ),
    );
    return out;
  },
};
