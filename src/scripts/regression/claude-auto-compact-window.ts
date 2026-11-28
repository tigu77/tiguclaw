/**
 * 회귀: **Claude 자동 압축 창은 적은 모델에만, 같은 `settings` 객체로 넘어간다** (2026-11-28 정태님 «설정으로 빼서
 *  기본값은 꺼두고 테스트 가능하게»).
 *
 * 계약(설계 docs/decisions/2026-11-28-claude-compaction-window-design.md §4):
 *  - `models.limits.<provider:model>.autoCompactWindow`(정수 100,000~1,000,000) 가 있을 때만 SDK
 *    `options.settings.autoCompactWindow` 로 싣는다. 없으면 `settings` 에 키가 없다(현행 옵션 그대로 — 압축을 끄는 게 아니다).
 *  - 층: 홈 → 프로젝트 `.tiguclaw` → 레거시, 필드 단위로 뒤가 이긴다 · `null` = 해제 · 잘못된 값 = 그 층 무시 + 경고 한 번.
 *  - 키는 풀 표기 그대로 — 다른 모델·`[1m]` 표기·모델 미지정엔 안 걸린다.
 *  - «빠름»(`fastMode`)과 한 객체로 합친다 · `settingSources` 는 넘기지 않는다 · `maxInputChars` 로더는 이 필드를 안 본다.
 *  - 새 세션·resume·resume 실패 뒤 새 세션 모두 같은 값.
 * 등급: **실행** — 실제 설정 파일(임시 홈·임시 프로젝트) → 실제 로더 → 실제 `runClaude` → 가짜 SDK 가 받은 옵션. 모델 호출 0.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type Opts = Record<string, unknown>;

export const check: RegressionCheck = {
  name: "claude-auto-compact-window",
  guards:
    "Claude 자동 압축 창 설정이 안 적은 모델·표기에 번지거나, 적어도 SDK 에 안 실리거나, «빠름» 과 서로 덮거나, " +
    "해제·오입력이 조용히 다른 값이 되거나, 입력 상한(maxInputChars)·파일 설정 격리를 건드리는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { getPaths } = await import("../../core/paths.js");
    const { loadModelAutoCompactWindows, loadModelInputLimits } = await import("../../core/settings.js");
    const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
    const { initStore, saveSession } = await import("../../store/sessions.js");
    initStore();

    const homeFile = getPaths().settings;
    const homeBefore = existsSync(homeFile) ? readFileSync(homeFile, "utf8") : undefined;
    const proj = mkdtempSync(path.join(tmpdir(), "tiguclaw-acw-"));
    const projFile = path.join(proj, ".tiguclaw", "settings.json");
    const legacyFile = path.join(proj, "settings.json");
    mkdirSync(path.dirname(projFile), { recursive: true });
    const writeLimits = (file: string, limits: Record<string, unknown> | undefined): void => {
      if (limits === undefined) {
        if (existsSync(file)) unlinkSync(file);
        return;
      }
      writeFileSync(file, JSON.stringify({ models: { limits } }));
    };

    // 가짜 SDK — 받은 옵션을 모으고, `resume` 이 있고 failResume 이면 «세션 없음» 으로 죽는다(resume 폴백 경로).
    const seen: Opts[] = [];
    let failResume = false;
    /** resume 실패를 내기 **직전**에 한 번 부른다 — «진행 중인 턴에 설정을 바꿨다» 를 흉내 낸다. */
    let beforeResumeFail: (() => void) | undefined;
    const fake = ((args: { prompt: unknown; options?: Opts }) => {
      const o = args.options ?? {};
      seen.push(o);
      const it = typeof args.prompt === "string" ? undefined : (args.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      return (async function* () {
        if (it !== undefined) await it.next();
        if (failResume && o.resume !== undefined) {
          beforeResumeFail?.();
          beforeResumeFail = undefined;
          throw new Error("claude-agent-sdk error: process exited with code 1");
        }
        yield { type: "system", subtype: "init", session_id: "sess-acw", model: "claude-opus-5-5" };
        yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, session_id: "sess-acw", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    }) as never;

    const warns: string[] = [];
    const logs: string[] = [];
    const prevWarn = console.warn;
    const prevLog = console.log;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "regression-fake-key";
    const stamp = Date.now();
    let n = 0;
    /** 한 턴을 돌리고 그 턴이 SDK 에 넘긴 옵션들(재시도 포함)을 돌려준다. */
    /** 직전 `turn()` 한 번 동안 찍힌 적용 로그 줄. */
    let turnLogs: string[] = [];
    /** **모든 턴**의 로그 불변식 위반 — 그 턴 첫 SDK 호출에 창이 실렸으면 그 값·키 로그 정확히 1줄, 아니면 0줄(재시도는 턴 하나로 센다). */
    const logViolations: string[] = [];
    let turnsChecked = 0;
    const turn = async (input: Record<string, unknown>, threadKey?: string): Promise<Opts[]> => {
      const from = seen.length;
      const logFrom = logs.length;
      const tk = threadKey ?? `regr:acw:${stamp}:${(n += 1)}`;
      const r = (await runClaude({ text: "q", threadKey: tk, channel: "cli", cwd: proj, ...input } as never)) as {
        sessionId?: string; model?: string | null; systemPromptHash?: string;
      };
      // resume 은 facade(`runRegionA`)가 저장한 세션으로 열린다 — 같은 저장을 여기서 한다(llm-runtime/index.ts saveSession 호출과 같은 값).
      if (r.sessionId !== undefined) {
        saveSession({ channel: "cli", threadKey: tk, claudeSessionId: r.sessionId, model: r.model ?? null, systemPromptHash: r.systemPromptHash ?? null });
      }
      turnLogs = logs.slice(logFrom).filter((l) => l.includes("autoCompactWindow="));
      const sent = (seen[from]?.settings as { autoCompactWindow?: number } | undefined)?.autoCompactWindow;
      const key = `${String(input.provider ?? "anthropic")}:${String(input.model)}`;
      const ok = sent === undefined
        ? turnLogs.length === 0
        : turnLogs.length === 1 && turnLogs[0] === `[claude] autoCompactWindow=${sent} (models.limits.${key}) thread=${tk}`; // 줄 전체 일치(다른 스레드 키 접미 차단)
      turnsChecked += 1;
      if (!ok) logViolations.push(`${tk}: sent=${String(sent)} logs=${turnLogs.length}`);
      return seen.slice(from);
    };
    const settingsOf = (o: Opts | undefined): string => (o === undefined ? "<호출 없음>" : "settings" in o ? JSON.stringify(o.settings) : "<없음>");
    const OPUS = "anthropic:claude-opus-5-5";
    let runErr = "";
    try {
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
      console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
      await withFakeClaudeQuery(fake, async () => {
        // ① 미지정 — 어떤 층에도 없으면 `settings` 키 자체가 없다(현행 옵션) · 파일 설정 로딩은 계속 꺼져 있다.
        writeLimits(homeFile, undefined);
        writeLimits(projFile, undefined);
        const none = await turn({ model: "claude-opus-5-5" });
        const noneLogged = turnLogs.length > 0;
        out.push(assert(
          "★미지정이면 SDK 옵션에 `settings` 가 없다(압축 창 override 0 = 기존 동작) · `settingSources` 도 없다 · 적용 로그 없음",
          none.length === 1 && !("settings" in none[0]!) && !("settingSources" in none[0]!) && !noneLogged,
          `calls=${none.length} settings=${settingsOf(none[0])} settingSources=${String(none[0] !== undefined && "settingSources" in none[0])} logged=${String(noneLogged)}`,
        ));

        // ② 켜기 — 홈에 적은 모델에만 그 값. 같은 객체에 «빠름» 이 같이 실린다. 입력 상한 로더는 그대로.
        writeLimits(homeFile, { [OPUS]: { autoCompactWindow: 400_000, maxInputChars: 123_456 }, "anthropic:claude-sonnet-5": { maxInputChars: 7 } });
        const on = await turn({ model: "claude-opus-5-5" });
        const onLogs = turnLogs;
        const onFast = await turn({ model: "claude-opus-5-5", speed: "fast" });
        const onFastLogs = turnLogs;
        const oneLine = (ls: string[], v: number, key: string): boolean =>
          ls.length === 1 && ls[0]!.includes(`autoCompactWindow=${v} (models.limits.${key})`);
        const limits = loadModelInputLimits();
        out.push(assert(
          "★★켜기: 적은 모델의 턴은 `settings.autoCompactWindow` 를 그 값으로 싣는다 · 적용 로그는 **그 턴에 정확히 한 줄**(실은 값·키)",
          JSON.stringify(on[0]?.settings) === JSON.stringify({ autoCompactWindow: 400_000 }) &&
            oneLine(onLogs, 400_000, OPUS) && oneLine(onFastLogs, 400_000, OPUS) &&
            !("settingSources" in (on[0] ?? {})),
          `settings=${settingsOf(on[0])} logs=${onLogs.length}/${onFastLogs.length} ${onLogs[0] ?? "<없음>"}`,
        ));
        out.push(assert(
          "★★«빠름» 과 같은 `settings` 객체에 합쳐진다 — 한쪽이 다른 쪽을 덮지 않는다",
          JSON.stringify(onFast[0]?.settings) === JSON.stringify({ fastMode: true, autoCompactWindow: 400_000 }),
          `settings=${settingsOf(onFast[0])}`,
        ));
        out.push(assert(
          "★입력 상한(`maxInputChars`) 로더는 그대로 — 압축 창 필드를 읽지 않고, 압축 창만 적은 모델은 상한 맵에 생기지 않는다",
          limits.get(OPUS) === 123_456 && limits.get("anthropic:claude-sonnet-5") === 7 && limits.size === 2,
          JSON.stringify([...limits]),
        ));

        // ③ 명시하지 않은 대상 — 다른 모델 · `[1m]` 표기 · 모델 미지정 · 같은 모델 다른 provider 이름.
        let unappliedLogs = 0;
        const other = await turn({ model: "claude-sonnet-5" });
        unappliedLogs += turnLogs.length;
        const oneM = await turn({ model: "claude-opus-5-5[1m]" });
        unappliedLogs += turnLogs.length;
        const noModel = await turn({});
        unappliedLogs += turnLogs.length;
        const otherProv = await turn({ model: "claude-opus-5-5", provider: "my-claude" });
        unappliedLogs += turnLogs.length;
        out.push(assert(
          "★★적은 키와 표기가 다르면 안 걸린다 — 다른 모델·`[1m]`·모델 미지정·다른 provider 이름(별칭 정규화 없음)",
          [other, oneM, noModel, otherProv].every((c) => c.length === 1 && !("settings" in c[0]!)) &&
            unappliedLogs === 0,
          `sonnet=${settingsOf(other[0])} [1m]=${settingsOf(oneM[0])} 미지정=${settingsOf(noModel[0])} my-claude=${settingsOf(otherProv[0])}`,
        ));
        // ③-b 반대 방향 — 그 표기를 **정확히** 적으면 걸린다: 다른 provider 에만 · `[1m]` 표기 · 별칭 표기. provider 까지 비교한다.
        writeLimits(homeFile, {
          "my-claude:claude-opus-5-5": { autoCompactWindow: 500_000 },
          "anthropic:claude-opus-5-5[1m]": { autoCompactWindow: 600_000 },
          "anthropic:opus": { autoCompactWindow: 700_000 },
        });
        const provOnly = await turn({ model: "claude-opus-5-5", provider: "my-claude" });
        const provOnlyLogs = turnLogs;
        const provBase = await turn({ model: "claude-opus-5-5" });
        const provBaseLogs = turnLogs;
        const oneMExact = await turn({ model: "claude-opus-5-5[1m]" });
        const aliasExact = await turn({ model: "opus" });
        out.push(assert(
          "★★정확히 적은 표기에만 걸린다 — 다른 provider 이름에만 적으면 그 provider 만 · `[1m]`·별칭도 그 표기 그대로 적으면 적용",
          JSON.stringify(provOnly[0]?.settings) === JSON.stringify({ autoCompactWindow: 500_000 }) &&
            provBase.length === 1 && !("settings" in provBase[0]!) &&
            oneLine(provOnlyLogs, 500_000, "my-claude:claude-opus-5-5") && provBaseLogs.length === 0 &&
            JSON.stringify(oneMExact[0]?.settings) === JSON.stringify({ autoCompactWindow: 600_000 }) &&
            JSON.stringify(aliasExact[0]?.settings) === JSON.stringify({ autoCompactWindow: 700_000 }),
          `my-claude=${settingsOf(provOnly[0])} anthropic=${settingsOf(provBase[0])} [1m]=${settingsOf(oneMExact[0])} opus=${settingsOf(aliasExact[0])}`,
        ));
        writeLimits(homeFile, { [OPUS]: { autoCompactWindow: 400_000, maxInputChars: 123_456 } });

        // ④ 새 세션 → resume → resume 실패 뒤 새 세션 — 셋 다 같은 값.
        const tk = `regr:acw:${stamp}:resume`;
        const first = await turn({ model: "claude-opus-5-5" }, tk);
        const resumed = await turn({ model: "claude-opus-5-5" }, tk);
        failResume = true;
        // 턴 진행 중(첫 SDK 호출 뒤·재시도 전)에 설정이 바뀐다 → 같은 턴 재시도는 **옛 값**, 같은 스레드 다음 턴은 **새 값**.
        beforeResumeFail = () => writeLimits(homeFile, { [OPUS]: { autoCompactWindow: 250_000, maxInputChars: 123_456 } });
        const fallback = await turn({ model: "claude-opus-5-5", speed: "fast" }, tk);
        const fallbackLogs = turnLogs;
        failResume = false;
        const nextTurn = await turn({ model: "claude-opus-5-5" }, tk);
        writeLimits(homeFile, { [OPUS]: { autoCompactWindow: 400_000, maxInputChars: 123_456 } });
        const want = JSON.stringify({ autoCompactWindow: 400_000 });
        const wantFast = JSON.stringify({ fastMode: true, autoCompactWindow: 400_000 });
        out.push(assert(
          "★★새 세션·resume·resume 실패 뒤 **같은 턴의 두 번째 호출**(새 세션) 모두 같은 압축 창 — 재시도는 resume 만 빼고 «빠름»·창을 보존, `settingSources` 없음",
          first.length === 1 && first[0]!.resume === undefined && JSON.stringify(first[0]!.settings) === want &&
            resumed.length === 1 && resumed[0]!.resume === "sess-acw" && JSON.stringify(resumed[0]!.settings) === want &&
            fallback.length === 2 && fallback[0]!.resume === "sess-acw" && fallback[1]!.resume === undefined &&
            JSON.stringify(fallback[0]!.settings) === wantFast && JSON.stringify(fallback[1]!.settings) === wantFast &&
            fallback.every((o) => !("settingSources" in o)) && oneLine(fallbackLogs, 400_000, OPUS),
          `first=${settingsOf(first[0])}/${String(first[0]?.resume)} resumed=${settingsOf(resumed[0])}/${String(resumed[0]?.resume)} ` +
            `fallback=${fallback.map((o) => `${settingsOf(o)}/${String(o.resume)}`).join(",")} logs=${fallbackLogs.length}`,
        ));
        out.push(assert(
          "★★적용 시점: 진행 중인 턴에 설정을 바꾸면 그 턴의 재시도는 옛 값을 유지하고, 같은 스레드의 **다음 턴**이 새 값을 싣는다(턴 시작에 한 번 읽는다)",
          fallback.length === 2 && JSON.stringify(fallback[1]!.settings) === wantFast &&
            nextTurn.length === 1 && nextTurn[0]!.resume === "sess-acw" &&
            JSON.stringify(nextTurn[0]!.settings) === JSON.stringify({ autoCompactWindow: 250_000 }),
          `재시도=${settingsOf(fallback[1])} 다음턴=${settingsOf(nextTurn[0])}/${String(nextTurn[0]?.resume)}`,
        ));

        // ⑤ 프로젝트 층 — 필드 없으면 상속 · 값이면 덮음 · null 이면 해제 · 잘못된 값이면 앞 층 유지 + 경고 한 번.
        writeLimits(projFile, { [OPUS]: { maxInputChars: 5 } });
        const inherit = await turn({ model: "claude-opus-5-5" });
        writeLimits(projFile, { [OPUS]: { autoCompactWindow: 300_000 } });
        const override = await turn({ model: "claude-opus-5-5" });
        // 세 층에 서로 다른 유효값 — 맨 뒤(레거시 flat)가 이긴다. 그다음 레거시를 지우면 프로젝트 값으로 돌아온다.
        writeLimits(legacyFile, { [OPUS]: { autoCompactWindow: 200_000 } });
        const legacyWins = await turn({ model: "claude-opus-5-5" });
        writeLimits(legacyFile, undefined);
        writeLimits(projFile, { [OPUS]: { autoCompactWindow: null } });
        const cleared = await turn({ model: "claude-opus-5-5" });
        const clearedLogs = turnLogs.length;
        writeLimits(projFile, { [OPUS]: { autoCompactWindow: 50_000 } });
        warns.length = 0;
        const bad1 = await turn({ model: "claude-opus-5-5" });
        const bad2 = await turn({ model: "claude-opus-5-5" });
        const badWarns = warns.filter((w) => w.includes("autoCompactWindow=50000"));
        out.push(assert(
          "★프로젝트 층: 필드가 없으면 홈 값을 물려받고, 값을 적으면 그 값이 이긴다 · 세 층(홈 4십만·프로젝트 3십만·레거시 2십만)이면 레거시",
          JSON.stringify(inherit[0]?.settings) === JSON.stringify({ autoCompactWindow: 400_000 }) &&
            JSON.stringify(override[0]?.settings) === JSON.stringify({ autoCompactWindow: 300_000 }) &&
            JSON.stringify(legacyWins[0]?.settings) === JSON.stringify({ autoCompactWindow: 200_000 }),
          `상속=${settingsOf(inherit[0])} 덮음=${settingsOf(override[0])} 세층=${settingsOf(legacyWins[0])}`,
        ));
        out.push(assert(
          "★★`null` = 해제 — 홈에 켜 둔 값을 그 프로젝트에서 지워 `settings` 가 없다(SDK 기본)",
          cleared.length === 1 && !("settings" in cleared[0]!) && clearedLogs === 0,
          `해제=${settingsOf(cleared[0])} logs=${clearedLogs}`,
        ));
        out.push(assert(
          "★★잘못된 값은 해제가 아니다 — 앞 층(홈) 값이 남고 경고는 같은 값에 한 번만(매 턴 소음 금지)",
          JSON.stringify(bad1[0]?.settings) === JSON.stringify({ autoCompactWindow: 400_000 }) &&
            JSON.stringify(bad2[0]?.settings) === JSON.stringify({ autoCompactWindow: 400_000 }) && badWarns.length === 1,
          `bad1=${settingsOf(bad1[0])} bad2=${settingsOf(bad2[0])} warns=${badWarns.length}`,
        ));

        // ⑥ 끄기(되돌리기) — 홈에서 키를 지우면 다음 턴부터 `settings` 가 없다.
        writeLimits(projFile, undefined);
        writeLimits(homeFile, { [OPUS]: { maxInputChars: 123_456 } });
        const off = await turn({ model: "claude-opus-5-5" });
        const offLogs = turnLogs.length;
        out.push(assert(
          "★★되돌리기: 설정에서 `autoCompactWindow` 를 지우면 다음 턴부터 SDK 옵션에 `settings` 가 없다(재시작 불필요)",
          off.length === 1 && !("settings" in off[0]!) && offLogs === 0,
          `off=${settingsOf(off[0])} logs=${offLogs}`,
        ));
      });
    } catch (e) {
      runErr = String(e).slice(0, 300);
    } finally {
      console.warn = prevWarn;
      console.log = prevLog;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      if (homeBefore === undefined) { if (existsSync(homeFile)) unlinkSync(homeFile); } else writeFileSync(homeFile, homeBefore);
    }
    out.push(assert("가짜 SDK 실행이 예외 없이 끝났다", runErr === "", runErr || "ok"));
    out.push(assert(
      "★★모든 턴(새 세션·resume·재시도 턴·불일치·해제 포함): 실제로 실은 창이 있으면 그 값·키·스레드의 적용 로그 정확히 1줄, 없으면 0줄",
      turnsChecked >= 20 && logViolations.length === 0,
      `턴 ${turnsChecked}개 · 위반 ${logViolations.length}${logViolations.length > 0 ? ` — ${logViolations.slice(0, 4).join(" · ")}` : ""}`,
    ));

    // ⑧ 라우터 경계 — 압축 창은 모델을 건너뛰는 근거가 아니다(입력 상한과 다른 계약). 실제 `runRegionA` 의 용량 선별을 태운다.
    //  입력 15만 자 > 창 숫자 10만: 창만 적은 첫 후보는 그대로 불리고, 같은 숫자를 `maxInputChars` 로 적은 대조군에서만 다음 후보로 간다.
    {
      const { __setAdapterForTest, runRegionA } = await import("../../core/llm-runtime/index.js");
      const called: string[] = [];
      const restore = __setAdapterForTest(async (_a, input) => {
        called.push(String(input.model));
        return { text: "ok", model: input.model ?? null } as never;
      });
      const pool = { specs: [
        { adapter: "claude" as const, model: "claude-opus-5-5", provider: "anthropic" },
        { adapter: "claude" as const, model: "claude-sonnet-5", provider: "anthropic" },
      ] };
      const big = "x".repeat(150_000);
      let routeErr = "";
      const firsts: string[] = [];
      try {
        console.warn = () => {};
        writeFileSync(homeFile, JSON.stringify({ models: { limits: { [OPUS]: { autoCompactWindow: 100_000 } } } }));
        called.length = 0;
        await runRegionA({ text: big, threadKey: `regr:acw:${stamp}:route1`, channel: "cli" } as never, pool as never);
        firsts.push(called[0] ?? "<없음>");
        writeFileSync(homeFile, JSON.stringify({ models: { limits: { [OPUS]: { autoCompactWindow: 100_000, maxInputChars: 100_000 } } } }));
        called.length = 0;
        await runRegionA({ text: big, threadKey: `regr:acw:${stamp}:route2`, channel: "cli" } as never, pool as never);
        firsts.push(called[0] ?? "<없음>");
      } catch (e) {
        routeErr = String(e).slice(0, 200);
      } finally {
        restore();
        console.warn = prevWarn;
        if (homeBefore === undefined) { if (existsSync(homeFile)) unlinkSync(homeFile); } else writeFileSync(homeFile, homeBefore);
      }
      out.push(assert(
        "★★압축 창은 용량 선별에 안 쓰인다 — 입력이 창 숫자보다 커도 첫 후보가 불리고, 같은 숫자를 `maxInputChars` 로 적었을 때만 다음 후보로 간다",
        routeErr === "" && firsts[0] === "claude-opus-5-5" && firsts[1] === "claude-sonnet-5",
        routeErr || `창만=${firsts[0]} 상한=${firsts[1]}`,
      ));
    }

    // ⑦ 로더 경계값 — 정수 100,000~1,000,000 만 · 그 밖은 무시(경계 포함/제외를 한 번에 본다).
    try {
      writeLimits(projFile, {
        "a:min": { autoCompactWindow: 100_000 },
        "a:max": { autoCompactWindow: 1_000_000 },
        "a:below": { autoCompactWindow: 99_999 },
        "a:above": { autoCompactWindow: 1_000_001 },
        "a:float": { autoCompactWindow: 400_000.5 },
        "a:string": { autoCompactWindow: "400000" },
        "a:auto": { autoCompactWindow: "auto" },
        "a:bool": { autoCompactWindow: true },
      });
      console.warn = () => {};
      const m = loadModelAutoCompactWindows(proj);
      out.push(assert(
        "★유효값은 정수 100,000~1,000,000 만 — 바로 밖·소수·문자열·\"auto\"·불리언은 싣지 않는다(SDK 는 이런 값을 조용히 기본으로 돌린다)",
        m.get("a:min") === 100_000 && m.get("a:max") === 1_000_000 && m.size === 2,
        JSON.stringify([...m]),
      ));
    } finally {
      console.warn = prevWarn;
      rmSync(proj, { recursive: true, force: true });
    }
    return out;
  },
};
