/**
 * 회귀: **재실행 차단이 실제 도구 경로에 연결돼 있고, 차단이 오류 보고를 삼키지 않는다**
 * (2026-09-15 회사 아스트라 검토).
 *
 * ★두 결함이 같이 나왔다.
 *
 *  ① **차단이 후처리보다 앞에 있었다.** 부작용 도구가 돈 뒤 429 를 맞으면 재실행은 막았지만
 *     `registerCooldownIfRateLimited`·한도 안내·`turn_error` 를 **통째로 건너뛰었다.**
 *     사용자는 왜 멈췄는지 못 듣고, 다음 턴은 한도를 모른 채 같은 벽을 또 때린다.
 *  ② **외부 MCP 를 이름으로 판정했다.** codex 만 출처를 봤고 claude·openai 는
 *     `isReadOnlyTool(이름)` 만 봤다. 서드파티가 `get_*` 로 이름 지으면 부작용이 있어도
 *     안전으로 분류돼 **폴백 때 두 번 실행**된다.
 *
 * ★그리고 **왜 기존 그물이 못 잡았나**가 이 검사의 설계다. `replay-stops-after-side-effect`
 *  는 `markToolDispatch` 를 **검사가 직접** 부른다 — 즉 «가드가 맞게 도는가» 만 보고
 *  «실제 도구 경로가 그 가드를 부르는가» 는 안 본다. 배선이 빠져도 초록이다.
 *  여기서는 **세 어댑터의 디스패치 자리**가 공통 판정을 지나는지 함께 본다.
 * ★①은 변이로도 안 나온다 — 가드 자체는 맞게 동작하고 **순서**만 틀렸다. 그래서 이
 *  검사는 «가드가 있나» 가 아니라 «후처리 뒤에 있나» 를 묻는다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const readRel = (rel: string): Promise<string> =>
  readFile(new URL(rel, import.meta.url), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export const check: RegressionCheck = {
  name: "replay-guard-is-wired",
  guards:
    "부작용 뒤 재실행 차단이 쿨다운 등록·한도 안내·turn_error 를 건너뛰던 것 + 외부 MCP 도구를 이름만으로 안전하다고 보고 폴백 때 두 번 실행하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 판정을 **실행**한다 ───────────────────────────────────────────────────
    const { isReplaySafeTool, mcpServerOf } = await import(
      "../../core/llm-runtime/replay-safety.js"
    );
    out.push(
      assert(
        "★외부 MCP 는 이름이 읽기처럼 보여도 **안전이 아니다**(남이 지은 이름이라 추정이 성립 안 한다)",
        isReplaySafeTool({ external: true, readOnlyByName: true }) === false &&
          isReplaySafeTool({ external: false, readOnlyByName: true }) === true &&
          isReplaySafeTool({ external: false, readOnlyByName: false }) === false,
        `외부+읽기이름 → ${String(isReplaySafeTool({ external: true, readOnlyByName: true }))} · 내부+읽기이름 → ${String(isReplaySafeTool({ external: false, readOnlyByName: true }))}`,
      ),
      assert(
        "`mcp__<서버>__<도구>` 에서 서버를 뽑고, 그 모양이 아니면 모른다고 답한다",
        mcpServerOf("mcp__unity__get_scene") === "unity" &&
          // ★서버 이름에 `__` 가 들어가도 맞아야 한다(레드팀 P6·M10) — 3세그먼트만 재면
          //  `parts[1]` 이든 `parts[length-2]` 든 똑같이 통과해 변이가 안 걸린다.
          mcpServerOf("mcp__my__server__tool") === "my__server" &&
          mcpServerOf("Read") === undefined &&
          mcpServerOf("mcp__x") === undefined,
        `unity → ${String(mcpServerOf("mcp__unity__get_scene"))} · my__server → ${String(mcpServerOf("mcp__my__server__tool"))} · Read → ${String(mcpServerOf("Read"))}`,
      ),
    );

    // ── ② 세 어댑터의 디스패치가 **공통 판정**을 지난다 ─────────────────────────
    const adapters = {
      claude: stripComments(
        await readRel("../../core/llm-runtime/adapters/claude-agent-sdk.ts"),
      ),
      openai: stripComments(
        await readRel("../../core/llm-runtime/adapters/openai-agents-sdk.ts"),
      ),
      codex: stripComments(
        await readRel("../../core/llm-runtime/adapters/openai-codex-oauth.ts"),
      ),
    };
    const bare: string[] = [];
    let externalArgs: string[] = [];
    let earlyThrows: string[] = [];
    let willRetryExpr = "(미발견)";
    let wiringDetail = "(미판정)";
    let failGate = "(미발견)";
    for (const [name, src] of Object.entries(adapters)) {
      const at = src.indexOf("markToolDispatch(");
      if (at < 0) {
        bare.push(`${name}:디스패치표시없음`);
        continue;
      }
      const call = src.slice(at, at + 420);
      if (!/isReplaySafeTool\(/.test(call)) bare.push(`${name}:이름만판정`);
    }
    out.push(
      assert(
        "★세 어댑터 **전부**가 디스패치 표시에 공통 판정을 쓴다(한쪽만 이름으로 보면 그 어댑터에서 두 번 실행된다)",
        bare.length === 0,
        bare.length === 0 ? "claude·openai·codex 공통 판정" : `어긴 곳: ${bare.join("·")}`,
      ),
      assert(
        // ★M3·M4: 이 단정의 옛 판은 `isReplaySafeTool(` **호출부만** 읽었다. 그런데 출처가
        //  실제로 정해지는 자리는 거기가 아니다 — openai 는 `wireToolHooks(server, …)` 의
        //  둘째 인자이고, claude 는 `mcpServerOf(...)` 에 **무엇을 넘기느냐**다. 그래서
        //  `(server, false)` 와 `mcpServerOf(normalizedToolName)` 두 변이가 전부 통과했다.
        //  아래에서 **그 자리들**을 직접 본다.
        "★출처가 **실제로 정해지는 자리**가 상수도, 접두사가 벗겨진 이름도 아니다",
        (() => {
          const bad: string[] = [];
          // openai — 래핑 루프가 집합으로 판정하는가(상수 금지)
          const wire = /wireToolHooks\(([^)]*)\)/g;
          const wireArgs = [...adapters.openai.matchAll(wire)]
            .map((m) => m[1]!.trim())
            .filter((a) => a.includes(","));
          if (
            wireArgs.length === 0 ||
            !wireArgs.every((a) => /externalMcpBridges\.has\(/.test(a))
          ) {
            bad.push(`openai 배선=[${wireArgs.join(" | ") || "없음"}]`);
          }
          // claude — 출처 판정에 **원시 이름**을 넘기는가(정규화된 이름이면 항상 undefined)
          const m = /mcpServerOf\(([^)]*)\)/.exec(adapters.claude);
          const arg = (m?.[1] ?? "(없음)").trim();
          if (!/hookInput\.tool_name/.test(arg)) bad.push(`claude 인자=${arg}`);
          // codex — 외부 집합으로 판정하는가
          if (!/external:\s*externalMcpToolNames\.has\(/.test(adapters.codex)) {
            bad.push("codex 집합판정없음");
          }
          wiringDetail = bad.length === 0
            ? `openai=${wireArgs.join("|")} · claude=${arg}`
            : bad.join(" · ");
          return bad.length === 0;
        })(),
        wiringDetail,
      ),
      assert(
        "★각 어댑터가 **출처**를 실제로 넘긴다 — `external:` 인자가 상수가 아니다",
        (() => {
          // ★속기법(`{ external, … }`)과 명시(`external: x`) **둘 다** 받는다 —
          //  한 형태만 읽으면 멀쩡한 코드를 빨갛게 만들고, 그런 검사는 아무도 안 돌린다.
          const arg = (src: string): string => {
            const at = src.indexOf("isReplaySafeTool(");
            if (at < 0) return "(없음)";
            const call = src.slice(at, at + 260);
            const m = /external\s*:\s*([^,\n}]+)/.exec(call);
            if (m !== null) return m[1]!.trim();
            return /\bexternal\s*[,}]/.test(call) ? "external(속기)" : "(없음)";
          };
          externalArgs = Object.entries(adapters).map(([n, src]) => `${n}=${arg(src)}`);
          return Object.values(adapters).every((src) => {
            const v = arg(src);
            return v !== "(없음)" && v !== "true" && v !== "false";
          });
        })(),
        externalArgs.join(" · "),
      ),
    );

    // ── ③ 차단이 **오류 후처리 뒤**에 온다 ─────────────────────────────────────
    const rt = stripComments(await readRel("../../core/llm-runtime/index.ts"));
    // ★리터럴 한 줄이 아니라 **«replayBlocked 로 단락하는 자리»** 를 찾는다 — 블록으로
    //  감싸거나 사유를 붙이는 정상 편집에 검사가 빨개지면 안 된다(오늘만 세 번 겪었다).
    const blockedThrow = /if \(replayBlocked\)\s*\{?[\s\S]{0,400}?throw e;/.exec(rt);
    const iBlocked = blockedThrow === null ? -1 : blockedThrow.index;
    const iCooldown = rt.indexOf("registerCooldownIfRateLimited(");
    const iPublish = rt.indexOf("publishTurnError(");
    out.push(
      assert(
        "★재실행 차단이 **쿨다운 등록·turn_error 발행 뒤**에 온다 — 막는 것과 알리는 것은 다른 일이다",
        iBlocked > 0 && iCooldown > 0 && iPublish > 0 && iBlocked > iCooldown && iBlocked > iPublish,
        `쿨다운 ${iCooldown} · 발행 ${iPublish} · 차단 ${iBlocked}(뒤에 와야 함)`,
      ),
      assert(
        // ★M2c: 정식 단락은 제자리에 두고 **다른 표현으로** 조기 throw 를 하나 더 끼우는
        //  변이가 전체 스위트를 통과했다. «그 줄이 뒤에 있나» 만 보면 «앞에 또 있나» 는
        //  안 보인다. 그래서 **쿨다운 앞 구간에 재실행 관련 throw 가 있는지**를 따로 본다.
        "★쿨다운 등록 **앞** 구간에 재실행 관련 조기 단락이 없다(정식 단락을 두고 표현만 바꿔 되살리는 변이를 막는다)",
        (() => {
          const catchStart = rt.lastIndexOf("} catch (e) {", iCooldown);
          if (catchStart < 0 || iCooldown <= catchStart) return false;
          const head = rt.slice(catchStart, iCooldown);
          earlyThrows = [...head.matchAll(/[^\n]*\b(?:canReplay|replayBlocked|blockedReason)\b[^\n]*throw[^\n]*/g)]
            .map((m) => m[0].trim());
          return earlyThrows.length === 0;
        })(),
        earlyThrows.length === 0 ? "조기 단락 없음" : `조기 단락: ${earlyThrows.join(" / ")}`,
      ),
      assert(
        // ★M8: 느슨한 창(`[\s\S]{0,300}?`)이 **삽입된 `||`** 를 허용해, `(true || …)` 로
        //  감싸는 변이가 세 검사를 동시에 통과했다. 조건은 **`&&` 로만** 이어져야 한다.
        "★차단했으면 «다른 모델로 이어서 시도합니다» 라고 말하지 않는다 + 그 조건이 `||` 로 무력화되지 않는다",
        (() => {
          const at = rt.indexOf("hasFallback,");
          const call = rt.indexOf("publishTurnError(");
          if (call < 0) return false;
          const args = rt.slice(call, call + 600);
          const expr = /specIndex < effectivePool\.length - 1([\s\S]{0,200}?),\s*\n\s*input,/.exec(args);
          if (expr === null) return false;
          const body = expr[1]!;
          willRetryExpr = body.replace(/\s+/g, " ").trim();
          return (
            !/\|\|/.test(body) && // `||` 로 무력화 금지
            /!\(e instanceof TurnTimeoutError\)/.test(body) &&
            /!replayBlocked/.test(body) &&
            at >= 0
          );
        })(),
        `willRetry 조건 = "${willRetryExpr}"`,
      ),
    );

    // ── ④ claude 의 압축 실패도 **끝을 알린다** ────────────────────────────────
    const at = adapters.claude.indexOf('subtype === "status"');
    const statusBlock = at < 0 ? "" : adapters.claude.slice(at, at + 900);
    out.push(
      assert(
        "★claude 압축 실패가 SDK 상태 메시지로 관측돼 끝 신호를 낸다(종전엔 어느 훅도 안 불려 ⏳ 가 남았다)",
        at > 0 &&
          /compact_result === "failed"/.test(statusBlock) &&
          /"llm\.compact_failed"/.test(statusBlock),
        at < 0
          ? "status 메시지를 안 읽는다"
          : `실패 판정 ${/compact_result === "failed"/.test(statusBlock)} · 끝 신호 ${/"llm\.compact_failed"/.test(statusBlock)}`,
      ),
      assert(
        "성공은 여기서 안 낸다 — `PostCompact` 가 이미 낸다(이중 발행 0)",
        !/compact_result === "success"/.test(statusBlock),
        `status 블록에 성공 발행 ${/compact_result === "success"/.test(statusBlock)}`,
      ),
      assert(
        // ★M7c: `&& msg.status === "compacting"` 처럼 **완료 시점엔 절대 참이 아닌** 게이트를
        //  하나 더 얹으면 신호가 통째로 죽는데 900자 창 정규식은 그걸 못 봤다.
        //  판정은 `compact_result` **하나**여야 한다.
        "★실패 판정에 다른 조건을 덧붙이지 않는다(완료 시점엔 거짓인 게이트를 얹으면 신호가 죽는다)",
        (() => {
          const m = /if \(([^)]*compact_result[^)]*)\)/.exec(statusBlock);
          failGate = (m?.[1] ?? "(없음)").trim();
          return m !== null && !/&&|\|\|/.test(m[1]!);
        })(),
        `실패 게이트 = ${failGate}`,
      ),
      assert(
        // ★M7d: 페이로드의 `threadKey` 를 `""` 로 바꾸면 화면이 스레드를 못 찾아 ⏳ 가 안
        //  걷힌다 — 이 기능의 **존재 이유**인데 아무도 페이로드를 안 봤다.
        "★끝 신호가 **이 스레드**를 가리킨다(빈 값이면 화면이 표식을 못 걷는다 = 기능이 죽는다)",
        /threadKey:\s*input\.threadKey/.test(statusBlock) &&
          /adapter:\s*"claude"/.test(statusBlock) &&
          /reason:/.test(statusBlock),
        `페이로드 필드: ${(statusBlock.match(/^\s*(\w+):/gm) ?? []).map((x) => x.trim()).join("·") || "(없음)"}`,
      ),
    );

    return out;
  },
};
