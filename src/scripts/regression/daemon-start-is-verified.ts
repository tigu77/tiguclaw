/**
 * 회귀: 데몬 기동이 **떴는지 확인하고** 보고한다 — `✅` 를 먼저 찍지 않는다 (2026-08-15).
 *
 * 사고: 윈도우 돌쇠가 `tiguclaw update` 후 **93분간 죽어 있었다**. 그런데 CLI 는
 * `✅ started` 를 찍었다 — `winStart` 가 `wscript` 로 런처를 쏘고 **결과를 안 봤기**
 * 때문이다(`spawnSync(..., {stdio:"ignore"})` 라 실패도 조용하다). 사용자는 "반응이
 * 없다" 로 겪었고, 같은 구조인 회사 인스턴스도 같은 증상이 의심됐다(원격 확인 불가).
 *
 * ★증거의 등급을 정한다: 런처 실행 성공 = **쏜 것**뿐 · PID 존재 = 떴다가 죽는 중일 수
 *  있음 · **브리지 포트 LISTEN = 실제로 서비스 중**. 그래서 포트로 판정한다.
 *
 * ★윈도우에서 특히 치명적: 등록이 `HKCU Run`(로그온 1회)이라 **supervisor 가 없다**.
 *  맥 launchd `KeepAlive`·리눅스 systemd `Restart=` 는 죽으면 되살리지만 윈도우는 한 번
 *  죽으면 그대로 — 거짓 성공이 곧 **무기한 먹통**이다.
 *
 * ★이 파일은 **의존성-프리**다(깨진 node_modules 에서도 도는 최후 복구 경로). 그래서
 *  확인도 빌트인만으로 한다: `Atomics.wait` 로 자고 `netstat` 로 본다.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const src = await readFile(path.join(REPO, "bin/daemon.mjs"), "utf8");
  // ★주석 제거는 `_wiring.stripComments` 를 **공유**한다 (적대 검토 P13). 여기 있던 자체
  //  구현은 줄 첫머리 `//` 만 걷어서 **줄 끝 주석**에 오탐했다(같은 판정이 세 벌이었고
  //  그중 둘이 약했다).
  const code = stripComments(src);

  // ── ① 확인 없이 성공을 찍지 않는다 — 세 플랫폼 여섯 자리 ────────────────────
  const bare = [...code.matchAll(/console\.log\(\s*["'`]✅ (started|restarted)["'`]\s*\)/g)];
  out.push(
    assert(
      "★확인 없이 `✅ started/restarted` 를 찍는 자리가 없다",
      bare.length === 0,
      bare.length === 0 ? "무검증 성공 0곳" : `★${bare.length}곳 — 기동 명령만 보내고 성공 보고`,
    ),
  );

  // ── ② 데몬을 띄우는 **모든** 자리가 검증 경로를 탄다 ───────────────────────
  //  darwin/linux/win × install/start/restart. 하나라도 빠지면 그 플랫폼에서 사고가
  //  되돌아온다(install 은 2026-08-22 에 합류 — 종전엔 등록만 하고 성공을 찍었다).
  //
  // ★종전엔 `reportLaunch(` **개수 == 6** 으로 검사했다. 그건 손으로 관리하는 숫자라
  //  정당한 추가(install 검증)에도 빨간불이 됐고, 반대로 자리를 옮기기만 해도 통과했다.
  //  숫자 대신 **각 함수 본문에 검증이 있는가**를 본다 — 판정 기준이 곧 검사다.
  const launchSites = [
    "darwinInstall",
    "darwinStart",
    "darwinRestart",
    "linuxInstall",
    "linuxStart",
    "linuxRestart",
    "winInstall",
    "winStart",
    "winRestart",
  ];
  const missing = launchSites.filter((name) => {
    // `const <name> = (c) => {` 부터 같은 들여쓰기의 `};` 까지가 본문.
    const start = code.indexOf(`const ${name} = (c) => {`);
    if (start === -1) return true; // 함수 자체가 사라졌다 = 검사 대상 유실.
    const end = code.indexOf("\n};", start);
    const body = code.slice(start, end === -1 ? undefined : end);
    return !body.includes("reportLaunch(");
  });
  out.push(
    assert(
      "★데몬을 띄우는 9자리가 모두 검증 후 보고한다(3 플랫폼 × install/start/restart)",
      missing.length === 0,
      missing.length === 0
        ? `검증 누락 0곳 (${launchSites.length}자리 전부)`
        : `★검증 없이 보고하는 자리: ${missing.join(", ")}`,
    ),
  );

  // ── ③ 실패는 **실패로** 말한다 ──────────────────────────────────────────────
  out.push(
    assert(
      "★못 뜨면 ✅ 대신 🔴 + exit 1",
      /process\.exitCode = 1;/.test(code) && /🔴 Daemon not running after \$\{verb\.replace\(/.test(code),
      "실패 경로 확인",
    ),
  );

  // ── ④ 포트 판정이 **OS 별 표기**를 다 본다 ─────────────────────────────────
  //  macOS/BSD 는 `127.0.0.1.3000`(점), 리눅스·윈도우는 `:3000`(콜론). 콜론만 보다가
  //  맥에서 **살아 있는 데몬을 못 찾아 거짓 실패**를 냈다(헬퍼를 넣자마자 첫 시험에서 걸림).
  out.push(
    assert(
      "★포트 매칭이 점·콜론 표기를 모두 본다(맥 netstat 은 점을 쓴다)",
      /\[\.:\]\$\{port\}/.test(code),
      /\[\.:\]\$\{port\}/.test(code) ? "양쪽 표기 확인" : "★콜론만 봄 — 맥에서 거짓 실패",
    ),
  );
  // 경계도 본다 — `:3000` 이 `:30001` 을 맞히면 엉뚱한 프로세스를 데몬으로 오인한다.
  out.push(
    assert(
      "포트 뒤 경계를 본다(3000 이 30001 을 맞히지 않게)",
      /\(\?:\\\\s\|\$\)/.test(code) || /\(\?:\\s\|\$\)/.test(code),
      "경계 확인",
    ),
  );

  // ── ④-b ★포트를 잡은 게 **우리 데몬인지** 확인한다 (적대 검토 P7) ────────────
  //  실증: 아무 http 서버가 그 포트를 잡아도 성공으로 읽혔다(mac/linux 는 `netstat -an`
  //  이라 PID 도 없다). "PID 존재 = 죽는 중일 수 있음 · 포트 LISTEN = 서비스 중" 이라고
  //  등급을 적어놨는데 정작 mac/linux 에선 성립하지 않았다. `/health`(인증 밖)로 묻는다.
  out.push(
    assert(
      "★포트만 보지 않고 /health 로 우리 데몬임을 확인한다",
      /healthSaysOurs\(c\)/.test(code) && /"\/health"/.test(code),
      /healthSaysOurs/.test(code) ? "신원 확인 확인" : "★포트만 보고 성공 판정",
    ),
  );
  // ★재시작은 **정착 대기** 후에 잰다 — 옛 데몬이 종료 중 포트를 물고 있으면 그 소켓으로
  //  ✅ 가 찍힌다(옛 데몬도 /health 에 답하므로 신원 확인으로는 못 거른다).
  {
    const settled = (code.match(/waitForListening\(c, listeningOnBridge, 20000, \d+\)/g) ?? []).length;
    out.push(
      assert(
        "★restart 3자리는 정착 대기 후에 잰다(죽어가는 소켓을 성공으로 읽지 않게)",
        settled === 3,
        `정착 대기 있는 자리 ${settled}곳 (기대 3 — darwin·linux·win restart)`,
      ),
    );
  }

  // ── ④-c ★실패를 갈라 말한다 — 실제 waitForListening·reportLaunch 본문을 가짜 시계·프로브·health 로 (2026-10-29) ──
  //  Windows 현장: 같은 기동이 나중엔 정상이었는데 «bridge port never opened» 만 남아, 포트 누락인지 health 인지 늦은 기동인지 가를 수 없었다.
  //  판정(성공 = 포트 PID 그리고 health ok)은 그대로 — 바뀐 것은 실패를 어떻게 말하느냐뿐이다.
  {
    const bodyOf = (name: string) => src.slice(src.indexOf(`const ${name} = (`), src.indexOf("\n};\n", src.indexOf(`const ${name} = (`)) + 3);
    type Probe = { pids: string[]; error?: string };
    const drive = (probes: Probe[], health: (i: number) => { ok: boolean; why: string }) => {
      let t = 0; let pi = 0; let hi = 0; let healthCalls = 0;
      const fakeDate = { now: () => t };
      const lines: string[] = [];
      const proc = { exitCode: 0 as number | undefined };
      const fns = new Function("sleepSync", "Date", "healthSaysOurs", "winPort", "console", "process",
        `${bodyOf("waitForListening")}\n${bodyOf("reportLaunch")}\nreturn { waitForListening, reportLaunch };`)(
        (ms: number) => { t += ms; }, fakeDate, () => { healthCalls += 1; return health(hi++); }, () => "7021",
        { log: (m: string) => lines.push(`log:${m}`), error: (m: string) => lines.push(`err:${m}`) }, proc,
      ) as { waitForListening: (c: unknown, p: () => Probe) => unknown; reportLaunch: (c: unknown, w: unknown, v: string, h: string) => void };
      const w = fns.waitForListening({}, () => probes[Math.min(pi++, probes.length - 1)] as Probe);
      fns.reportLaunch({}, w, "started", "HINT");
      return { text: lines.join("\n"), code: proc.exitCode, healthCalls };
    };
    const ok = { ok: true, why: "" };
    const refused = { ok: false, why: "no answer (ECONNREFUSED)" };
    const open: Probe = { pids: ["5"] };
    const closed: Probe = { pids: [] };
    const broke: Probe = { pids: [], error: "netstat exited with 1" };
    const cases = {
      success: drive([closed, open], () => ok),
      never: drive([closed], () => ok),
      healthBad: drive([open], () => refused),
      closedAgain: drive([open, open, closed], () => refused),
      lastFailedAfterOpen: drive([open, broke], () => refused),
      lastFailedAfterClosed: drive([closed, broke], () => ok),
      allFailed: drive([broke], () => ok),
      someFailedThenClosed: drive([broke, broke, closed], () => ok),
    };
    const fail = (x: { text: string; code: number | undefined }) => x.code === 1 && !/✅/.test(x.text) && /HINT/.test(x.text);
    const checks: [string, boolean][] = [
      ["성공은 종전대로(포트 PID 그리고 health)", cases.success.code === 0 && /✅ started \(pid 5\)/.test(cases.success.text)],
      ["★포트가 비면 health 를 묻지 않고 성공도 아니다(빈 프로브 + 성공 health)", cases.never.healthCalls === 0 && fail(cases.never) && /bridge port never opened/.test(cases.never.text) && /port 7021, checked for 20s/.test(cases.never.text)],
      ["열렸지만 health 불성립 → 그 이유", fail(cases.healthBad) && /7021 was listening \(PID 5\) but \/health did not answer ok \(no answer \(ECONNREFUSED\)\)/.test(cases.healthBad.text) && !/never opened/.test(cases.healthBad.text)],
      ["열렸다가 닫힘", fail(cases.closedAgain) && /opened, then closed again/.test(cases.closedAgain.text)],
      ["★끝 조회 실패 — 앞의 관측으로 결론 내지 않는다(전에 열림)", fail(cases.lastFailedAfterOpen) && /Could not confirm the daemon is running/.test(cases.lastFailedAfterOpen.text) && /last port check failed \(netstat exited with 1\)/.test(cases.lastFailedAfterOpen.text) && /before that, the bridge port 7021 was listening \(PID 5\)/.test(cases.lastFailedAfterOpen.text) && !/never opened|then closed/.test(cases.lastFailedAfterOpen.text)],
      ["★끝 조회 실패 — 전에 닫힘", fail(cases.lastFailedAfterClosed) && /before that, the bridge port 7021 was not listening/.test(cases.lastFailedAfterClosed.text) && !/never opened/.test(cases.lastFailedAfterClosed.text)],
      ["★한 번도 확인 못 함", fail(cases.allFailed) && /could not be checked even once/.test(cases.allFailed.text)],
      ["중간 조회 실패 후 닫힘 확인 → 안 열림 + 실패 횟수", fail(cases.someFailedThenClosed) && /never opened/.test(cases.someFailedThenClosed.text) && /2 port checks failed/.test(cases.someFailedThenClosed.text)],
    ];
    const bad = checks.filter(([, v]) => !v).map(([n]) => n);
    out.push(
      assert(
        "★기동 확인 실패를 갈라 말한다 — 끝 조회 실패·안 열림·열렸다 닫힘·health 불성립 · 성공 판정 불변(8갈래, 실제 본문)",
        bad.length === 0,
        bad.length === 0 ? "8갈래" : { bad, texts: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.text.slice(0, 260)])) },
      ),
    );

    // ★실제 healthSaysOurs — 진짜 HTTP 응답으로(GPT 코드 검토 R1: 위 검사는 health 를 가짜로 바꿔, 본문 `"ok": true` 조건을 빼도 초록이었다).
    //  healthSaysOurs 는 spawnSync 로 묻는다(이벤트 루프가 멈춘다) — 그래서 답하는 서버는 **별도 프로세스**다.
    const serve = (body: string) =>
      new Promise<{ port: string; stop: () => void }>((resolve, reject) => {
        const ch = spawn(process.execPath, ["-e", `const s=require("http").createServer((q,r)=>{r.statusCode=q.url==="/health"?200:404;r.end(${JSON.stringify(body)})});s.listen(0,"127.0.0.1",()=>console.log(s.address().port))`]);
        ch.once("error", reject);
        ch.stdout.once("data", (d: Buffer) => resolve({ port: String(d).trim(), stop: () => ch.kill() }));
      });
    const health = (port: string) =>
      (new Function("winPort", "spawnSync", "process", `${bodyOf("healthSaysOurs")}; return healthSaysOurs;`)(() => port, spawnSync, process) as (c: unknown) => { ok: boolean; why: string })({});
    const okSrv = await serve('{"ok": true, "version": "fixture"}');
    const badSrv = await serve('{"ok": false}');
    try {
      const closedPort = await (async () => { const s = await serve("x"); s.stop(); await new Promise((r) => setTimeout(r, 150)); return s.port; })();
      const r = { ours: health(okSrv.port), notOk: health(badSrv.port), closed: health(closedPort) };
      out.push(
        assert(
          "★실제 /health 판정: 본문 `\"ok\": true` 면 성공 · 다른 본문은 실패(«HTTP 200 without ok») · 닫힌 포트는 실패(«no answer»)",
          r.ours.ok === true && r.notOk.ok === false && /HTTP 200/.test(r.notOk.why) && /without "ok": true/.test(r.notOk.why) && r.closed.ok === false && /no answer/.test(r.closed.why),
          r,
        ),
      );
    } finally {
      okSrv.stop();
      badSrv.stop();
    }
  }

  // ── ⑤ 의존성-프리 유지 — 확인 때문에 import 가 늘면 최후 복구가 깨진다 ──────
  // ★**표기를 세지 않고 참조를 센다** (2026-08-17, 전체검토 D). 종전 정규식
  //  `/^import .* from "([^"]+)";$/gm` 은 **한 줄 + 쌍따옴표 + 줄 끝 `";`** 만 봤다.
  //  실물의 `node:fs` import 가 여러 줄이라 **원래도 안 세지고 있었다** — detail 이
  //  "import 4개" 라고 실제(5개)보다 적게 보고했다. 게이트가 자기 눈이 좁은 걸 숫자로
  //  드러내고 있었는데 아무도 안 봤다. 그리고 여러 줄 import 로 croner 를 넣으면
  //  8단언이 전부 초록인 채 `bin/daemon.mjs` 가 **실행 불가**가 됐다(실측).
  //  ★`from "…"`·`from '…'`·`await import("…")` 를 전부 훑는다(표기 무관). 주석은 이미
  //   `code` 에서 벗겨져 있으므로 "왜 안 쓰는지" 설명하는 글이 판정을 흔들지 않는다.
  // A bundled sibling is acceptable only when the complete local graph remains
  // builtin-only. A bare/missing/escaping/transitive dependency is still a failure.
  const binRoot = path.join(REPO, "bin");
  const pending = [path.join(binRoot, "daemon.mjs")];
  const seen = new Set<string>();
  const imports: string[] = [];
  const nonBuiltin: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let body: string;
    try { body = stripComments(await readFile(file, "utf8")); }
    catch (e) { nonBuiltin.push(`unreadable: ${file}: ${e}`); continue; }
    const ts = await import("typescript");
    const parsed = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const collect = (node: import("typescript").Node): void => {
      let spec: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) spec = arg.text;
        else nonBuiltin.push(`${file}: nonliteral module`);
      }
      if (spec !== undefined) {
        imports.push(spec);
        if (!spec.startsWith("node:")) {
          const target = path.resolve(path.dirname(file), spec);
          if (!spec.startsWith(".") || !spec.endsWith(".mjs") || !target.startsWith(binRoot + path.sep)) nonBuiltin.push(`${file}: ${spec}`);
          else pending.push(target);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(parsed);
  }
  // ★**0을 세면 그것도 실패다** — 정규식이 낡아 아무것도 못 세면 "비빌트인 0" 이 되어
  //  조용히 통과한다(반대편 오탐). 실물엔 최소 5개가 있으므로 하한을 둔다.
  out.push(
    assert(
      "★import 를 실제로 세고 있다(정규식이 낡아 0을 세면 그것도 실패)",
      imports.length >= 5,
      `${imports.length}개 발견: ${imports.join(", ")}`,
    ),
  );
  out.push(
    assert(
      "★빌트인만 쓴다(깨진 node_modules 에서도 도는 최후 복구 경로)",
      nonBuiltin.length === 0,
      { modules: [...seen].map((f) => path.relative(binRoot, f)), imports, nonBuiltin },
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "daemon-start-is-verified",
  guards:
    "기동 명령만 보내고 `✅ started` 를 찍어 윈도우 데몬이 93분간 죽은 채로 '성공' 이던 것 — 윈도우는 supervisor 가 없어 거짓 성공이 곧 무기한 먹통이다",
  run,
};
