/**
 * 회귀: **회귀 러너는 홈·cwd 의 `.env` 를 읽지 않는다 — 자식도** (2026-09-23).
 *
 * 사고: 러너가 `import "../../core/load-env.js"` 를 **정적으로** 두고 있었다(2026-09-11 G5 —
 * 지운 `DATA_DIR` 이 나중 로드에 되살아나는 것을 «먼저 태워 버리기» 로 막으려고). ESM 은 정적
 * import 를 본문보다 먼저 평가하므로 그 로드는 임시 홈을 잡기 **전에** 돌았고, 그래서
 * `TIGUCLAW_HOME`(또는 `~/.tiguclaw`)의 **운영 `.env`** 와 **cwd `.env`** 가 스위트 프로세스에
 * 들어왔다. 뒤에서 `DATA_DIR`·일부 튜닝 키를 지워도 나머지(비밀 포함)는 남고, 자식 검사들이
 * 그대로 상속했다. 종전 `data-dir-seal-survives-env-load` 는 이 순서를 **소스 문자열로 강제**
 * 하고 있었다 — 결함을 계약으로 굳힌 검사였다.
 *
 * ★재는 방법 — **실제 러너 사본을 더미 환경에서 돌린다**(소스 순서가 아니라 행동):
 *  - 더미 `TIGUCLAW_HOME`/`~`(HOME·USERPROFILE)/cwd 에 sentinel `.env` 를 두고, 거기
 *    `DATA_DIR=<trap>` 도 심는다. 프로세스 env 에도 `DATA_DIR=<trap>` 을 준다.
 *  - `process.loadEnvFile` 을 `--import` 계측으로 감싼다: **모든 호출을 기록**하고, fixture
 *    루트 밖 경로면 원본을 **부르지 않고** 실패시킨다(운영 `.env` 는 어떤 경우에도 안 열린다).
 *  - 러너 사본 + **실제 `load-env.ts` 사본** + DB 대역 + 검사 하나(제품처럼 `load-env` 를 정적
 *    import 하고, 그것을 import 하는 **자식**을 env 상속으로 띄운다).
 *  판정: 호출 0 · sentinel 0 · `DATA_DIR` 미설정 · 스위치 켜짐 · 홈 = 러너 자기 임시 홈 — 부모·자식 둘 다.
 * ★**대조군**이 같이 돈다: 러너 사본에 옛 정적 import 를 되살리면 **같은 센서가 빨개진다**
 *  (호출 >0, sentinel 유입). 대조군이 초록이면 이 검사는 아무것도 못 보는 것이다.
 * ★제품 정상 경로(스위치 없음)는 **실제 `load-env`** 로 더미 홈·cwd 에서만 잰다 — 홈이 이기고
 *  cwd 가 보완한다. 스위치를 켜면 호출 0 이고 요약 줄이 «disabled» 라고 말한다.
 * ★러너 사본의 DB 는 대역이므로, **실제 `store/sessions.ts`** 를 같은 조건(스위치·`DATA_DIR`
 *  미설정·cwd sentinel)에서 따로 띄워 DB 가 **자기 홈** 아래에 생기는지 본다(대조군: 스위치
 *  없으면 cwd `.env` 의 `DATA_DIR` 로 간다 — 센서가 살아 있음).
 * ★임시 폴더 변수(TMPDIR·TEMP·TMP)는 전부 fixture 안으로 준다 — 러너 사본의 «지난 임시 홈
 *  쓸기» 가 실제 임시 폴더를 훑지 않게.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { probeSpec, spawnProbe, tsxLoaderUrl } from "./_probe-helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Snap {
  sentinels: string[];
  dataDir: string | null;
  flag: string | null;
  noLiveModel: string | null;
  home: string | null;
}

const SNAP_JS =
  "({ sentinels: Object.keys(process.env).filter((k) => k.startsWith('ENVISO_SENTINEL_')).sort()," +
  " dataDir: process.env.DATA_DIR ?? null, flag: process.env.TIGUCLAW_DISABLE_ENV_FILE ?? null," +
  " noLiveModel: process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL ?? null," +
  " home: process.env.TIGUCLAW_HOME ?? null })";

/** `loadEnvFile` 계측 — 모든 호출을 기록하고, fixture 밖이면 원본을 부르지 않는다. */
const INSTRUMENT = [
  'import { appendFileSync } from "node:fs";',
  'import path from "node:path";',
  "const log = process.env.ENVISO_LOG;",
  "const root = process.env.ENVISO_ROOT;",
  "const original = process.loadEnvFile;",
  "process.loadEnvFile = function (p) {",
  '  const abs = path.resolve(p === undefined ? ".env" : String(p));',
  "  const rel = root ? path.relative(root, abs) : '..';",
  "  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);",
  "  appendFileSync(log, JSON.stringify({ pid: process.pid, path: abs, inside }) + '\\n');",
  "  if (!inside) { const e = new Error('ENVISO blocked: ' + abs); e.code = 'ENOENT'; throw e; }",
  "  return original.call(process, p);",
  "};",
  "",
].join("\n");

const readCalls = (log: string): Array<{ path: string; inside: boolean }> =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { path: string; inside: boolean })
    : [];

const lineJson = <T>(out: string, tag: string): T | null => {
  const line = out.split(/\r?\n/).find((l) => l.startsWith(`${tag} `));
  return line === undefined ? null : (JSON.parse(line.slice(tag.length + 1)) as T);
};

const within = (root: string, p: string | null): boolean => {
  if (p === null) return false;
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

export const check: RegressionCheck = {
  name: "regression-runner-env-isolation",
  guards:
    "회귀 러너가 load-env 를 정적 import 해 임시 홈 확정 전에 운영 홈·cwd .env(비밀·DB 경로)를 읽고 자식에 물려주던 것",
  async run(): Promise<Assertion[]> {
    assertIsolated();
    const out: Assertion[] = [];
    // ★실경로로 잡는다 (2026-09-23) — macOS 의 임시 폴더는 `/var` → `/private/var` 심링크라,
    //  자식의 cwd(항상 실경로)와 fixture 루트가 다른 글자가 되어 센서가 cwd `.env` 를 «밖» 으로
    //  판정했다(맥에서만 4건 헛빨강). Windows 에선 그대로다.
    const R = realpathSync(mkdtempSync(path.join(tmpdir(), "runner-env-iso-")));
    try {
      const d = (...p: string[]): string => {
        const full = path.join(R, ...p);
        mkdirSync(full, { recursive: true });
        return full;
      };
      const tmp = d("tmp");
      const trap = path.join(R, "TRAP_LIVE_DATA");
      const presetHome = d("preset-home");
      const osHome = d("os-home");
      const work = d("work");
      writeFileSync(path.join(presetHome, ".env"), `ENVISO_SENTINEL_PRESET_HOME=1\nDATA_DIR=${trap}\n`);
      writeFileSync(path.join(d("os-home", ".tiguclaw"), ".env"), `ENVISO_SENTINEL_OS_HOME=1\nDATA_DIR=${trap}\n`);
      writeFileSync(path.join(work, ".env"), `ENVISO_SENTINEL_CWD=1\nDATA_DIR=${trap}\n`);
      const instrument = path.join(R, "instrument.mjs");
      writeFileSync(instrument, INSTRUMENT);
      const tsx = tsxLoaderUrl(REPO) ?? "tsx";

      // ── fixture 러너 트리: 실제 run.ts·load-env.ts 사본 + DB 대역 + 검사 하나 + 자식 ──
      const runnerSrc = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
      const loadEnvSrc = readFileSync(path.join(REPO, "src/core/load-env.ts"), "utf8");
      const makeTree = (name: string, runner: string): string => {
        const root = d(name);
        const regDir = d(name, "src/scripts/regression");
        writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
        writeFileSync(path.join(d(name, "src/core"), "load-env.ts"), loadEnvSrc);
        writeFileSync(
          path.join(d(name, "src/store"), "sessions.ts"),
          "export const initStore = () => { console.log('ENVISO_STORE ' + JSON.stringify({ home: process.env.TIGUCLAW_HOME ?? null, dataDir: process.env.DATA_DIR ?? null })); };\n" +
            "export const closeStore = () => {};\n",
        );
        writeFileSync(path.join(regDir, "run.ts"), runner);
        writeFileSync(path.join(regDir, "_runtime-preflight.ts"), readFileSync(new URL("./_runtime-preflight.ts", import.meta.url), "utf8"));
        writeFileSync(
          path.join(regDir, "_envprobe-child.ts"),
          `import "../../core/load-env.js";\nconsole.log("ENVISO_CHILD " + JSON.stringify(${SNAP_JS}));\n`,
        );
        writeFileSync(
          path.join(regDir, "envprobe.ts"),
          [
            // ★제품 모듈처럼 **정적으로** load-env 를 탄다 — 러너가 동적 import 하는 순간 평가된다.
            'import { loadHomeEnv } from "../../core/load-env.js";',
            'import { spawnSync } from "node:child_process";',
            'import { fileURLToPath } from "node:url";',
            "export const check = { name: 'envprobe', guards: 'fixture', run: async () => {",
            "  loadHomeEnv();",
            `  console.log("ENVISO_PARENT " + JSON.stringify(${SNAP_JS}));`,
            "  const r = spawnSync(process.execPath, ['--import', process.env.ENVISO_TSX, '--import', process.env.ENVISO_INSTRUMENT,",
            "    fileURLToPath(new URL('./_envprobe-child.ts', import.meta.url))], { env: process.env, encoding: 'utf8', timeout: 30000 });",
            "  console.log(r.stdout ?? '');",
            "  if (r.status !== 0) console.log('ENVISO_CHILD_FAIL ' + JSON.stringify({ status: r.status, err: (r.stderr ?? '').slice(-400) }));",
            "  return [{ name: 'envprobe', ok: true, got: 'ran' }];",
            "} };",
            "",
          ].join("\n"),
        );
        return path.join(regDir, "run.ts");
      };

      const baseEnv = (log: string): NodeJS.ProcessEnv => ({
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot !== undefined ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: osHome,
        USERPROFILE: osHome,
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        DATA_DIR: trap,
        ENVISO_LOG: log,
        ENVISO_ROOT: R,
        ENVISO_TSX: tsx,
        ENVISO_INSTRUMENT: pathToFileURL(instrument).href,
        // ★TIGUCLAW_DISABLE_ENV_FILE 은 **일부러 안 준다** — 러너가 스스로 세워야 한다.
      });

      const runRunner = (runPath: string, env: NodeJS.ProcessEnv) => {
        const r = spawnProbe(REPO, ["--import", pathToFileURL(instrument).href, runPath], {
          cwd: work,
          env,
          timeout: 90_000,
        });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        return {
          status: r.status,
          text,
          parent: lineJson<Snap>(text, "ENVISO_PARENT"),
          child: lineJson<Snap>(text, "ENVISO_CHILD"),
          store: lineJson<{ home: string | null; dataDir: string | null }>(text, "ENVISO_STORE"),
        };
      };

      // ── ① 실제 러너 — 기존 홈 지정(TIGUCLAW_HOME) / 기본 홈(~/.tiguclaw) 두 갈래 ─────
      const realRun = makeTree("tree-real", runnerSrc);
      for (const [label, extra] of [
        ["TIGUCLAW_HOME 지정", { TIGUCLAW_HOME: presetHome }],
        ["기본 홈(~/.tiguclaw)", {}],
      ] as const) {
        const log = path.join(R, `calls-${out.length}.log`);
        const r = runRunner(realRun, { ...baseEnv(log), ...extra });
        const calls = readCalls(log);
        const tail = r.text.slice(-600);
        out.push(
          assert(
            `${label}: 러너 사본이 끝까지 돌고 검사·자식이 실제로 실행됐다(전제)`,
            r.status === 0 && r.parent !== null && r.child !== null && r.store !== null,
            { status: r.status, tail },
          ),
          assert(
            `★★${label}: 러너·자식 어디서도 \`loadEnvFile\` 호출 0 — 홈·cwd \`.env\` 를 열지 않는다`,
            calls.length === 0,
            calls.length === 0 ? "호출 0" : calls.map((c) => c.path),
          ),
          assert(
            `★${label}: sentinel 유입 0 — 부모·자식 둘 다`,
            r.parent?.sentinels.length === 0 && r.child?.sentinels.length === 0,
            { parent: r.parent?.sentinels, child: r.child?.sentinels },
          ),
          assert(
            `${label}: DATA_DIR 미설정(셸이 준 trap 도 걷힘)·스위치 켜짐 — 부모·자식 둘 다`,
            r.parent?.dataDir === null && r.child?.dataDir === null && r.parent?.flag === "1" && r.child?.flag === "1" &&
              r.parent?.noLiveModel === "1" && r.child?.noLiveModel === "1",
            { parent: r.parent, child: r.child },
          ),
          assert(
            `${label}: 홈 = 러너 자기 임시 홈(더미 TMP 안 tiguclaw-regression-*), 자식·DB 대역도 같은 홈`,
            within(tmp, r.parent?.home ?? null) &&
              path.basename(r.parent?.home ?? "").startsWith("tiguclaw-regression-") &&
              r.child?.home === r.parent?.home &&
              r.store?.home === r.parent?.home &&
              r.store?.dataDir === null,
            { parent: r.parent?.home, child: r.child?.home, store: r.store },
          ),
        );
      }
      out.push(assert("trap DATA_DIR 경로가 만들어지지 않았다", !existsSync(trap), trap));

      // ── ② 대조군 — 옛 정적 import 를 되살리면 **같은 센서가** 빨개진다 ──────────────
      //  ★두 갈래 다 — ①의 기본 홈 갈래는 러너가 늘 TIGUCLAW_HOME 을 먼저 세우므로 os-home
      //   sentinel 을 건드릴 기회가 없다. 그 갈래의 센서가 살아 있는지는 여기서만 보인다.
      const mutantRun = makeTree("tree-mutant", `import "../../core/load-env.js";\n${runnerSrc}`);
      for (const [label, extra, homeSentinel] of [
        ["TIGUCLAW_HOME 지정", { TIGUCLAW_HOME: presetHome }, "ENVISO_SENTINEL_PRESET_HOME"],
        ["기본 홈(~/.tiguclaw)", {}, "ENVISO_SENTINEL_OS_HOME"],
      ] as const) {
        const log = path.join(R, `calls-mutant-${out.length}.log`);
        const r = runRunner(mutantRun, { ...baseEnv(log), ...extra });
        const calls = readCalls(log);
        out.push(
          assert(
            `★대조군(${label}): 옛 정적 import 러너는 임시 홈 전에 그 홈·cwd \`.env\` 를 연다(센서가 살아 있다 — 더미 안에서만)`,
            calls.length > 0 &&
              calls.every((c) => c.inside) &&
              (r.parent?.sentinels ?? []).includes(homeSentinel) &&
              (r.parent?.sentinels ?? []).includes("ENVISO_SENTINEL_CWD"),
            { calls: calls.map((c) => c.path), sentinels: r.parent?.sentinels, tail: r.text.slice(-300) },
          ),
        );
      }

      // ── ③ 제품 정상 경로 — 실제 load-env, 더미 홈·cwd 에서만 ─────────────────────────
      const precHome = d("prec-home");
      const precCwd = d("prec-cwd");
      writeFileSync(path.join(precHome, ".env"), "ENVISO_PREC=home\nENVISO_HOME_ONLY=1\n");
      writeFileSync(path.join(precCwd, ".env"), "ENVISO_PREC=cwd\nENVISO_CWD_ONLY=1\n");
      const direct = path.join(R, "direct.mts");
      writeFileSync(
        direct,
        `await import(${probeSpec(REPO, "src/core/load-env.js")});\n` +
          "await new Promise((r) => setTimeout(r, 0));\n" +
          "console.log('ENVISO_DIRECT ' + JSON.stringify({ prec: process.env.ENVISO_PREC ?? null, homeOnly: process.env.ENVISO_HOME_ONLY ?? null, cwdOnly: process.env.ENVISO_CWD_ONLY ?? null }));\n",
      );
      for (const disabled of [false, true]) {
        const log = path.join(R, `calls-direct-${String(disabled)}.log`);
        const env: NodeJS.ProcessEnv = { ...baseEnv(log), TIGUCLAW_HOME: precHome };
        delete env.DATA_DIR;
        if (disabled) env.TIGUCLAW_DISABLE_ENV_FILE = "1";
        const r = spawnProbe(REPO, ["--import", pathToFileURL(instrument).href, direct], {
          cwd: precCwd,
          env,
          timeout: 60_000,
        });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        const v = lineJson<{ prec: string | null; homeOnly: string | null; cwdOnly: string | null }>(text, "ENVISO_DIRECT");
        const calls = readCalls(log);
        out.push(
          disabled
            ? assert(
                "★스위치 켠 실제 load-env: 파일 접근 0 · 값 0 · 요약이 «disabled» 라고 말한다",
                calls.length === 0 &&
                  v !== null && v.prec === null && v.homeOnly === null && v.cwdOnly === null &&
                  /\[env\] env-file loading disabled/.test(text),
                { calls: calls.map((c) => c.path), v, tail: text.slice(-300) },
              )
            : assert(
                "제품 정상 경로(스위치 없음): 홈이 이기고 cwd 가 보완한다 — 더미 두 파일만 열었다",
                calls.length === 2 &&
                  calls.every((c) => c.inside) &&
                  v?.prec === "home" && v.homeOnly === "1" && v.cwdOnly === "1",
                { calls: calls.map((c) => c.path), v, tail: text.slice(-300) },
              ),
        );
      }

      // ── ④ 실제 store — 스위치·DATA_DIR 미설정·cwd sentinel 에서 DB 가 자기 홈에 생긴다 ──
      const store = path.join(R, "store.mts");
      writeFileSync(
        store,
        `await import(${probeSpec(REPO, "src/core/load-env.js")});\n` +
          `const s = await import(${probeSpec(REPO, "src/store/sessions.js")});\n` +
          'const { existsSync } = await import("node:fs");\n' +
          'const path = (await import("node:path")).default;\n' +
          "s.initStore(); const dir = s.resolveDataDir(); s.closeStore();\n" +
          "console.log('ENVISO_REALSTORE ' + JSON.stringify({ dir, db: existsSync(path.join(dir, 'tiguclaw.db')) }));\n",
      );
      for (const disabled of [true, false]) {
        const storeHome = d(`store-home-${String(disabled)}`);
        const storeCwd = d(`store-cwd-${String(disabled)}`);
        const storeTrap = path.join(R, `STORE_TRAP_${String(disabled)}`);
        writeFileSync(path.join(storeCwd, ".env"), `ENVISO_SENTINEL_CWD=1\nDATA_DIR=${storeTrap}\n`);
        const log = path.join(R, `calls-store-${String(disabled)}.log`);
        const env: NodeJS.ProcessEnv = { ...baseEnv(log), TIGUCLAW_HOME: storeHome };
        delete env.DATA_DIR;
        if (disabled) env.TIGUCLAW_DISABLE_ENV_FILE = "1";
        const r = spawnProbe(REPO, ["--import", pathToFileURL(instrument).href, store], {
          cwd: storeCwd,
          env,
          timeout: 60_000,
        });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        const v = lineJson<{ dir: string; db: boolean }>(text, "ENVISO_REALSTORE");
        const calls = readCalls(log);
        out.push(
          disabled
            ? assert(
                "★★실제 store(스위치 켬): DB 가 **자기 홈/data** 에 생기고 cwd `.env` 의 DATA_DIR 로 안 간다 · 파일 접근 0",
                v !== null &&
                  path.resolve(v.dir) === path.join(storeHome, "data") &&
                  v.db &&
                  !existsSync(storeTrap) &&
                  calls.length === 0,
                { v, trap: existsSync(storeTrap), calls: calls.map((c) => c.path), tail: text.slice(-300) },
              )
            : assert(
                "대조군: 스위치가 없으면 같은 프로브가 cwd `.env` 의 DATA_DIR 로 간다(프로브가 격리 실패를 볼 수 있다 — 더미 안에서만)",
                v !== null && path.resolve(v.dir) === storeTrap && calls.every((c) => c.inside),
                { v, calls: calls.map((c) => c.path), tail: text.slice(-300) },
              ),
        );
      }

      // ── ⑤ 실제 `seedIsolatedEnv` — 스위치가 켜지면 레포 `.env` 를 **열지도** 않는다 ─────
      //  `loadEnvFile` 센서로는 원리적으로 안 보이는 경로다(독립 검토 M4 — 거기선 `readFileSync`
      //  로 읽는다). 읽기 계열(`readFileSync`·`openSync` 읽기 모드)을 감싸 `.env` 이름의 시도를
      //  기록하고, 원본을 **부르지 않고** 실패시킨다(레포 `.env` 는 대조군에서도 안 열린다).
      const seed = path.join(R, "seed.mts");
      writeFileSync(
        seed,
        [
          'import { createRequire, syncBuiltinESMExports } from "node:module";',
          'import { fileURLToPath } from "node:url";',
          "const require = createRequire(import.meta.url);",
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          "const hits = [];",
          "const readOrig = fs.readFileSync;",
          "const guard = (name, isRead) => {",
          "  const orig = fs[name];",
          "  fs[name] = function (p, ...rest) {",
          "    if (isRead(rest) && (typeof p === 'string' || p instanceof URL)) {",
          "      const abs = path.resolve(p instanceof URL ? fileURLToPath(p) : p);",
          "      if (path.basename(abs).toLowerCase() === '.env') {",
          "        hits.push({ fn: name, path: abs });",
          "        const e = new Error('ENVISO blocked: ' + abs); e.code = 'ENOENT'; throw e;",
          "      }",
          "    }",
          "    return orig.call(this, p, ...rest);",
          "  };",
          "};",
          "guard('readFileSync', () => true);",
          "guard('openSync', (rest) => rest[0] === undefined || rest[0] === 'r' || rest[0] === 0);",
          "syncBuiltinESMExports();",
          `const { seedIsolatedEnv } = await import(${probeSpec(REPO, "src/scripts/regression/_probe-helpers.js")});`,
          "const home = process.env.ENVISO_SEED_HOME;",
          "seedIsolatedEnv(home, { ENVISO_OWN: '1' });",
          "console.log('ENVISO_SEED ' + JSON.stringify({ hits, content: readOrig(path.join(home, '.env'), 'utf8') }));",
          "",
        ].join("\n"),
      );
      const repoEnv = path.join(REPO, ".env").toLowerCase();
      for (const disabled of [true, false]) {
        const seedHome = d(`seed-home-${String(disabled)}`);
        const env: NodeJS.ProcessEnv = { ...baseEnv(path.join(R, "unused.log")), ENVISO_SEED_HOME: seedHome };
        delete env.DATA_DIR;
        if (disabled) env.TIGUCLAW_DISABLE_ENV_FILE = "1";
        const r = spawnProbe(REPO, [seed], { cwd: work, env, timeout: 60_000 });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        const v = lineJson<{ hits: Array<{ fn: string; path: string }>; content: string }>(text, "ENVISO_SEED");
        out.push(
          disabled
            ? assert(
                "★실제 seedIsolatedEnv(스위치 켬): `.env` 읽기 시도 0 — 레포 `.env` 를 열지 않고 자기 키만 쓴다",
                v !== null && v.hits.length === 0 && v.content.replace(/\r/g, "") === "ENVISO_OWN=1\n",
                { v, tail: text.slice(-300) },
              )
            : assert(
                "대조군: 스위치가 없으면 같은 프로브가 레포 `.env` 읽기 시도를 본다(센서가 살아 있다 — 시도는 막혀 안 열린다)",
                v !== null && v.hits.some((h) => h.path.toLowerCase() === repoEnv),
                { v, tail: text.slice(-300) },
              ),
        );
      }
    } finally {
      rmSync(R, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    return out;
  },
};
