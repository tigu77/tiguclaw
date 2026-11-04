/**
 * 회귀: **자가성장 플러그인을 뺀 뒤 업그레이드 설치본에 남은 것 — 판정표대로 돌고, 읽기만으로는 안 바뀐다** (2026-11-03).
 *
 * 설계: `docs/decisions/2026-11-03-self-growth-plugin-removal-design.md` §6.2 (R1 B·C, R2 A·B 반영 · R3 통과).
 * ★번들 `self-growth` 가 사라지면 그 이름의 예약이 풀린다 — 홈에 같은 이름 폴더가 있는 설치본은 업데이트 순간
 *  «켜진 홈 플러그인 폴더» 가 된다. 자산 훑기(`activePluginDirs`)와 실행 문(`refusalToRun`)이 **다르게** 바뀐다(§3.2 판정표):
 *    자산: ① 켬 = 전에도 보임 · ② 키 없음 = 새로 보임 · ③ 끔 = 계속 숨김
 *    실행: ① 켬 = «같은 이름의 번들» 거절 → 실행 · ② 키 없음 = default-off → 실행 · ③ 끔 = user-disabled 그대로
 *  그래서 설정 3 × 홈 폴더 3(마커·스킬팩·무해한 코드) = **9칸을 따로** 잰다. 하드코딩한 «self-growth 는 꺼짐»·로더 묘비·
 *  끔 설정 무시는 칸 하나씩을 빨갛게 만든다.
 * ★데이터 보존은 두 갈래다(§0 ④): 업데이트·부팅·읽기만으로는 설정·홈 폴더·`SELF_GROWTH.md` 바이트와 DB 보존 값이 **하나도**
 *  안 바뀌고, 사용자가 부른 `confirm_feedback set/retire` 는 **기존 쓰기 계약 그대로**(대상 블록 · set 때만 만료 auto 제거 ·
 *  정규형 재렌더) 바꾼다 — 허용 변화도 «일어나야 한다» 로 잰다.
 * ★**관측 먼저, 단언 나중** — 9칸 관측을 다 모은 뒤 단언한다. `TIGUCLAW_LEFTOVERS_OBS_OUT=<파일>` 이면 관측 JSON 을 거기
 *  쓴다(제거 직전 사본에서 같은 파일을 돌려 전후를 대조하는 1회 실측용 — 거기선 빨강이 정상이다).
 *
 * 등급: **실행** — 칸마다 새 격리 홈을 만들고 자식 프로세스에서 실제 `loadPlugins`·레지스트리 4종·주입·`confirm_feedback` 를 부른다.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProbe } from "./_probe-helpers.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHILD = fileURLToPath(new URL("./_removed-plugin-leftovers-child.ts", import.meta.url));
const MARK = "@@LEFTOVER-OBS@@";
const DAY = 24 * 60 * 60 * 1000;

type Setting = "on" | "unset" | "off";
type Folder = "marker" | "skillpack" | "code";
const SETTINGS: Setting[] = ["on", "unset", "off"];
const FOLDERS: Folder[] = ["marker", "skillpack", "code"];

type Lines = { log: string[]; warn: string[]; error: string[] };
type Obs = {
  crashed?: string;
  bundledLoaded: string[];
  homeLoaded: string[];
  trace: boolean;
  bundledLines: Lines;
  loaderImportLines: Lines;
  homeLines: Lines;
  scanLines: Lines;
  assets: { skills: string[]; agents: string[]; commands: string[]; endpoints: string[] };
  pluginErrors: string[];
  [k: string]: unknown;
};

const settingsBody = (s: Setting): string | undefined =>
  s === "unset" ? undefined : JSON.stringify({ modules: { "self-growth": { enabled: s === "on" } } }, null, 2);

const ASSETS: Record<string, string> = {
  "skills/regr-sg-skill/SKILL.md": "---\nname: regr-sg-skill\ndescription: 남은 폴더의 스킬\n---\n본문\n",
  "agents/regr-sg-agent.md": "---\nname: regr-sg-agent\ndescription: 남은 폴더의 에이전트\n---\n본문\n",
  "commands/regr-sg-cmd.md": "---\ndescription: 남은 폴더의 커맨드\n---\n본문\n",
  "endpoints/regr-sg-ep.md": "---\npath: /regr-sg-ep\ndesc: 남은 폴더의 엔드포인트\n---\n본문\n",
};

/** 홈 `plugins/self-growth/` 를 그 모양으로 채운다. */
const seedFolder = async (home: string, f: Folder): Promise<void> => {
  const dir = path.join(home, "plugins", "self-growth");
  await mkdir(dir, { recursive: true });
  const put = async (rel: string, body: string): Promise<void> => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  };
  if (f === "marker") {
    // 플러그인이 남긴 데이터 폴더(마커 3개, package.json 없음) — 개발돌쇠·테스트돌쇠 홈의 실제 모양.
    for (const m of ["last-review", "outputs-archived", "access-reset-v1"]) await put(m, "1762128000000");
    return;
  }
  for (const [rel, body] of Object.entries(ASSETS)) await put(rel, body);
  if (f === "skillpack") {
    // 메인 돌쇠 홈 모양 — 아는 kind 가 아니라 로더는 건너뛰고(경고), 자산만 의미가 있다.
    await put("package.json", JSON.stringify({ name: "self-growth", private: true, tiguclaw: { plugin: true, kind: "skill-pack" } }));
    return;
  }
  await put(
    "package.json",
    JSON.stringify({ name: "self-growth", private: true, type: "module", tiguclaw: { schemaVersion: 1, kind: ["observer"], name: "self-growth", entry: "./index.mjs" } }),
  );
  // 무해한 코드: 생성될 때 격리 홈에 흔적 파일 하나만 쓴다(네트워크·홈 밖 쓰기 0).
  await put(
    "index.mjs",
    `import { writeFileSync } from "node:fs";\nimport path from "node:path";\n` +
      `export default class P { constructor() { writeFileSync(path.join(process.env.TIGUCLAW_HOME, "home-plugin-ran.txt"), "ran"); } }\n`,
  );
};

const runChild = (home: string, env: Record<string, string>): Obs => {
  // ★`--no-deprecation` — 의존성(grammy→node-fetch→whatwg-url)이 부르는 Node `punycode` 폐기 경고(DEP0040)는 **나중에 비동기로** 찍혀,
  //  번들 플러그인이 적은 공개 트리에선 번들 구간이 아니라 다음 «홈 로드» 포착 구간에 떨어졌다(2026-11-03 v0.82.0 §5 배포 트리 회귀 9건 빨강 —
  //  개발 트리는 번들이 더 많아 초록). 런타임 폐기 경고는 제품 콘솔 줄이 아니고 이 검사가 보는 «제거 뒤 새 경고·오류» 와 무관하다.
  const r = spawnProbe(REPO, ["--no-deprecation", CHILD], {
    cwd: home,
    env: { ...process.env, TIGUCLAW_HOME: home, ...env },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = `${r.stdout ?? ""}`.split("\n").reverse().find((l) => l.startsWith(MARK));
  if (line === undefined) {
    return { crashed: `exit=${String(r.status)} signal=${String(r.signal)} ${`${r.stderr ?? ""}`.slice(-1200)}` } as Obs;
  }
  return JSON.parse(line.slice(MARK.length)) as Obs;
};

/** 폴더 트리의 파일 목록 + 각 바이트(문자열) — 읽기 불변 비교용. */
const treeBytes = async (root: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    let ents: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out[path.relative(root, full)] = (await readFile(full)).toString("base64");
    }
  };
  await walk(root);
  return out;
};

const readOrNull = (p: string): Promise<string | null> => readFile(p).then((b) => b.toString("base64"), () => null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const pick = (d: Record<string, unknown> | undefined): unknown =>
  d === undefined ? null : { key: d.key, text: d.text, source: d.source, group: d.group, createdAt: d.createdAt, updatedAt: d.updatedAt };

export const check: RegressionCheck = {
  name: "removed-plugin-leftovers",
  guards:
    "자가성장 번들을 뺀 뒤 홈에 같은 이름 폴더가 있는 설치본에서 — 자산 훑기·실행 두 문이 판정표와 다르게 바뀌거나(하드코딩 꺼짐·묘비·끔 무시), 새 경고·오류가 나거나, 업데이트·부팅·읽기만으로 설정·홈 폴더·SELF_GROWTH.md·DB 보존 값이 바뀌거나, set/retire 가 기존 쓰기 계약과 다르게 남는 블록을 건드리는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const base = await mkdtemp(path.join(tmpdir(), "removed-leftovers-"));
    try {
      // ── A. 관측 — 9칸 ──────────────────────────────────────────────────────
      const cells: Array<{ s: Setting; f: Folder; obs: Obs }> = [];
      for (const s of SETTINGS) {
        for (const f of FOLDERS) {
          const home = path.join(base, `cell-${s}-${f}`);
          await mkdir(home, { recursive: true });
          const sb = settingsBody(s);
          if (sb !== undefined) await writeFile(path.join(home, "settings.json"), sb);
          await seedFolder(home, f);
          cells.push({ s, f, obs: runChild(home, { LEFTOVER_MODE: "cell" }) });
        }
      }

      // ── B. 관측 — 데이터 보존(설정 ① · 마커 폴더 · 지침 3블록 · DB 픽스처) ──────────
      const dataHome = path.join(base, "data");
      await mkdir(dataHome, { recursive: true });
      await writeFile(path.join(dataHome, "settings.json"), settingsBody("on")!);
      await seedFolder(dataHome, "marker");
      const { renderFile, parseFile } = await import("../../store/self-growth-md.js");
      const now = Date.now();
      await writeFile(
        path.join(dataHome, "SELF_GROWTH.md"),
        renderFile([
          { key: "regr-user-u", text: "사용자 규칙 U", source: "user", createdAt: now - 400 * DAY, updatedAt: now - 200 * DAY },
          { key: "regr-auto-a1", text: "만료된 자동 지침 A1", source: "auto", group: "failure", createdAt: now - 300 * DAY, updatedAt: now - 200 * DAY },
          { key: "regr-auto-a2", text: "유효한 자동 지침 A2", source: "auto", group: "failure", createdAt: now - 20 * DAY, updatedAt: now - 10 * DAY },
        ]),
      );
      const snap = async (): Promise<unknown> => ({
        settings: await readOrNull(path.join(dataHome, "settings.json")),
        folder: await treeBytes(path.join(dataHome, "plugins", "self-growth")),
        growthMd: await readOrNull(path.join(dataHome, "SELF_GROWTH.md")),
      });
      // ★파일 기준은 **어떤 부팅보다도 먼저** 뜬다 — seed 뒤에 뜨면 첫 부팅이 지운 것이 기준이 된다(변이 ⓐ 가 그렇게 살아남았다).
      const before = await snap();
      // DB 기준 — seed 는 행을 심기만 한다(로더·훑기 없음).
      const seeded = runChild(dataHome, { LEFTOVER_MODE: "data", LEFTOVER_STAGE: "seed" });
      const parsedBefore = parseFile(Buffer.from((before as { growthMd: string }).growthMd, "base64").toString("utf8"));
      const read = runChild(dataHome, { LEFTOVER_MODE: "data", LEFTOVER_STAGE: "read" });
      const afterRead = await snap();
      const write = runChild(dataHome, { LEFTOVER_MODE: "data", LEFTOVER_STAGE: "write" });
      const afterWrite = await snap();

      const observation = { cells: cells.map((c) => ({ setting: c.s, folder: c.f, ...c.obs })), data: { seeded, read, write } };
      const obsOut = process.env.TIGUCLAW_LEFTOVERS_OBS_OUT;
      if (obsOut !== undefined && obsOut !== "") await writeFile(obsOut, JSON.stringify(observation, null, 2));

      // ── 단언 — A ──────────────────────────────────────────────────────────
      for (const { s, f, obs } of cells) {
        const tag = `[${s}×${f}]`;
        if (obs.crashed !== undefined) {
          out.push(assert(`${tag} 칸 자식이 끝까지 돌았다`, false, obs.crashed));
          continue;
        }
        out.push(assert(
          `${tag} 로더 최초 import 의 새 warn/error 0`,
          obs.loaderImportLines.warn.length === 0 && obs.loaderImportLines.error.length === 0,
          obs.loaderImportLines,
        ));
        const runs = f === "code" && s !== "off";
        const seen = f !== "marker" && s !== "off";
        // 새 경고가 날 수 있는 면 = 홈 뿌리 로드 + 자산 훑기. 번들 뿌리의 다른 줄(브리지 임시 토큰 안내·Node 폐기 경고 등)은
        //  이 제거와 무관한 기존 줄이라 여기서 세지 않는다 — 전후 0 차이는 1회 실측 diff(층 3)가 본다.
        const allWarn = [...obs.homeLines.warn, ...obs.scanLines.warn];
        const allErr = [...obs.homeLines.error, ...obs.scanLines.error];
        const detail = { homeLoaded: obs.homeLoaded, trace: obs.trace, homeLines: obs.homeLines, assets: obs.assets };
        out.push(
          assert(
            `${tag} 번들 뿌리에 self-growth 가 없다 — 로드 목록에도, 로더 줄에도`,
            !obs.bundledLoaded.includes("self-growth") &&
              ![...obs.bundledLines.log, ...obs.bundledLines.warn, ...obs.bundledLines.error].some((l) => l.includes("self-growth")),
            { bundledLoaded: obs.bundledLoaded, lines: obs.bundledLines },
          ),
        );
        out.push(
          assert(
            `${tag} 실행 — ${runs ? "홈 코드가 **실행된다**(흔적·로드 목록)" : f === "code" ? "끈 설정이면 실행 0 · 사유 user-disabled" : "로드 0"}`,
            runs
              ? obs.trace && same(obs.homeLoaded, ["self-growth"])
              : !obs.trace && obs.homeLoaded.length === 0 &&
                  (f !== "code" || obs.homeLines.log.filter((l) => l === "[plugin-loader] skip self-growth: user-disabled").length === 1),
            detail,
          ),
        );
        out.push(
          assert(
            `${tag} 자산 발견 — ${seen ? "스킬·에이전트·커맨드·엔드포인트 각 1개가 그 폴더 출처로 보인다" : "0개"}`,
            same(
              obs.assets,
              seen
                ? { skills: ["regr-sg-skill"], agents: ["regr-sg-agent"], commands: ["regr-sg-cmd"], endpoints: ["regr-sg-ep"] }
                : { skills: [], agents: [], commands: [], endpoints: [] },
            ),
            obs.assets,
          ),
        );
        out.push(assert(`${tag} plugin.error 이벤트 0`, obs.pluginErrors.length === 0, obs.pluginErrors));
        const expectWarn =
          f === "skillpack"
            ? ["[plugin-loader] self-growth: kind 에 알 수 없는 값 [\"skill-pack\"] — 아는 값은 ["]
            : [];
        out.push(
          assert(
            `${tag} warn 줄 집합 = 기대와 정확히 같다(${f === "skillpack" ? "기존 «kind 에 알 수 없는 값» 1줄" : "0줄"} · 특히 «같은 이름의 번들» 0) · error 줄 0`,
            allWarn.length === expectWarn.length && expectWarn.every((p, i) => allWarn[i]!.startsWith(p)) && allErr.length === 0,
            { warn: allWarn, error: allErr },
          ),
        );
        if (f === "marker") {
          out.push(
            assert(
              `${tag} 정보 로그 — «package.json 이 없어 플러그인이 아닙니다» 1줄`,
              obs.homeLines.log.filter((l) => l.startsWith("[plugin-loader] self-growth: package.json 이 없어 플러그인이 아닙니다")).length === 1,
              obs.homeLines.log,
            ),
          );
        }
      }

      // ── 단언 — B ──────────────────────────────────────────────────────────
      const crashed = [seeded, read, write].find((o) => o.crashed !== undefined);
      if (crashed !== undefined) {
        out.push(assert("데이터 보존 자식이 끝까지 돌았다", false, crashed.crashed));
        return out;
      }
      const injected = String(read.injected ?? "");
      out.push(
        assert(
          "B1 읽기 — 주입에 세 블록 다 실린다(읽기는 만료를 거르지 않는다) · list 에 세 key",
          ["사용자 규칙 U", "만료된 자동 지침 A1", "유효한 자동 지침 A2"].every((t) => injected.includes(t)) &&
            ["regr-user-u", "regr-auto-a1", "regr-auto-a2"].every((k) => String(read.list ?? "").includes(k)),
          { injected, list: read.list },
        ),
      );
      out.push(
        assert(
          "★B1 읽기 불변 — 업데이트·부팅·읽기만으로 settings.json·홈 plugins/self-growth 트리·SELF_GROWTH.md 바이트가 그대로다",
          same(before, afterRead),
          same(before, afterRead) ? "동일" : { before, afterRead },
        ),
      );
      out.push(
        assert(
          "★B1 읽기 불변 — DB 보존 행·열 값이 그대로다(memories 성장 행 전 열·접근 카운터 포함 · skill_usage 결과 열)",
          same(seeded.db, read.db) && (seeded.db as { memories: unknown[] }).memories.length === 2,
          { seeded: seeded.db, read: read.db },
        ),
      );
      const afterSet = (write.afterSet ?? []) as Array<Record<string, unknown>>;
      const afterRetire = (write.afterRetire ?? []) as Array<Record<string, unknown>>;
      const byKey = (list: Array<Record<string, unknown>>, k: string) => list.find((d) => d.key === k);
      const pb = parsedBefore as unknown as Array<Record<string, unknown>>;
      out.push(
        assert(
          "B2 set — 허용: B 추가 · 만료 auto A1 제거 / 보호: U(200일 지났어도 user)·A2 의 파싱 값이 그대로",
          (write.set as { isError?: boolean } | undefined)?.isError === false &&
            same(afterSet.map((d) => d.key).sort(), ["regr-auto-a2", "regr-new-b", "regr-user-u"]) &&
            same(pick(byKey(afterSet, "regr-user-u")), pick(byKey(pb, "regr-user-u"))) &&
            same(pick(byKey(afterSet, "regr-auto-a2")), pick(byKey(pb, "regr-auto-a2"))),
          { set: write.set, afterSet },
        ),
      );
      out.push(
        assert(
          "B2 retire — 허용: A2 제거 / 보호: U·B 파싱 값이 직전과 같다(retire 는 만료·상한을 다시 걸지 않는다)",
          (write.retire as { isError?: boolean } | undefined)?.isError === false &&
            same(afterRetire.map((d) => d.key).sort(), ["regr-new-b", "regr-user-u"]) &&
            same(pick(byKey(afterRetire, "regr-user-u")), pick(byKey(afterSet, "regr-user-u"))) &&
            same(pick(byKey(afterRetire, "regr-new-b")), pick(byKey(afterSet, "regr-new-b"))),
          { retire: write.retire, afterRetire },
        ),
      );
      out.push(
        assert(
          "B2 재렌더 — 파일이 그때의 머리글 + 정규형(renderFile 결과와 바이트 동일)",
          write.selfGrowthBody === renderFile(afterRetire as never),
          String(write.selfGrowthBody ?? "").slice(0, 400),
        ),
      );
      const { growthMd: _b, ...beforeRest } = before as Record<string, unknown>;
      const { growthMd: _w, ...writeRest } = afterWrite as Record<string, unknown>;
      out.push(
        assert(
          "B2 두 쓰기 내내 설정·홈 폴더 바이트와 DB 보존 값은 그대로다",
          same(beforeRest, writeRest) && same(seeded.db, write.db),
          { settingsFolderSame: same(beforeRest, writeRest), dbSame: same(seeded.db, write.db) },
        ),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
    return out;
  },
};
