/**
 * 회귀: **인증값은 재시작 없이 따라가되, 파일이 바뀐 키만** (2026-09-29).
 *
 * 사고: 터미널에서 재발급하면 파일만 바뀌고 돌고 있는 데몬은 옛 토큰을 계속 써서, 재시작을 모르는 사용자는
 *  «재발급했는데 계속 401» 을 겪었다. ★반대 방향의 함정도 지킨다 — 매 턴 파일로 덮으면, 데몬이 스스로 갱신한
 *  codex 토큰(파일 쓰기 실패)이 **무효가 된 옛 값으로 되돌아간다**. 셸 환경변수 우선 규칙도 부팅 때는 그대로다.
 * 임시 파일 + 가짜 env 객체로 제품 코드(`makeCredentialWatch`)를 그대로 돌린다.
 */
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "credential-env-follows-file",
  guards: "터미널 재발급이 돌고 있는 데몬에 안 먹어 재시작해야 하던 것 — 그리고 매 턴 덮어쓰기가 데몬이 갱신한 토큰을 되돌리는 것",
  run: async (): Promise<Assertion[]> => {
    const { makeCredentialWatch } = await import("../../core/credential-env.js");
    const dir = mkdtempSync(path.join(tmpdir(), "cred-watch-"));
    const file = path.join(dir, ".env");
    const out: Assertion[] = [];
    try {
      const write = (lines: Record<string, string>) =>
        writeFileSync(file, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\nTELEGRAM_BOT_TOKEN=x\n");
      write({ CLAUDE_CODE_OAUTH_TOKEN: "old-claude", OPENAI_CODEX_OAUTH_REFRESH: "r1", ANTHROPIC_API_KEY: "file-key" });
      // 부팅: 파일 값이 올라갔다 — 단 ANTHROPIC_API_KEY 는 셸이 줬다(우선).
      const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "old-claude", OPENAI_CODEX_OAUTH_REFRESH: "r1", ANTHROPIC_API_KEY: "shell-key" };
      const w = makeCredentialWatch(file, env);
      w.snapshot();
      const idle = w.refresh();
      // 데몬이 codex 를 스스로 갱신 — 메모리는 r2, 파일 쓰기는 실패해 r1 그대로.
      env.OPENAI_CODEX_OAUTH_REFRESH = "r2";
      const afterOwnRefresh = w.refresh();
      out.push(
        assert(
          "★파일이 그대로면 아무것도 안 바꾼다 — 데몬이 갱신한 codex 토큰(쓰기 실패)도, 셸이 준 키도 유지",
          idle.length === 0 && afterOwnRefresh.length === 0 && env.OPENAI_CODEX_OAUTH_REFRESH === "r2" && env.ANTHROPIC_API_KEY === "shell-key",
          { idle, afterOwnRefresh, refresh: env.OPENAI_CODEX_OAUTH_REFRESH, key: env.ANTHROPIC_API_KEY },
        ),
      );
      // 터미널에서 claude 재발급 — 파일의 claude 키만 바뀐다(codex 줄은 옛 r1 그대로).
      write({ CLAUDE_CODE_OAUTH_TOKEN: "new-claude", OPENAI_CODEX_OAUTH_REFRESH: "r1", ANTHROPIC_API_KEY: "file-key" });
      const changed = w.refresh();
      out.push(
        assert(
          "★파일에서 바뀐 인증 키만 반영한다 — 새 claude 토큰은 들어오고, 안 바뀐 codex 줄은 메모리의 새 값을 되돌리지 않는다",
          JSON.stringify(changed) === '["CLAUDE_CODE_OAUTH_TOKEN"]' && env.CLAUDE_CODE_OAUTH_TOKEN === "new-claude" &&
            env.OPENAI_CODEX_OAUTH_REFRESH === "r2" && env.ANTHROPIC_API_KEY === "shell-key",
          { changed, env },
        ),
      );
      // 누가 그 키를 파일에서 새로 쓰면(재인증) 셸 값보다 파일을 따른다 · 인증 아닌 키는 안 따른다.
      writeFileSync(file, "CLAUDE_CODE_OAUTH_TOKEN=new-claude\nOPENAI_CODEX_OAUTH_REFRESH=r1\nANTHROPIC_API_KEY=file-key-2\nTELEGRAM_BOT_TOKEN=y\n");
      const second = w.refresh();
      out.push(
        assert(
          "파일에서 새로 쓴 키는 따른다(재인증) · 인증이 아닌 키(봇 토큰)는 부팅 고정",
          JSON.stringify(second) === '["ANTHROPIC_API_KEY"]' && env.ANTHROPIC_API_KEY === "file-key-2" && env.TELEGRAM_BOT_TOKEN === undefined,
          { second, env },
        ),
      );
      // ★못 읽은 턴을 «빈 파일» 로 기록하면, 파일이 돌아올 때 옛 값이 «변경» 으로 보여 메모리를 되돌린다(적대 검토 P3).
      //  권한 거부·잠시 없어짐 둘 다. 그리고 다른 프로세스가 옛 본문으로 덮어도(경합) 거쳐 간 값으로는 안 돌아간다.
      {
        const f3 = path.join(dir, "flaky.env");
        writeFileSync(f3, "OPENAI_CODEX_OAUTH_REFRESH=r1\nANTHROPIC_API_KEY=file-key\n");
        const e3: NodeJS.ProcessEnv = { OPENAI_CODEX_OAUTH_REFRESH: "r1", ANTHROPIC_API_KEY: "shell-key" };
        const w3 = makeCredentialWatch(f3, e3);
        w3.snapshot();
        e3.OPENAI_CODEX_OAUTH_REFRESH = "r2"; // 데몬 갱신 — 파일 쓰기 실패
        const results: string[][] = [];
        const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
        if (canChmod) {
          chmodSync(f3, 0o000);
          results.push(w3.refresh());
          chmodSync(f3, 0o600);
          results.push(w3.refresh());
        }
        renameSync(f3, f3 + ".away");
        results.push(w3.refresh());
        renameSync(f3 + ".away", f3);
        results.push(w3.refresh());
        // 경합: 데몬이 r3 으로 갱신해 파일에도 썼고(턴이 봤다) → 다른 프로세스가 r1 이 든 옛 본문으로 덮는다.
        e3.OPENAI_CODEX_OAUTH_REFRESH = "r3";
        writeFileSync(f3, "OPENAI_CODEX_OAUTH_REFRESH=r3\nANTHROPIC_API_KEY=file-key\n");
        results.push(w3.refresh());
        writeFileSync(f3, "OPENAI_CODEX_OAUTH_REFRESH=r1\nANTHROPIC_API_KEY=file-key\n");
        results.push(w3.refresh());
        out.push(
          assert(
            "★못 읽은 턴(권한 거부·잠시 없음)과 옛 본문 덮어쓰기(경합) 뒤에도 옛 값으로 되돌아가지 않는다",
            results.every((r) => r.length === 0) && e3.OPENAI_CODEX_OAUTH_REFRESH === "r3" && e3.ANTHROPIC_API_KEY === "shell-key",
            { results, refresh: e3.OPENAI_CODEX_OAUTH_REFRESH, key: e3.ANTHROPIC_API_KEY, chmod: canChmod },
          ),
        );
      }
      // ★회전하지 않는 키(Claude 토큰)는 이전 값으로 되돌려도 따라간다 — 되돌림 금지는 codex 전용(전체 검토).
      {
        const f4 = path.join(dir, "switch.env");
        writeFileSync(f4, "CLAUDE_CODE_OAUTH_TOKEN=A\n");
        const e4: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "A" };
        const w4 = makeCredentialWatch(f4, e4);
        w4.snapshot();
        writeFileSync(f4, "CLAUDE_CODE_OAUTH_TOKEN=B\n");
        const toB = w4.refresh();
        writeFileSync(f4, "CLAUDE_CODE_OAUTH_TOKEN=A\n");
        const backToA = w4.refresh();
        out.push(
          assert(
            "★Claude 토큰은 A→B→A 로 되돌려도 따른다(회전 토큰이 아니다) — 되돌림 금지는 codex 키에만",
            JSON.stringify(toB) === '["CLAUDE_CODE_OAUTH_TOKEN"]' && JSON.stringify(backToA) === '["CLAUDE_CODE_OAUTH_TOKEN"]' && e4.CLAUDE_CODE_OAUTH_TOKEN === "A",
            { toB, backToA, now: e4.CLAUDE_CODE_OAUTH_TOKEN },
          ),
        );
      }
      // 부팅 때 파일이 없었다가 생겨도 따라간다 · 스냅샷 전엔 아무것도 안 한다.
      const file2 = path.join(dir, "later.env");
      const env2: NodeJS.ProcessEnv = {};
      const w2 = makeCredentialWatch(file2, env2);
      const beforeSnapshot = w2.refresh();
      w2.snapshot();
      writeFileSync(file2, "CLAUDE_CODE_OAUTH_TOKEN=fresh\n");
      const appeared = w2.refresh();
      out.push(
        assert(
          "부팅 때 없던 파일이 생기면 그 값을 따른다 · 스냅샷 전 호출은 아무것도 안 한다",
          beforeSnapshot.length === 0 && JSON.stringify(appeared) === '["CLAUDE_CODE_OAUTH_TOKEN"]' && env2.CLAUDE_CODE_OAUTH_TOKEN === "fresh",
          { beforeSnapshot, appeared },
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // 데몬이 실제로 쓰는 전역 입구 — 켜기(부팅)와 따라가기(턴)가 실제로 process.env 를 바꾼다.
    {
      const { startHomeCredentialWatch, refreshHomeCredentials } = await import("../../core/credential-env.js");
      const dir2 = mkdtempSync(path.join(tmpdir(), "cred-home-"));
      const f = path.join(dir2, ".env");
      const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      try {
        writeFileSync(f, "CLAUDE_CODE_OAUTH_TOKEN=boot-value\n");
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "boot-value";
        startHomeCredentialWatch(f);
        // 자격이 바뀌면 그 자격의 쉼도 풀린다 — 손으로 고친 `.env`·옛 플러그인 경로도(전체 검토).
        const { initStore } = await import("../../store/sessions.js");
        const { saveCooldown, loadLiveCooldowns, deleteCooldown } = await import("../../store/cooldowns.js");
        initStore();
        saveCooldown("anthropic", Date.now() + 3_600_000);
        saveCooldown("codex", Date.now() + 3_600_000);
        writeFileSync(f, "CLAUDE_CODE_OAUTH_TOKEN=reissued-value\n");
        const rt = await import("../../core/llm-runtime/index.js");
        rt.followHomeCredentials();
        const left = loadLiveCooldowns(Date.now()).map((x) => x.key);
        deleteCooldown("codex");
        out.push(
          assert(
            "★전역 입구가 실제로 따라가고 바뀐 자격의 쉼을 푼다 — 재발급한 값이 process.env 에 들어오고, claude 쉼만 풀린다",
            process.env.CLAUDE_CODE_OAUTH_TOKEN === "reissued-value" && !left.includes("anthropic") && left.includes("codex"),
            { value: process.env.CLAUDE_CODE_OAUTH_TOKEN === "reissued-value" ? "반영" : "★안 들어왔다", left },
          ),
        );
        void refreshHomeCredentials;
      } finally {
        if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
        startHomeCredentialWatch(path.join(dir2, "gone.env")); // 전역 감시를 없는 파일로 돌려 둔다
        rmSync(dir2, { recursive: true, force: true });
      }
    }
    // ★회전 키 저장 둘이 겹친 사이에 턴 입구가 끼어도 메모리가 앞 저장(무효)에 고정되지 않는다 — 우리 쓰기의 중간 파일을
    //  «바깥 변경» 으로 읽어 A 로 되돌리고, 이어 온 B 는 «거쳐 간 값» 이라 거부하던 것(적대 검토).
    {
      const { startHomeCredentialWatch, refreshHomeCredentials } = await import("../../core/credential-env.js");
      const { upsertHomeEnvVars } = await import("../../core/env-file.js");
      const { homeEnvPath } = await import("../../core/load-env.js");
      const K = "OPENAI_CODEX_OAUTH_TOKEN";
      const savedHome = process.env.TIGUCLAW_HOME;
      const before = process.env[K];
      const dir3 = mkdtempSync(path.join(tmpdir(), "cred-rotate-"));
      try {
        process.env.TIGUCLAW_HOME = dir3;
        const f = homeEnvPath();
        writeFileSync(f, `${K}=rot-0\n`);
        process.env[K] = "rot-0";
        startHomeCredentialWatch(f);
        const pA = upsertHomeEnvVars({ [K]: "rot-A" });
        const pB = upsertHomeEnvVars({ [K]: "rot-B" });
        await pA; // 파일 = A, B 는 아직 쓰는 중
        const midFile = readFileSync(f, "utf8").trim();
        const mid = refreshHomeCredentials();
        const midMem = process.env[K];
        await pB;
        const end = refreshHomeCredentials();
        const endMem = process.env[K];
        writeFileSync(f, `${K}=rot-relogin\n`); // 바깥 재로그인은 여전히 따른다
        const outside = refreshHomeCredentials();
        const outsideMem = process.env[K];
        // ★쓰기가 **실패**해도 «쓰는 중» 표시는 내려간다 — 안 내려가면 재시작 전까지 따라가기가 조용히 꺼진다(적대 검토 G2:
        //  실패 쪽 감소를 빼도 초록이었다). 쓸 수 없는 홈으로 저장을 실패시킨 뒤 바깥 재로그인을 따르는지 본다.
        chmodSync(dir3, 0o500);
        let rejected = false;
        try { await upsertHomeEnvVars({ [K]: "rot-fail" }); } catch { rejected = true; }
        chmodSync(dir3, 0o700);
        writeFileSync(f, `${K}=rot-relogin2\n`);
        const afterFail = refreshHomeCredentials();
        out.push(assert("★저장이 실패해도 따라가기는 살아 있다(root 처럼 쓰기가 안 막히는 환경은 이 단언을 건너뛴다)",
          !rejected || (afterFail.includes(K) && process.env[K] === "rot-relogin2"), { rejected, afterFail }));
        out.push(assert(
          "★회전 키 저장이 겹친 사이 턴 입구가 끼어도 메모리는 마지막 저장 값 — 무효가 된 앞 값에 고정되지 않는다 · 바깥 재로그인은 따른다",
          midFile === `${K}=rot-A` && mid.length === 0 && midMem === "rot-B" && end.length === 0 && endMem === "rot-B" &&
            outside.includes(K) && outsideMem === "rot-relogin",
          { midFile: midFile.replace(/=.*/, "=…"), mid, midMem, end, endMem, outside },
        ));
      } finally {
        if (savedHome === undefined) delete process.env.TIGUCLAW_HOME; else process.env.TIGUCLAW_HOME = savedHome;
        if (before === undefined) delete process.env[K]; else process.env[K] = before;
        startHomeCredentialWatch(path.join(dir3, "gone.env"));
        rmSync(dir3, { recursive: true, force: true });
      }
    }
    // ★앞 저장 성공 · 뒤 저장 실패 — 파일 A · 메모리 B 가 된다. 따라가기가 A 를 바깥 재로그인으로 읽어 무효가 된 A 로 되돌리던 것
    //  (2026-10-01 외부 검토 실측). 파일이 «우리가 마지막으로 쓴 그대로» 면 따르지 않는다 · 바깥 재로그인은 여전히 따른다.
    {
      const { startHomeCredentialWatch, refreshHomeCredentials } = await import("../../core/credential-env.js");
      const { upsertHomeEnvVars } = await import("../../core/env-file.js");
      const { homeEnvPath } = await import("../../core/load-env.js");
      const K = "OPENAI_CODEX_OAUTH_TOKEN";
      const savedHome = process.env.TIGUCLAW_HOME;
      const before = process.env[K];
      const dir4 = mkdtempSync(path.join(tmpdir(), "cred-halffail-"));
      const fsp = (await import("node:fs/promises")).default as unknown as { rename: (...a: unknown[]) => Promise<void> };
      const realRename = fsp.rename;
      try {
        process.env.TIGUCLAW_HOME = dir4;
        const f = homeEnvPath();
        writeFileSync(f, `${K}=half-O\n`);
        process.env[K] = "half-O";
        startHomeCredentialWatch(f);
        let n = 0;
        fsp.rename = async (...a: unknown[]) => { n++; if (n === 2) { const e = new Error("EPERM") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; } return realRename(...a); };
        const pA = upsertHomeEnvVars({ [K]: "half-A" });
        const pB = upsertHomeEnvVars({ [K]: "half-B" });
        await pA;
        let bFailed = false;
        try { await pB; } catch { bFailed = true; }
        fsp.rename = realRename;
        const fileNow = readFileSync(f, "utf8").trim();
        const after = refreshHomeCredentials();
        const mem = process.env[K];
        writeFileSync(f, `${K}=half-relogin\n`);
        const outside = refreshHomeCredentials();
        out.push(assert("★앞 저장 성공·뒤 저장 실패 뒤에도 메모리는 최신(무효가 된 앞 값으로 안 되돌아간다) · 바깥 재로그인은 따른다",
          bFailed && fileNow === `${K}=half-A` && after.length === 0 && mem === "half-B" && outside.includes(K) && process.env[K] === "half-relogin",
          { bFailed, fileNow: fileNow.replace(/=.*/, "=…"), after, mem, outside }));
      } finally {
        fsp.rename = realRename;
        if (savedHome === undefined) delete process.env.TIGUCLAW_HOME; else process.env.TIGUCLAW_HOME = savedHome;
        if (before === undefined) delete process.env[K]; else process.env[K] = before;
        startHomeCredentialWatch(path.join(dir4, "gone.env"));
        rmSync(dir4, { recursive: true, force: true });
      }
    }
    // 배선 — 부팅 때 스냅샷, 턴 입구에서 갱신(모든 어댑터가 이 입구를 지난다).
    const { readSourceSync } = await import("./_wiring.js");
    const loader = readSourceSync("src/core/load-env.ts");
    const facade = readSourceSync("src/core/llm-runtime/index.ts");
    const entry = readSourceSync("src/index.ts");
    const codexLogin = readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth-login.ts");
    const wired = {
      boot: /const home_ok = tryLoad\(homeEnv\);[\s\S]{0,300}startHomeCredentialWatch\(homeEnv\);/.test(loader),
      turn: /export const runRegionA = async \([\s\S]{0,400}assertRuntimeModelAllowed\(\);[\s\S]{0,200}followHomeCredentials\(\);/.test(facade),
      // 인바운드 입구 — 라우터의 모델 풀 조립·슬래시 명령(`/compact`)이 runRegionA 보다 먼저 자격을 읽는다.
      inbound: /const handler: MessageHandler = async \(msg\) => \{\s*(\/\/[^\n]*\n\s*)*followHomeCredentials\(\);/.test(entry),
      // codex 로그인도 같은 해제 루틴(접두 DB 삭제 아님).
      codexLogin: /clearAuthCooldowns\("codex-oauth"\)/.test(codexLogin) && !/startsWith\("codex"\)/.test(codexLogin),
      // 종료 때 명령(`/compact`)은 «생성 중이던 응답» 기록·통지에서 빠진다.
      shutdown: /\.filter\(\(\[, v\]\) => v\.command !== true\)/.test(entry),
    };
    out.push(
      assert(
        "★부팅 때 기록 · 인바운드 입구와 runRegionA 입구에서 따라가기 · codex 로그인도 같은 해제 루틴 · 종료 때 명령은 턴 중단으로 안 셈",
        Object.values(wired).every(Boolean),
        wired,
      ),
    );
    return out;
  },
};
