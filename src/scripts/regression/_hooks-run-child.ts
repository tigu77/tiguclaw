/**
 * `hooks-actually-run` 의 자식 프로세스 — **훅을 진짜 셸 스크립트로 돌린다**.
 *
 * ★자식으로 도는 이유 둘:
 *  ①`getPaths()` 가 홈을 프로세스당 한 번 동결한다 — 격리 홈을 못 만든다.
 *  ②더 중요한 것: 격리 안 하면 **사용자의 진짜 훅이 검사 중에 실행된다.** 훅은 임의 셸
 *   명령이라 그건 검사가 아니라 사고다.
 *
 * 결과를 마지막 줄 JSON 으로 낸다. 부모가 그것만 읽는다.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const home = process.env.TIGUCLAW_HOME ?? "";
const cwd = path.join(home, "work");
const marks = path.join(home, "marks");
mkdirSync(cwd, { recursive: true });
mkdirSync(marks, { recursive: true });

/** 훅이 실제로 돌았다는 **부작용** — 파일이 생겼나로 본다(반환값만 보면 안 돈 것도 통과한다). */
const mark = (n: string): string => path.join(marks, n);
const fired = (n: string): boolean => existsSync(mark(n));

// ── 홈 settings.json — 다섯 이벤트 전부 + matcher·차단·주입·실패·행 케이스 ──────────
writeFileSync(
  path.join(home, "settings.json"),
  JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          // ①matcher 가 맞는 것만 돈다 — Bash 에만 걸고 Read 로는 안 돌아야 한다.
          {
            matcher: "^Bash$",
            hooks: [{ type: "command", command: `touch '${mark("pre-bash")}'` }],
          },
          // ②차단 — exit 2 + stderr 가 사유가 된다.
          {
            matcher: "^Danger$",
            hooks: [
              {
                type: "command",
                command: `echo '이 도구는 정책상 금지입니다' >&2; exit 2`,
              },
            ],
          },
          // ③훅이 죽어도(exit 1) 턴은 살아야 한다 — 차단이 아니다.
          {
            matcher: "^Flaky$",
            hooks: [
              { type: "command", command: `touch '${mark("flaky")}'; exit 1` },
            ],
          },
          // ④★손자가 파이프를 물고 남는 경우 — spawn timeout 은 sh 만 죽인다.
          //  백스톱이 없으면 이 promise 가 영영 안 풀려 **그 턴이 조용히 멈춘다**.
          {
            matcher: "^Hang$",
            hooks: [
              { type: "command", command: `sleep 8 &`, timeout: 1 },
            ],
          },
          // ⑤★stdin 을 안 읽고 **즉시 끝나는** 훅 — 파이프가 닫힌 뒤 우리가 쓰게 되고
          //  `EPIPE` 가 비동기 'error' 이벤트로 온다. 리스너가 없으면 Node 가 프로세스를
          //  죽인다(= 훅 하나가 데몬을 내린다). 2026-08-19 CI 리눅스가 실제로 이걸로 죽었다.
          //  ★macOS 에선 재현이 안 된다(파이프 타이밍) — 이 케이스의 진짜 채점은 CI 다.
          {
            matcher: "^FastExit$",
            hooks: [{ type: "command", command: `exit 0` }],
          },
        ],
        PostToolUse: [
          { hooks: [{ type: "command", command: `touch '${mark("post")}'` }] },
        ],
        // ⑤stdout 이 모델 컨텍스트로 주입되는 경로(UserPromptSubmit 만 반환에 실린다).
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `touch '${mark("ups")}'; echo '주입된-컨텍스트-표식'`,
              },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: `touch '${mark("stop")}'` }] }],
        SubagentStop: [
          { hooks: [{ type: "command", command: `touch '${mark("subagent")}'` }] },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);

const H = await import("../../core/entry/hook-runner.js");
const out: Record<string, unknown> = {};
const base = { cwd, channel: "regr", threadKey: "regr:hooks" };

// ── ① matcher — 맞으면 돌고 안 맞으면 안 돈다 ─────────────────────────────────
{
  await H.runPreToolUseHooks({ toolName: "Read", toolInput: {}, ...base });
  out.matcherSkippedWrongTool = !fired("pre-bash");
  const r = await H.runPreToolUseHooks({ toolName: "Bash", toolInput: { a: 1 }, ...base });
  out.matcherFiredRightTool = fired("pre-bash");
  out.matcherNoFalseBlock = r.block === false;
}

// ── ② ★차단이 실제로 막는다 — 이 도구의 존재 이유 ────────────────────────────
//  안 먹으면 사용자는 막은 줄 아는데 도구가 돈다. 조용하고, 되돌릴 수 없다.
{
  const r = await H.runPreToolUseHooks({ toolName: "Danger", toolInput: {}, ...base });
  out.denyBlocks = r.block === true;
  out.denyReasonFromStderr = (r.blockReason ?? "").includes("정책상 금지");
  // 모델이 보는 문장 — 3어댑터가 이 함수 하나만 쓴다(계약 §2).
  const msg = H.formatToolBlock("Danger", r.blockReason);
  out.blockMessageHasReason = msg.includes("정책상 금지") && msg.includes("Danger");
}

// ── ③ 훅이 죽어도 턴은 산다(exit 1 ≠ 차단) ───────────────────────────────────
{
  const r = await H.runPreToolUseHooks({ toolName: "Flaky", toolInput: {}, ...base });
  out.failingHookRan = fired("flaky");
  out.failingHookDoesNotBlock = r.block === false;
}

// ── ④ ★손자가 파이프를 물어도 **턴이 안 멈춘다**(2026-07-28 백스톱) ──────────
//  timeout 1s + 여유 5s → 6초 안에 풀려야 한다. 안 풀리면 그 턴은 영영 멈춘다.
{
  const t0 = Date.now();
  const r = await H.runPreToolUseHooks({ toolName: "Hang", toolInput: {}, ...base });
  const ms = Date.now() - t0;
  out.hangResolvedMs = ms;
  out.hangResolved = ms < 7_500; // 손자(8초)가 끝나기 전에 풀렸나 = 백스톱이 풀어준 것
  out.hangDoesNotBlock = r.block === false;
}

// ── ④-2 ★즉시 끝나는 훅에 stdin 을 쓰다 EPIPE — **데몬이 죽으면 안 된다** ────
//  훅에 넘기는 stdin 은 이벤트 JSON 이라 toolInput 이 크면 같이 커진다. 파이프가 이미
//  닫혔으면 그 쓰기가 비동기 'error'(EPIPE)로 돌아오고, 리스너가 없으면 Node 가
//  **프로세스를 죽인다**. 여기까지 왔다는 것 자체가 살아남았다는 증거다.
{
  const r = await H.runPreToolUseHooks({
    toolName: "FastExit",
    toolInput: { blob: "x".repeat(300_000) },
    ...base,
  });
  out.fastExitSurvived = true;
  out.fastExitDoesNotBlock = r.block === false;
}

// ── ⑤ stdout 이 컨텍스트로 주입된다 ──────────────────────────────────────────
{
  const r = await H.runUserPromptSubmitHooks({ prompt: "안녕", cwd, channel: "regr", threadKey: "regr:hooks" });
  out.upsFired = fired("ups");
  out.upsInjected = (r as { additionalContext?: string }).additionalContext?.includes("주입된-컨텍스트-표식") === true;
}

// ── ⑥ 다섯 이벤트 전부 **실행 경로가 있다** ──────────────────────────────────
//  종전 검사는 "내보낸 훅 함수가 소스 어딘가에서 호출되나" 를 grep 으로 봤다. 그건
//  배선이지 동작이 아니다 — 여기서는 다섯을 다 불러 부작용을 확인한다.
{
  await H.runPostToolUseHooks({
    toolName: "mcp__file-ops__Bash",
    toolInput: {},
    toolResponse: "ok",
    ...base,
  });
  out.postFired = fired("post");
  await H.runStopHooks({ response: "턴 답변", cwd, channel: "regr", threadKey: "regr:hooks" });
  out.stopFired = fired("stop");
  await H.runSubagentStopHooks({
    jobId: "j1",
    agentName: "a",
    threadKey: "regr:hooks",
    cwd,
    channel: "regr",
    status: "done",
    summary: "s",
  });
  out.subagentFired = fired("subagent");
}

// ── ⑦ MCP 도구 이름이 정규화돼 matcher 에 걸린다 ─────────────────────────────
//  사용자는 `Bash` 라고 적지 `mcp__file-ops__Bash` 라고 적지 않는다. 정규화가 없으면
//  우리 도구엔 훅이 **하나도 안 걸린다**(설정은 있는데 아무 일도 안 일어남).
{
  out.normalizesMcpName = H.normalizeToolName("mcp__file-ops__Bash") === "Bash";
  out.leavesPlainName = H.normalizeToolName("Bash") === "Bash";
  // 실제 경로로도 확인 — 위 PostToolUse 는 mcp__ 이름으로 불렀고 matcher 없이 돌았으니,
  // 정규화가 matcher 매칭에 쓰이는지는 PreToolUse 로 본다.
  const r = await H.runPreToolUseHooks({
    toolName: "mcp__file-ops__Danger",
    toolInput: {},
    ...base,
  });
  out.mcpNameMatchesMatcher = r.block === true;
}

// ── ⑧ 훅이 0개면 아무 일도 없다(오버헤드 0 · 오탐 0) ─────────────────────────
{
  const empty = path.join(home, "empty");
  mkdirSync(empty, { recursive: true });
  const r = await H.runPreToolUseHooks({
    toolName: "Nothing",
    toolInput: {},
    cwd: empty,
    channel: "regr",
    threadKey: "regr:hooks",
  });
  out.noHookNoBlock = r.block === false;
}

// ── ⑨ 프로젝트 층 훅이 **더해진다**(홈 override 가 아니라 concat) ────────────
{
  const proj = path.join(home, "proj");
  mkdirSync(path.join(proj, ".tiguclaw"), { recursive: true });
  writeFileSync(
    path.join(proj, ".tiguclaw", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "^Bash$",
            hooks: [{ type: "command", command: `touch '${mark("proj-bash")}'` }],
          },
        ],
      },
    }),
    "utf8",
  );
  // ★홈 훅 표식을 **지우고** 돌린다 — 안 지우면 ①에서 만든 파일이 남아 있어 "홈 훅도
  //  돌았다" 가 무조건 참이 된다(아무것도 안 재는 가짜 판정). 지운 뒤 둘 다 생겨야 concat 이다.
  rmSync(mark("pre-bash"), { force: true });
  await H.runPreToolUseHooks({
    toolName: "Bash",
    toolInput: {},
    cwd: proj,
    channel: "regr",
    threadKey: "regr:hooks",
  });
  out.projectHookFired = fired("proj-bash");
  out.homeHookStillFires = fired("pre-bash");
}

process.stdout.write(`\n${JSON.stringify(out)}\n`);
