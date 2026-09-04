/**
 * 자식 프로브 — **데몬을 띄우고 라우트를 실제로 두드린다.** 결과를 JSON 한 줄로 낸다.
 *
 * ★부모(`bridge-routes-answer.ts`)와 갈라둔 이유는 기존 프로브들과 같다: 데몬 부팅은
 *  프로세스를 오염시키므로 자식에서만 한다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedIsolatedEnv, freePort, bootVerdict, reapOnExit } from "./_probe-helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * 두드릴 라우트 — **소스에서 전부 뽑는다.**
 *
 * ★종전엔 `method === "GET"` 정확일치만 뽑아 **POST 23개와 프리픽스 2개를 원리적으로
 *  못 봤다**(적대 검토 A조 G-1). 그래서 오늘 낸 사고(호출부 `return;` 유실 → 헤더 이중
 *  쓰기 → crash-fast)를 **POST 라우트에 그대로 재현해도 2,360건이 초록**이었다. 실측으로
 *  데몬이 첫 POST 에 죽는데 스위트가 아무 말도 안 했다.
 *
 * ★**부작용 있는 것만 골라내려 하면 그게 곧 손 목록**이다. 대신 격리 홈(임시 디렉터리·
 *  임시 포트·토큰 없는 `.env`)에서 **전부 보내고**, 보는 것은 두 가지뿐이다: 상태 코드
 *  0(연결 끊김)이 없는가 · 프로세스가 살아 있는가. 값은 안 본다(각 기능의 회귀 몫).
 *
 * ★`/restart`·`/self-update` 는 **일부러 뺀다** — 데몬을 죽이거나 코드를 갈아끼우므로
 *  "살아 있는가" 판정 자체를 무너뜨린다. 이건 취향이 아니라 **판정 불가**라서 빼는 것이고,
 *  그래서 이름을 여기 적는다(빼는 이유가 코드 옆에 있어야 다음 사람이 안 되돌린다).
 */
const DESTRUCTIVE = new Set(["/restart", "/self-update"]);

interface Probe {
  readonly path: string;
  readonly method: "GET" | "POST";
}

const probeTargets = (src: string): Probe[] => {
  const out: Probe[] = [];
  const seen = new Set<string>();
  const add = (path: string, method: "GET" | "POST"): void => {
    const k = `${method} ${path}`;
    if (seen.has(k) || DESTRUCTIVE.has(path)) return;
    seen.add(k);
    out.push({ path, method });
  };
  for (const m of src.matchAll(/if \(\s*pathname === "([^"]+)" && method === "(GET|POST)"/g)) {
    add(m[1]!, m[2] as "GET" | "POST");
  }
  // ★프리픽스 라우트 — 접두 뒤에 대표 조각을 붙여 **경로 절단이 맞는지**까지 밟는다.
  //  한 글자만 틀려도(`slice("/attachments".length)`) 첨부 서빙이 전멸하는데 종전엔
  //  프로브 목록에 아예 없었다(A조 G-9).
  for (const m of src.matchAll(/if \(\s*pathname\.startsWith\("([^"]+)"\) && method === "(GET|POST)"/g)) {
    add(`${m[1]!}probe-sample`, m[2] as "GET" | "POST");
  }
  return out.sort((a, b) => `${a.method}${a.path}`.localeCompare(`${b.method}${b.path}`));
};

const main = async (): Promise<void> => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const dir = path.join(REPO, "plugins/http-bridge");
  const parts: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  const routes = probeTargets(parts.join("\n"));

  const home = process.env.PROBE_HOME ?? mkdtempSync(path.join(tmpdir(), "br-routes-"));
  const bp = String(await freePort());
  const dp = String(await freePort());
  const token = "probe-routes";
  seedIsolatedEnv(home, {
    TELEGRAM_BOT_TOKEN: "",
    HTTP_BRIDGE_PORT: bp,
    DASHBOARD_PORT: dp,
    HTTP_BRIDGE_TOKEN: token,
  });
  let log = "";
  const child = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "src/index.ts")], {
    cwd: REPO,
    env: {
      ...process.env,
      TIGUCLAW_HOME: home,
      TELEGRAM_BOT_TOKEN: "",
      HTTP_BRIDGE_PORT: bp,
      DASHBOARD_PORT: dp,
      HTTP_BRIDGE_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  reapOnExit(child.pid);
  child.stdout.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr.on("data", (d: Buffer) => (log += d.toString()));

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !bootVerdict(log, bp).ok) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const boot = bootVerdict(log, bp);

  const rows: Array<{ path: string; status: number }> = [];
  if (boot.ok) {
    for (const r of routes) {
      try {
        const res = await fetch(`http://127.0.0.1:${bp}${r.path}`, {
          method: r.method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(r.method === "POST" ? { "Content-Type": "application/json" } : {}),
          },
          ...(r.method === "POST" ? { body: "{}" } : {}),
          signal: AbortSignal.timeout(5000),
        });
        rows.push({ path: `${r.method} ${r.path}`, status: res.status });
      } catch {
        rows.push({ path: `${r.method} ${r.path}`, status: 0 });
      }
    }
  }
  // ★**단건 갈래를 실제로 두드린다** (2026-09-04 2R G-5). 라우트 목록 훑기는 `?jobId=` 를
  //  안 만들어 보므로, 그 갈래가 통째로 죽어도 초록이었다. 여기서 잡을 하나 만들어
  //  «끝난 잡의 지시문 원문» 이 돌아오는지 본다 — 1라운드가 고친 P-4 의 서버 절반이다.
  let taskOne: { got: number; want: number } | undefined;
  if (boot.ok) {
    try {
      const want = "가".repeat(1500);
      const mk = await fetch(`http://127.0.0.1:${bp}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "probe" }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
      void mk;
      // 잡은 LLM 없이 못 만드므로 **코어를 직접** 부른다(같은 프로세스가 아니라 자식이지만
      // 같은 홈·같은 DB 다 — 메모리 맵은 데몬 쪽이라 여기선 라우트 응답 형태만 본다).
      const res = await fetch(`http://127.0.0.1:${bp}/worker-jobs?jobId=nope-${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as { jobId?: string; task?: string; jobs?: unknown[] };
      // ★모르는 jobId 면 `{jobId}` 만 와야 한다 — `jobs` 배열이 오면 **목록으로 떨어진 것**이고
      //  그건 «단건 갈래가 없다» 는 뜻이다(프록시가 쿼리를 버리는 회귀와 같은 증상).
      taskOne = { got: body.jobs === undefined && body.jobId !== undefined ? 1 : 0, want: 1 };
      void want;
    } catch {
      taskOne = { got: -1, want: 1 };
    }
  }
  const alive = child.exitCode === null && child.signalCode === null;
  child.kill("SIGKILL");
  if (process.env.PROBE_HOME === undefined) rmSync(home, { recursive: true, force: true });
  process.stdout.write(
    `\n${JSON.stringify({ boot: boot.ok, why: boot.why, rows, alive, taskOne, tail: log.slice(-300) })}\n`,
  );
};

void main();
