/**
 * claude-auth CLI — **구독 토큰을 대신 받아온다** (2026-08-27 사용자 지적).
 *
 * ★종전엔 사용자에게 **심부름을 시켰다**: *"Claude Code CLI 설치 후 `claude setup-token` 을
 *  실행하고, 출력된 토큰을 복사해 붙여넣으세요."* 세 걸음이고, 첫 걸음은 같은 259MB 를 한 번
 *  더 받는 것이었다 — **실행기는 이미 `npm ci` 로 손안에 있는데도.**
 *
 * ★같은 구독 OAuth 인 codex 는 이미 대신 해준다(`npm run codex-auth`, onboard [2/5]).
 *  한쪽만 심부름인 게 비대칭이었다. 여기서 맞춘다.
 *
 * 흐름:
 *  1. 번들 실행기를 찾는다(`core/claude-cli.ts`) — 없으면 이유와 조치를 말하고 끝낸다.
 *  2. `claude setup-token` 을 **그대로 태운다**. 브라우저 로그인·프롬프트는 전부 그쪽 몫이고
 *     우리는 화면을 가리지 않는다(출력을 그대로 흘려보낸다).
 *  3. 출력에서 토큰을 집어 `<home>/.env` 에 `CLAUDE_CODE_OAUTH_TOKEN` 으로 쓴다.
 *  4. ★못 집으면 **붙여넣기로 빠져나갈 길**을 연다. 토큰 모양은 상류가 정하는 것이라
 *     우리가 단정하면 안 된다 — 형식이 바뀌면 자동 경로가 조용히 죽는다. 그때도 사용자는
 *     막히지 않아야 한다(codex-auth 가 콜백 실패에 수동 경로를 둔 것과 같은 규칙).
 */
import "../core/load-env.js"; // ★가장 먼저 — <home>/.env(레포 폴백) 로드.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { findBundledClaude, bundledClaudeMissingHint } from "../core/claude-cli.js";
import { upsertHomeEnvVars } from "../core/env-file.js";

/** 상류가 찍는 장기 토큰. 접두는 우리 redact 규칙이 이미 아는 것과 같다(`sk-ant-`). */
const TOKEN_RE = /\bsk-ant-[A-Za-z0-9._-]{20,}\b/;

const ask = async (q: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await new Promise<string>((r) => rl.question(q, r))).trim();
  } finally {
    rl.close();
  }
};

const main = async (): Promise<number> => {
  const bin = findBundledClaude();
  if (bin === null) {
    console.error(`\n★ ${bundledClaudeMissingHint()}`);
    return 1;
  }
  console.log("\n=== Claude 구독 토큰 발급 ===");
  console.log(`실행기: ${bin}`);
  console.log("브라우저가 열리면 로그인하세요. (구독 계정이 필요합니다)\n");

  // ★stdout 은 파이프로 받되 **그대로 되흘린다** — 우리가 토큰을 집기 위해 화면을 가로채면
  //  안 된다(사용자는 진행 상황을 봐야 한다). stdin·stderr 은 그대로 물려준다.
  const captured = await new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(bin, ["setup-token"], {
      stdio: ["inherit", "pipe", "inherit"],
      env: process.env,
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
      process.stdout.write(c);
    });
    child.on("error", (e) => resolve({ code: 1, out: `${out}\n${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });

  let token = TOKEN_RE.exec(captured.out)?.[0] ?? "";
  if (token === "") {
    // ★자동이 안 되면 **막히지 않게** 한다. 실패 자체는 정직하게 말한다.
    console.log(
      "\n토큰을 자동으로 못 집었습니다(형식이 바뀌었을 수 있습니다). 위 출력에서 복사해 붙여넣으세요.",
    );
    token = await ask("CLAUDE_CODE_OAUTH_TOKEN: ");
  }
  if (token === "") {
    console.error("\n★ 토큰이 비었습니다 — .env 를 건드리지 않았습니다.");
    return 1;
  }

  const written = await upsertHomeEnvVars({ CLAUDE_CODE_OAUTH_TOKEN: token });
  console.log(`\n✅ ${written} 에 CLAUDE_CODE_OAUTH_TOKEN 을 저장했습니다.`);
  console.log("   (데몬이 돌고 있으면 재시작해야 반영됩니다: `tiguclaw daemon:restart`)");
  return 0;
};

void main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error("claude-auth 실패:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
