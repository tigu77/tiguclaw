/**
 * 부팅 프로브 공용 헬퍼 — **한 벌만 둔다.**
 *
 * ★두 자식 프로브(`_ephemeral-wiring-child`·`_cursor-ties-child`)에 77줄이 **바이트 단위로
 *  복붙**돼 있었다. `parseSlashCommand` 를 "두 벌이면 갈린다" 며 하나로 만든 **바로 그
 *  커밋**이 새 판정 로직을 두 벌로 만들었다 — 실제로 5라운드에서 두 결함(`export ` 접두
 *  누락·`HTTP_BRIDGE_HOST` 미고정)을 한쪽만 고쳤으면 조용히 갈렸을 자리다.
 *  [[feedback_hand_maintained_lists]] · [[feedback_simple_composable_no_duplication]]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * 격리 홈에 `.env` 를 만든다 — **레포 `.env` 를 차단**하기 위해서다 (2026-08-23 4라운드).
 *
 * `load-env` 는 `<home>/.env` → `<cwd>/.env`(레포) 순으로 읽고 "이미 있는 키는 안 덮는다".
 * 프로브 데몬은 `cwd=REPO` 로 뜨므로, 홈이 안 채운 키는 **dev `.env` 가 채운다**. 실측:
 * `REGION_A_MODELS` 가 그렇게 새어 들어와 프로브가 **매 스위트 실행마다 진짜 유료 LLM
 * 턴을 띄웠다 버렸다**(러너가 `process.env` 에서 봉인해도 소용없다 — 파일 폴백이라).
 * 그래서 레포 `.env` 의 **키 이름만** 읽어 전부 빈 값으로 홈에 선점한다(손 목록 없음 —
 * 레포에 키가 늘면 자동으로 따라간다). CI 처럼 레포 `.env` 가 없으면 아무 일도 안 한다.
 */
export const seedIsolatedEnv = (home: string, own: Record<string, string>): void => {
  const lines: string[] = [];
  try {
    const repoEnv = readFileSync(path.join(REPO, ".env"), "utf8");
    for (const line of repoEnv.split("\n")) {
      // `export KEY=값` 도 잡는다 — `loadEnvFile` 은 이 접두를 지원하는데 우리 파서만
      // 못 봐서 그 키가 선점되지 않고 레포 값이 샜다(2026-08-24 실측).
      // ★Node 의 `loadEnvFile` 과 **같은 범위**로 판다 (2026-08-24 6라운드).
      //  종전엔 `[A-Za-z_][A-Za-z0-9_]*` 만 봐서 `A-B=`·`A.B=`·`0LEAD=` 를 놓쳤다
      //  (Node 는 받는다) — 그런 키가 레포 `.env` 에 있으면 선점이 안 돼 값이 샌다.
      //  한 포맷에 파서 두 벌이면 갈린다는 게 이 파일 머리말의 요지다.
      const m = /^\s*(?:export[ \t]+)?([^\s=#][^=]*?)\s*=/.exec(line);
      if (m !== null && own[m[1]!] === undefined) lines.push(`${m[1]}=`);
    }
  } catch {
    /* 레포 .env 없음(배포본·CI) — 차단할 것도 없다 */
  }
  for (const [k, v] of Object.entries(own)) lines.push(`${k}=${v}`);
  writeFileSync(path.join(home, ".env"), `${lines.join("\n")}\n`);
};

/** 사용 가능한 포트를 커널에서 받는다 — 하드코딩하면 워크트리 병렬 실행이 충돌한다. */
export const freePort = async (): Promise<number> => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const a = srv.address();
  const p = typeof a === "object" && a !== null ? a.port : 0;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
};

/**
 * 부팅 판정 — `"ready"` 문자열만 보면 **거짓 초록**이 난다 (2026-08-23 4라운드 F2).
 * `loadPlugins` 실패는 `src/index.ts` 에서 catch 되고 ready 는 그대로 찍힌다. 포트를
 * 누가 잡고 있으면 http-bridge 가 안 뜬 채 ready → SSE 0 → 검사가 "명령 버블이 영구히
 * 굳는다" 며 **멀쩡한 제품을 지목**한다. 환경 실패와 제품 실패를 갈라서 말한다.
 */
export const bootVerdict = (
  out: string,
  port: string,
): { ok: boolean; why: string } => {
  // ★**브리지가 떴는가**가 유일한 판정이다. 다른 플러그인의 실패까지 부팅 실패로 치면
  //  러너의 env 봉인 때문에 스킵되는 플러그인 하나에도 게이트가 빨간불이 된다(실측:
  //  단독 실행은 120/120 인데 스위트 안에서만 "부팅 실패"). 넓은 판정은 좁은 판정보다
  //  안전해 **보이지만**, 오탐이 잦으면 "환경 문제" 로 분류돼 결국 아무도 안 본다.
  if (out.includes(`http-bridge listening on http://127.0.0.1:${port}`)) {
    return { ok: true, why: "부팅·브리지 확인" };
  }
  if (/EADDRINUSE/.test(out)) {
    return { ok: false, why: `★환경: 포트 ${port} 를 누가 잡고 있다(제품 결함 아님)` };
  }
  const m = /.*(?:plugin-loader|loadPlugins failed|start failed).*/.exec(out);
  if (m !== null) return { ok: false, why: `★브리지 미기동: ${m[0].slice(0, 160)}` };
  if (!out.includes("tiguclaw daemon: ready")) {
    return { ok: false, why: `★부팅 실패 · ${out.slice(-200)}` };
  }
  return { ok: false, why: `★ready 는 찍혔는데 브리지가 ${port} 를 안 잡았다 · ${out.slice(-160)}` };
};

/**
 * 자식(데몬)을 반드시 거둔다 — `spawnSync` 타임아웃으로 **이 프로세스가** SIGTERM 을
 * 받으면 아래 정리 코드가 안 돌아 손자가 ppid=1 로 살아남는다(실측: 포트를 계속 LISTEN
 * 하고, 부모가 임시 홈을 지운 뒤에도 DB 없는 채로 돈다 → 그 머신에서 이 게이트는 영구
 * 빨간불). 시그널·exit 어디로 나가든 그룹을 죽인다.
 */
export const reapOnExit = (pid: number | undefined): void => {
  if (pid === undefined) return;
  const kill = (): void => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* 이미 죽음 */
    }
  };
  process.on("SIGTERM", () => {
    kill();
    process.exit(1);
  });
  process.on("SIGINT", () => {
    kill();
    process.exit(1);
  });
  process.on("exit", kill);
};

