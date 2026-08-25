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
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

const CODEX = "../../core/llm-runtime/adapters/openai-codex-oauth.ts";

export const check: RegressionCheck = {
  name: "fix-fallout",
  guards:
    "P0 수정이 낸 2차 결함 — 부팅 크래시 루프, 읽기전용 도구 폴백 상실, 취소 삼킴, /logs 가 [fatal] 을 버림",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 부팅 크래시 루프(직송 경로 catch 누락)는 **동작 검사로 이관**했다 —
    //  `silent-loss` 가 실제로 `runScheduleFiring` 을 전달 실패로 돌려, reject 가 새지
    //  않고 ok:false 로 기록되는지 본다. 여기 있던 정규식은 catch 블록의 **모양**만 봐서,
    //  에러 문자열 한 글자만 바뀌어도 빨간불이 되면서 정작 동작은 안 봤다.

    // ★② 부작용 판정이 **열거가 아니라 판정** — 읽기전용 12개가 옳게 분류돼야 한다.
    const criterion = await sourceHas(CODEX, [
      /if \(isSideEffectTool\(tc\.name\)\) sideEffectExecuted = true;/,
    ]);
    out.push(
      assert(
        "부작용 판정이 도구 실행 지점에 배선돼 있다",
        criterion.ok,
        criterion.ok ? "배선 확인" : `누락 ${criterion.missing.join(" ")}`,
      ),
    );

    // ★판정을 **프로덕션 함수로, 실제 등록 도구 전수에** 돌린다 (2026-07-31 3차 검토).
    //  종전엔 이 검사가 판정 로직을 **복사**해서 손으로 적은 25개에 돌렸다. 그래서
    //  ①프로덕션이 바뀌어도 사본은 안 바뀌고 ②목록에 없는 도구는 아예 안 보였다.
    //  실제로 `project_capabilities`(라이브 124회)·`project_list`·`maintenance_status`
    //  세 개가 그 목록 밖이라 오분류가 통째로 숨었다 — 25개 전부 정확이라고 초록이었다.
    //  이제 소스에서 도구를 긁어와 분류표와 대조한다. **새 도구가 표에 없으면 실패**한다
    //  — 조용히 빠지는 대신 요란하게 결정을 요구하는 것이 이 검사의 요점이다.
    const { isReadOnlyTool } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth.js"
    );
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const registered = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!/node_modules|dist/.test(p)) await walk(p);
          continue;
        }
        if (!e.name.endsWith(".ts")) continue;
        const src = await readFile(p, "utf8");
        for (const m of src.matchAll(/\btool\(\s*\n?\s*"([a-zA-Z][\w]*)"/g)) {
          registered.add(m[1]);
        }
      }
    };
    await walk(path.join(repoRoot, "src/core"));
    await walk(path.join(repoRoot, "plugins"));

    /** 읽기 전용 = 폴백이 다시 실행해도 무해한 것. 그 밖은 전부 부작용(보수적). */
    const EXPECT_READ_ONLY = new Set([
      "Glob", "Grep", "Read", "WebFetch", "WebSearch",
      "find_agents", "find_capabilities", "find_skills",
      "list_all_workers", "list_commands", "list_endpoints", "list_installed_plugins",
      "list_mcp_servers", "list_schedules", "list_watches", "list_workers",
      "maintenance_status", "project_capabilities", "project_list",
      "read_memory", "search_memory",
      // 지난 대화 조회 — 순수 읽기(2026-08-25).
      "search_conversations", "list_conversations",
      // 부작용이 있으나 재실행이 무해(멱등·표시 전용).
      "reply_to_current_message", "update_todos",
      // 세션 목록 조회 — 순수 읽기.
      "list_sessions",
    ]);
    const EXPECT_SIDE_EFFECT = new Set([
      "Bash", "Edit", "KillShell", "Write",
      // ★BashOutput 은 읽기처럼 보이지만 **증분 커서를 전진**시킨다 — 폴백이 다시 부르면
      //  이미 소비한 출력이 사라진다. 멱등이 아니므로 부작용으로 둔다.
      "BashOutput",
      // 사용자에게 선택지를 다시 띄운다 — 표시 중복.
      "prompt_options",
      "add_mcp_server", "add_memory", "add_schedule", "add_watch",
      "cancel_worker", "delete_command", "delete_endpoint", "delete_memory",
      "delete_schedule", "delete_watch", "invoke_skill",
      "project_forget", "project_register", "project_update",
      "register_command", "register_endpoint", "remove_mcp_server",
      "run_in_background", "send_file", "spawn_agent", "steer_worker",
      "update_memory", "update_schedule", "update_self",
      // 세션 이름 변경 — 되돌릴 수 있지만 상태를 바꾼다(읽기전용 폴백 대상 아님).
      "rename_session",
      // 세션 보관 — 되돌릴 수 있지만(restore) 목록에서 치우고 **대화방 바인딩을 푼다**.
      // 재실행이 무해해 보여도(멱등) 폴백이 되부르는 상황은 앞 시도가 어디까지 갔는지
      // 모르는 때다. 상태를 바꾸는 것은 부작용으로 둔다(보수적 기본).
      "archive_session",
      // 추론 강도 설정 — settings.json 을 쓴다. 같은 값으로 다시 부르면 결과는 같지만
      // (멱등), 폴백이 되부르는 상황은 보통 **앞 시도가 어디까지 갔는지 모르는** 때다.
      // 설정 파일 쓰기를 재실행 무해로 분류할 이유가 없다(보수적 기본).
      "set_model_reasoning",
    ]);

    const unclassified = [...registered].filter(
      (n) => !EXPECT_READ_ONLY.has(n) && !EXPECT_SIDE_EFFECT.has(n),
    );
    out.push(
      assert(
        "★등록된 도구가 전부 분류표에 있다(새 도구가 조용히 빠지지 않는다)",
        unclassified.length === 0,
        unclassified.length === 0
          ? `등록 ${registered.size}개 전부 분류됨`
          : `★분류표에 없는 도구 ${unclassified.length}개: ${unclassified.join(" ")} — 읽기전용/부작용을 결정해 표에 넣어라`,
      ),
    );
    const wrong = [...registered]
      .map((n) => {
        const ro = isReadOnlyTool(n);
        if (EXPECT_READ_ONLY.has(n) && !ro) return `읽기전용→부작용:${n}(폴백 상실)`;
        if (EXPECT_SIDE_EFFECT.has(n) && ro) return `부작용→읽기전용:${n}(중복 실행)`;
        return "";
      })
      .filter((s) => s !== "");
    out.push(
      assert(
        `★등록 도구 ${registered.size}개가 프로덕션 판정으로 옳게 갈린다`,
        wrong.length === 0,
        wrong.length === 0
          ? `읽기전용 ${[...registered].filter(isReadOnlyTool).length} / 부작용 ${[...registered].filter((n) => !isReadOnlyTool(n)).length}`
          : wrong.join(" "),
      ),
    );
    // 모르는 도구는 안전한 쪽(부작용) — 외부 플러그인·신규 능력이 조용히 무해로 새지 않는다.
    out.push(
      assert(
        "미지의 도구는 부작용으로 간주한다(보수적 기본값)",
        !isReadOnlyTool("unknown_future_tool") && !isReadOnlyTool("frobnicate"),
        "미지 2종 → 부작용",
      ),
    );
    // ★접미 규약의 안전 가드 — 지금 레지스트리엔 이 형상이 **없어서** 위 전수 대조로는
    //  이 가드가 지워져도 초록이다(실측: 변이 M2 가 통과했다). 합성 이름으로 직접 건다.
    //  방향이 중요하다: 읽기전용을 부작용으로 오판하면 폴백을 잃을 뿐이지만, 그 반대는
    //  폴백이 **부작용을 중복 실행**한다. 비싼 쪽을 막는 가드다.
    const hazards = ["update_status", "delete_list", "set_info", "remove_capabilities"];
    const leaked = hazards.filter((n) => isReadOnlyTool(n));
    out.push(
      assert(
        "★변형 동사로 시작하면 읽기 접미사여도 부작용이다(중복 실행 차단)",
        leaked.length === 0,
        leaked.length === 0
          ? `위험 형상 ${hazards.length}종 전부 부작용 · 대조군 project_status=${isReadOnlyTool("project_status") ? "읽기전용(정상)" : "부작용(과잉)"}`
          : `★읽기전용으로 샘: ${leaked.join(" ")}`,
      ),
    );

    // ★③ 취소는 부작용과 무관하게 rethrow — **동작으로** 본다.
    //  (2026-07-31: 여기 있던 정규식은 "동일성 판정 코드가 소스에 있다" 만 봤다. 그 코드는
    //   멀쩡히 있는 채로 상류(`:1557`)가 IdleTimeoutError 를 던져 판정을 비껴갔고, 정규식은
    //   그대로 통과시켰다. 코드의 존재가 아니라 취소가 실제로 올라오는지를 본다.)
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "_codex-cancel-child.ts");
    const drive = async (mode: "read" | "stall"): Promise<string> =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, ["--import", "tsx", child, mode], {
          stdio: ["ignore", "pipe", "ignore"],
          env: process.env,
        });
        let buf = "";
        p.stdout.on("data", (d: Buffer) => (buf += d.toString()));
        p.on("close", () => resolve(buf));
        p.on("error", () => resolve(""));
      });
    const parse = (raw: string): { outcome?: string; identical?: boolean; name?: string } => {
      const line = raw.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "";
      try {
        return JSON.parse(line) as { outcome?: string; identical?: boolean; name?: string };
      } catch {
        return {};
      }
    };
    // 대조군 먼저 — 이 경로는 원래도 전파됐다. 여기가 빨간불이면 하네스가 고장난 것이지
    //  회귀가 아니다(둘을 구분 못 하면 검사가 거짓말을 한다).
    const readR = await within(60_000, "취소 e2e(SSE 읽는 중)", drive("read"));
    const readJ = "value" in readR ? parse(readR.value) : {};
    out.push(
      assert(
        "대조군 — SSE 읽는 중 취소는 그대로 올라온다",
        readJ.outcome === "threw" && readJ.identical === true,
        `outcome=${String(readJ.outcome)} 동일성=${String(readJ.identical)} name=${String(readJ.name)}`,
      ),
    );
    const stallR = await within(60_000, "취소 e2e(스톨 백오프 중)", drive("stall"));
    const stallJ = "value" in stallR ? parse(stallR.value) : {};
    out.push(
      assert(
        "★스톨 백오프 중 취소도 삼키지 않는다(워커 타임아웃이 '완료' 로 보고되던 것)",
        stallJ.outcome === "threw" && stallJ.identical === true,
        stallJ.outcome === "returned"
          ? "★정상 반환 = 취소가 삼켜졌다(가짜 답장 + 성공 적재)"
          : `outcome=${String(stallJ.outcome)} 동일성=${String(stallJ.identical)} name=${String(stallJ.name)}`,
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
