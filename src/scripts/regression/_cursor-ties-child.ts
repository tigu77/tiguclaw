/**
 * `cursor-collects-ties` 회귀의 자식 프로브 — 동률 `ts` 를 심어놓고 **끝까지 페이징**해
 * 전수 수집되는지 본다. 스토어 층과 **HTTP 층**을 둘 다 돈다.
 *
 * 왜 두 층인가: 복합 커서는 `chat-log.ts`(SQL)·`http-bridge`(쿼리 파싱)·`history-render.js`
 * (커서 전달) **세 곳이 다 맞아야** 동작한다. 한 곳만 봐도 나머지 둘이 조용히 죽는다 —
 * 실제로 2026-08-23 에 브리지의 파싱을 **살아 있는 핸들러 쪽에서** 잘못 지웠고(일괄 치환이
 * 두 핸들러를 다 잡았다), 회귀 1,613건 중 `beforeId` 를 언급하는 검사가 **0건**이라
 * 아무도 못 봤다. 실측 귀결: 120행 중 96행만 수집 — 24행(20%) 영구 유실.
 */
import { spawn } from "node:child_process";
import {
  bootVerdict,
  freePort,
  reapOnExit,
  seedIsolatedEnv,
} from "./_probe-helpers.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const THREAD = "dashboard:cursor-ties";
const GROUPS = 40; // 동률 그룹 수
const PER = 3; // 그룹당 행 수(같은 ts)
const LIMIT = 7; // 페이지 크기 — 그룹 경계(3)와 서로소여야 경계가 자주 갈린다

const main = async (): Promise<void> => {
  const home = process.env.PROBE_HOME ?? "";
  process.env.TIGUCLAW_HOME = home;
  const { initStore } = await import("../../store/sessions.js");
  initStore();
  const { recordChatMessage, getRecentChatLog } = await import("../../store/chat-log.js");

  const base = 1_700_000_000_000;
  const want = new Set<string>();
  for (let g = 0; g < GROUPS; g += 1) {
    for (let k = 0; k < PER; k += 1) {
      const text = `TIE ${g}-${k}`;
      want.add(text);
      recordChatMessage({
        ts: base + g * 1000, // ★그룹 안은 **같은 ts** — 여기가 복합 커서가 필요한 이유다.
        threadKey: THREAD,
        channel: "http-bridge",
        role: k % 2 === 0 ? "user" : "assistant",
        text,
      });
    }
  }

  /** 클라이언트(`history-render.js`)와 **같은 셈법**으로 끝까지 거슬러 올라간다. */
  const pageStore = (useId: boolean): number => {
    const seen = new Set<string>();
    let ts: number | undefined;
    let id: number | undefined;
    for (let guard = 0; guard < 200; guard += 1) {
      const rows = getRecentChatLog({
        threadKey: THREAD,
        limit: LIMIT,
        ...(ts !== undefined ? { beforeTs: ts } : {}),
        ...(useId && id !== undefined ? { beforeId: id } : {}),
      }) as Array<{ id?: number; ts: number; text: string }>;
      if (rows.length === 0) break;
      for (const r of rows) if (want.has(r.text)) seen.add(r.text);
      const oldest = rows[0]!;
      if (ts === oldest.ts && id === oldest.id) break; // 진전 없음 — 무한루프 방지.
      ts = oldest.ts;
      id = oldest.id;
      if (rows.length < LIMIT) break;
    }
    return seen.size;
  };
  const storeComposite = pageStore(true);
  const storeTsOnly = pageStore(false);

  // ── HTTP 층 — 실제 브리지 핸들러를 통과시킨다 ──────────────────────────────────
  const port = String(await freePort()); // 하드코딩 금지 — 병렬 워크트리가 물린다.
  const token = "cursor-ties-probe";
  seedIsolatedEnv(home, {
    TELEGRAM_BOT_TOKEN: "",
    HTTP_BRIDGE_PORT: port,
    HTTP_BRIDGE_TOKEN: token,
    DASHBOARD_PORT: String(await freePort()),
  });
  const child = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "src/index.ts")], {
    cwd: REPO,
    detached: true,
    env: {
      ...process.env,
      TIGUCLAW_HOME: home,
      TELEGRAM_BOT_TOKEN: "",
      // ★HOST 를 고정한다 — 부팅 판정이 `http://127.0.0.1:<port>` 문자열에 의존하는데
      //  이 키만 안 고정돼 있어서, 바깥에 `HTTP_BRIDGE_HOST=localhost` 가 있으면
      //  브리지는 멀쩡히 떴는데 게이트가 **제품을 지목**했다(실측).
      HTTP_BRIDGE_HOST: "127.0.0.1",
      HTTP_BRIDGE_PORT: port,
      HTTP_BRIDGE_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  reapOnExit(child.pid);
  let childGone = false;
  child.on("exit", () => {
    childGone = true;
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    out += d.toString();
  });
  const end = Date.now() + 60_000;
  while (
    Date.now() < end &&
    !childGone &&
    !/EADDRINUSE/.test(out) &&
    !out.includes(`http-bridge listening on http://127.0.0.1:${port}`)
  ) {
    await sleep(200);
  }
  const verdict = bootVerdict(out, port);
  const booted = verdict.ok;

  let httpSeen = 0;
  let httpErr = "";
  if (booted) {
    try {
      const seen = new Set<string>();
      let ts: number | undefined;
      let id: number | undefined;
      for (let guard = 0; guard < 200; guard += 1) {
        const qs =
          `?limit=${LIMIT}&threadKey=${encodeURIComponent(THREAD)}&token=${token}` +
          (ts !== undefined ? `&beforeTs=${ts}` : "") +
          (id !== undefined ? `&beforeId=${id}` : "");
        const r = await fetch(`http://127.0.0.1:${port}/chat-history${qs}`);
        if (!r.ok) {
          httpErr = `HTTP ${r.status}`;
          break;
        }
        const data = (await r.json()) as {
          entries?: Array<{ id?: number; ts: number; text: string }>;
        };
        const rows = data.entries ?? [];
        if (rows.length === 0) break;
        for (const x of rows) if (want.has(x.text)) seen.add(x.text);
        const oldest = rows[0]!;
        if (ts === oldest.ts && id === oldest.id) break;
        ts = oldest.ts;
        id = oldest.id;
        if (rows.length < LIMIT) break;
      }
      httpSeen = seen.size;
    } catch (e) {
      httpErr = e instanceof Error ? e.message : String(e);
    }
  }
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await sleep(1200);
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }

  console.log(
    JSON.stringify({
      total: want.size,
      storeComposite,
      storeTsOnly,
      booted,
      why: verdict.why,
      httpSeen,
      httpErr,
      tail: out.slice(-250),
    }),
  );
  process.exit(0);
};

void main();
