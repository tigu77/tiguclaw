/**
 * 회귀: **비밀 파일은 내용보다 권한이 먼저다 — Windows 도** (2026-11-05, v082 Windows v7 MARTIN-H).
 *
 * 사고: `.env` 쓰기가 mode/chmod 0600 만 해서, Windows 에선 DACL 이 그대로 **상위 폴더 상속**을 받았다(실행 계정이 아닌 SID 에
 *  ReadData). 진단: docs/decisions/2026-11-05-v082-windows-v7-full-failures.md · 설계: …-v082-windows-secret-acl-and-link-tests.md.
 * 지키는 것: ①빈 파일 → 권한 → 내용 순서(합성 Windows 분기 — 모든 OS) ②권한을 못 세우면 쓰지 않고 그 파일을 지운다
 *  ③배타 생성이 실패하면 남의 파일을 지우지 않는다(헬퍼 + 실제 `.env` 경로) ④실제 소비처의 교체 실패 — mcp-oauth 기록·init `.env`
 *  — 에서 기존 파일 보존·임시 사본 0·실패 전달 ⑤(Windows 에서만) 부모 상속·기본 DACL·미리 있던 명시 Allow 어느 것에서 출발해도
 *  결과 DACL 이 «본인·SYSTEM·Administrators 만, 상속 없음» · 경로 인용(공백·한글·`& % ^ '`).
 * ★맥의 합성 단언은 Windows DACL 의 근거가 아니다 — ⑤가 Windows 에서 돌아야 그 부분이 확인된다.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { secretFilePermissions } from "./_env-file-permissions.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INIT = path.join(REPO, "src/scripts/init.ts");
const FAKE_SID = "S-1-5-21-111-222-333-1001";
const REJECT_RENAME = "data:text/javascript," + encodeURIComponent(
  'import fs from "node:fs/promises"; fs.rename = async () => { const e = new Error("EPERM: injected rename failure"); e.code = "EPERM"; throw e; };',
);

/** init 을 실제로 돌린다 — 프롬프트가 보이면 그때 답한다(미리 넣으면 readline 이 흘린다). */
const runInit = async (home: string, answers: Array<[RegExp, string]>, injectRenameFailure: boolean): Promise<{ status: number | null; out: string }> => {
  const { spawn } = await import("node:child_process");
  const args = ["--import", import.meta.resolve("tsx"), ...(injectRenameFailure ? ["--import", REJECT_RENAME] : []), INIT];
  // ★cwd 는 격리 홈 — init 은 cwd 의 `.env` 도 읽는다(`installedEnvLookup` 의 레포 폴백). 레포에 두면 개발 기계의 실제 `.env` 를 읽는다.
  const child = spawn(process.execPath, args, { cwd: home, env: { ...process.env, TIGUCLAW_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let next = 0;
  const onData = (b: Buffer) => {
    out += b.toString();
    while (next < answers.length && answers[next]![0].test(out.slice(out.lastIndexOf("\n", out.length - 2) + 1))) {
      child.stdin.write(`${answers[next]![1]}\n`);
      next++;
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
  const timer = setTimeout(() => child.kill(), 90_000);
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return { status, out };
};

export const check: RegressionCheck = {
  name: "secret-file-private-writes",
  guards: "Windows 에서 비밀 파일(.env·MCP OAuth 기록·init .env)이 mode 0600 만으로는 DACL 이 안 바뀌어 상위 폴더 상속 권한으로 남던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const sf = await import("../../core/secret-file.js");
    const base = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "secret 검증 & %PATH% ^ '-"));
    try {
      // ── ① 합성 Windows 분기: 순서·인자·실패 ─────────────────────────────────────────
      const fake = (fail?: "whoami" | "badsid" | "reset" | "grant") => {
        const calls: Array<{ file: string; args: string[]; size: number }> = [];
        const exec = async (file: string, args: string[]): Promise<string> => {
          const target = file === "icacls.exe" ? args[0]! : "";
          calls.push({ file, args, size: target && existsSync(target) ? statSync(target).size : -1 });
          if (file === "whoami.exe") {
            if (fail === "whoami") throw new Error("whoami failed");
            return fail === "badsid" ? '"pc\\user","not-a-sid"\r\n' : `"pc\\user","${FAKE_SID}"\r\n`;
          }
          if (fail === "reset" && args[1] === "/reset") throw new Error("icacls failed");
          if (fail === "grant" && args[1] === "/inheritance:r") throw new Error("icacls failed");
          return "";
        };
        return { calls, opts: { platform: "win32" as const, exec } };
      };
      const synth = path.join(base, "synthetic secret.env");
      const ok = fake();
      await sf.writePrivateFile(synth, "TOKEN=synthetic\n", ok.opts);
      out.push(assert(
        "★Windows 분기: 빈 파일에 whoami→icacls /reset→/inheritance:r /grant:r(본인·SYSTEM·Administrators) 뒤에야 내용 · 경로는 인자 하나 그대로",
        JSON.stringify(ok.calls.map((c) => [c.file, c.args, c.size])) === JSON.stringify([
          ["whoami.exe", ["/user", "/fo", "csv", "/nh"], -1],
          ["icacls.exe", [synth, "/reset"], 0],
          ["icacls.exe", [synth, "/inheritance:r", "/grant:r", `*${FAKE_SID}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"], 0],
        ]) && readFileSync(synth, "utf8") === "TOKEN=synthetic\n",
        ok.calls,
      ));
      const failures: Record<string, unknown> = {};
      for (const mode of ["whoami", "badsid", "reset", "grant"] as const) {
        const f = path.join(base, `fail-${mode}`);
        const fk = fake(mode);
        let threw = false;
        try { await sf.writePrivateFile(f, "TOKEN=must-not-land\n", fk.opts); } catch { threw = true; }
        failures[mode] = { threw, exists: existsSync(f), sizes: fk.calls.map((c) => c.size) };
      }
      out.push(assert(
        "★권한을 못 세우면(사용자 SID 못 읽음·형식 이상·/reset 실패·/grant 실패) 내용을 쓰지 않고 그 파일을 지운 뒤 던진다",
        Object.values(failures).every((v) => (v as { threw: boolean; exists: boolean; sizes: number[] }).threw && !(v as { exists: boolean }).exists &&
          (v as { sizes: number[] }).sizes.every((s) => s <= 0)),
        failures,
      ));
      // SID 캐시: 적중하면 whoami 를 다시 띄우지 않는다(띄워 놓고 버린 실패는 처리되지 않은 rejection → 데몬 종료) · 실패는 캐시하지 않는다.
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => { unhandled.push(e instanceof Error ? e.message : String(e)); };
      process.on("unhandledRejection", onUnhandled);
      const sidRun = async (outcomes: Array<"ok" | "fail">) => {
        let n = 0;
        const exec = async (file: string): Promise<string> => {
          if (file !== "whoami.exe") return "";
          const r = outcomes[Math.min(n++, outcomes.length - 1)];
          if (r === "fail") throw new Error("whoami unavailable");
          return `"pc\\user","${FAKE_SID}"`;
        };
        const res: string[] = [];
        for (let i = 0; i < 2; i++) {
          const f = path.join(base, `sid-cache-${outcomes.join("-")}-${i}`);
          try { await sf.writePrivateFile(f, "TOKEN=x\n", { platform: "win32", exec }); res.push("ok"); } catch { res.push("threw"); }
        }
        return { res, whoami: n };
      };
      const hitThenFail = await sidRun(["ok", "fail"]);
      const failThenOk = await sidRun(["fail", "ok"]);
      await new Promise((r) => setTimeout(r, 50));
      process.off("unhandledRejection", onUnhandled);
      out.push(assert(
        "★SID 캐시: 두 번째 저장은 whoami 를 다시 띄우지 않는다(처리되지 않은 rejection 0) · 실패한 조회는 캐시하지 않아 다음 저장이 다시 묻는다",
        JSON.stringify(hitThenFail) === JSON.stringify({ res: ["ok", "ok"], whoami: 1 }) &&
          JSON.stringify(failThenOk) === JSON.stringify({ res: ["threw", "ok"], whoami: 2 }) && unhandled.length === 0,
        { hitThenFail, failThenOk, unhandled },
      ));
      if (process.platform !== "win32") {
        // 이 OS 엔 whoami.exe·icacls.exe 가 없다 — 실제 기본 실행기가 «도구 없음» 에서 안전하게 실패하는지(쉘 없이 실행 파일을 찾는다).
        const f = path.join(base, "no-tools");
        let threw = false;
        try { await sf.writePrivateFile(f, "TOKEN=must-not-land\n", { platform: "win32" }); } catch { threw = true; }
        out.push(assert("Windows 도구를 못 찾으면 쓰지 않고 실패한다(기본 실행기 — 쉘 없음)", threw && !existsSync(f), { threw, exists: existsSync(f) }));
      }

      // ── ③ 배타 생성 실패는 남의 파일을 안 지운다 ─────────────────────────────────────────
      const theirs = path.join(base, "theirs.tmp");
      writeFileSync(theirs, "SENTINEL");
      let eexist = "";
      try { await sf.writePrivateFile(theirs, "TOKEN=x\n"); } catch (e) { eexist = (e as NodeJS.ErrnoException).code ?? String(e); }
      const envHome = mkdtempSync(path.join(base, "envhome-"));
      const savedHome = process.env.TIGUCLAW_HOME;
      const crypto = (await import("node:crypto")).default as unknown as { randomBytes: (n: number) => Buffer };
      const realRandom = crypto.randomBytes;
      let envThrew = false;
      const envPath = path.join(envHome, ".env");
      const squat = `${envPath}.tmp-${process.pid}-deadbeef`;
      writeFileSync(envPath, "OTHER_KEY=keep-me\n");
      writeFileSync(squat, "SENTINEL");
      process.env.TIGUCLAW_HOME = envHome;
      crypto.randomBytes = () => Buffer.from("deadbeef", "hex");
      try {
        const { upsertHomeEnvVars } = await import("../../core/env-file.js");
        try { await upsertHomeEnvVars({ REGR_SECRET_EEXIST: "x" }); } catch { envThrew = true; }
      } finally {
        crypto.randomBytes = realRandom;
        process.env.TIGUCLAW_HOME = savedHome;
        delete process.env.REGR_SECRET_EEXIST;
      }
      out.push(assert(
        "★배타 생성이 막히면(EEXIST) 그 파일을 지우지 않는다 — 헬퍼 직접 · 실제 .env 저장 경로(임시 이름 선점) 둘 다, .env 도 그대로",
        eexist === "EEXIST" && readFileSync(theirs, "utf8") === "SENTINEL" && envThrew && readFileSync(squat, "utf8") === "SENTINEL" &&
          readFileSync(envPath, "utf8") === "OTHER_KEY=keep-me\n",
        { eexist, envThrew, squat: readFileSync(squat, "utf8"), env: readFileSync(envPath, "utf8") },
      ));

      // ── ④ 실제 소비처의 교체 실패 ────────────────────────────────────────────────────
      const oauth = await import("../../core/mcp-oauth.js");
      const { getPaths } = await import("../../core/paths.js");
      const store = path.join(getPaths().home, "mcp-oauth");
      const cfg = path.join(base, "mcp.json");
      const k1 = { file: cfg, name: "regr-secret-a", url: "http://127.0.0.1:1/a" };
      await oauth.markMcpLoginNeeded(k1);
      const before = readdirSync(store).sort();
      const k1File = before.find((f) => f.endsWith(".json") && readFileSync(path.join(store, f), "utf8").includes("regr-secret-a"));
      const k1Path = k1File ? path.join(store, k1File) : "";
      const k1Perm = k1File ? secretFilePermissions(k1Path) : { ok: false, got: "no record" };
      // 같은 기록을 **갱신**하게 만든다(«로그인 필요» 표시를 떼면 다음 호출이 그 파일을 다시 쓴다) — 교체 대상이 이미 있는 실패 보존.
      if (k1File) {
        const rec = JSON.parse(readFileSync(k1Path, "utf8")) as Record<string, unknown>;
        delete rec.loginNeeded;
        writeFileSync(k1Path, JSON.stringify(rec));
      }
      const k1Bytes = k1File ? readFileSync(k1Path, "utf8") : "";
      const fsp = (await import("node:fs/promises")).default as unknown as { rename: (...a: unknown[]) => Promise<void> };
      const realRename = fsp.rename;
      let renameCalls = 0;
      fsp.rename = async () => { renameCalls++; const e = new Error("EPERM: injected rename failure") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; };
      let oauthThrew = false;
      try { await oauth.markMcpLoginNeeded(k1); } catch { oauthThrew = true; } finally { fsp.rename = realRename; }
      const after = readdirSync(store).sort();
      out.push(assert(
        "★MCP OAuth 기록: 새 기록은 본인만 읽는다 · 같은 기록의 갱신 교체가 실패하면 던지고 그 파일 바이트 그대로 · 임시 사본 0",
        k1Perm.ok && renameCalls === 1 && oauthThrew && JSON.stringify(after) === JSON.stringify(before) && k1File !== undefined &&
          readFileSync(k1Path, "utf8") === k1Bytes,
        { perm: k1Perm.got, renameCalls, oauthThrew, before, after },
      ));
      await oauth.forgetMcpOAuth(cfg, "regr-secret-a");

      const initHome = mkdtempSync(path.join(base, "inithome-"));
      const ask = (overwrite: boolean): Array<[RegExp, string]> => [
        ...(overwrite ? [[/Type "overwrite"/, "overwrite"] as [RegExp, string]] : []),
        [/Choice \[/, "openai"], [/OPENAI_API_KEY/, "sk-synthetic-regression"], [/Set up Telegram\?/, "n"],
      ];
      const first = await runInit(initHome, ask(false), false);
      const initEnv = path.join(initHome, ".env");
      const firstBytes = existsSync(initEnv) ? readFileSync(initEnv, "utf8") : "";
      const firstPerm = existsSync(initEnv) ? secretFilePermissions(initEnv) : { ok: false, got: "no .env" };
      const second = await runInit(initHome, ask(true), true);
      const leftovers = readdirSync(initHome).filter((f) => f.includes(".tmp-"));
      out.push(assert(
        "init 이 만든 .env 는 본인만 읽는다(POSIX 0600 / Windows DACL)",
        first.status === 0 && /Wrote \.env/.test(first.out) && firstBytes.includes("OPENAI_API_KEY=sk-synthetic-regression") && firstPerm.ok,
        { status: first.status, perm: firstPerm.got, tail: first.out.slice(-400) },
      ));
      out.push(assert(
        "★init 의 교체가 실패하면 실패로 끝나고(성공 안내 없음) 기존 .env 그대로 · 임시 사본 0",
        second.status === 1 && !/Wrote \.env/.test(second.out) && existsSync(initEnv) && readFileSync(initEnv, "utf8") === firstBytes && leftovers.length === 0,
        { status: second.status, leftovers, tail: second.out.slice(-400) },
      ));

      // ── ⑤ Windows 실측: 어떤 출발 DACL 에서도 결과가 같다 ────────────────────────────────
      if (process.platform === "win32") {
        const icacls = (...a: string[]) => spawnSync("icacls.exe", a, { encoding: "utf8", timeout: 10_000, windowsHide: true });
        const inherit = path.join(base, "parent everyone");
        mkdirSync(inherit);
        const g1 = icacls(inherit, "/grant", "*S-1-1-0:(OI)(CI)(R)");
        writeFileSync(path.join(inherit, "plain"), "x");
        await sf.replacePrivateFile(path.join(inherit, ".env"), "TOKEN=synthetic\n");
        const noInherit = path.join(base, "parent no-inheritable");
        mkdirSync(noInherit);
        const selfSid = (spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout.trim().split(",").pop() ?? "").replace(/"/g, "");
        const g2 = icacls(noInherit, "/inheritance:r", "/grant:r", `*${selfSid}:(F)`);
        await sf.replacePrivateFile(path.join(noInherit, ".env"), "TOKEN=synthetic\n");
        const explicit = path.join(base, "explicit everyone");
        writeFileSync(explicit, "");
        const g3 = icacls(explicit, "/grant", "*S-1-1-0:(R)");
        await sf.restrictToCurrentUser(explicit);
        const r = {
          inherit: secretFilePermissions(path.join(inherit, ".env")),
          inheritPlainControl: secretFilePermissions(path.join(inherit, "plain")),
          defaultDacl: secretFilePermissions(path.join(noInherit, ".env")),
          explicitReset: secretFilePermissions(explicit),
        };
        const setup = [g1, g2, g3].map((g) => g.status);
        out.push(assert(
          "★Windows: 상속 Everyone 부모 · 상속 ACE 없는 부모(기본 DACL) · 명시 Everyone 이 미리 있던 파일 — 셋 다 결과가 «본인·SYSTEM·Administrators 만, 상속 없음» (경로에 공백·한글·& % ^ ')",
          setup.every((s) => s === 0) && r.inherit.ok && r.defaultDacl.ok && r.explicitReset.ok,
          { setup, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.got])) },
        ));
        out.push(assert(
          "판정기 음성 대조: 같은 부모의 일반 파일(상속 Everyone)은 거부 — fixture 가 실제로 새는 부모임을 보인다(명시 Everyone 대조는 env-file-concurrent-writes)",
          !r.inheritPlainControl.ok && !r.inheritPlainControl.got.includes("unverified"),
          { plain: r.inheritPlainControl.got },
        ));
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    return out;
  },
};
