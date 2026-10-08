/**
 * **기본 포트 이동(7010·7011 → 17010·17011) 때 기존 설치는 쓰던 포트를 지킨다** (2026-10-08).
 *
 * ★왜 옮겼나: WSL2·Docker·Hyper-V 를 쓰는 윈도우는 동적 포트 범위가 1024~15000 으로 내려가 있는 일이 흔하고, 윈도우가 그 안에서
 *  100개씩 «예약(제외 범위)» 을 잡는다. 집 윈도우에서 6917~7016 이 잡혀 대시보드·브리지가 `listen EACCES` 로 못 떴다(잘 되던 중에
 *  데몬이 잠깐 꺼진 틈에). 15001~32767 은 윈도우 기본 동적 범위(49152~)·흔히 내려간 범위(~15000)·리눅스 임시 포트(32768~)·
 *  맥 임시 포트(49152~)를 모두 피한다.
 * ★왜 고정하나: 설치는 포트를 `.env` 에 적지 않고 코드 기본값을 따른다(「적어 두는 순간 갈라진다」 — default-port-truth). 그래서
 *  기본값만 바꾸면 기존 사용자의 대시보드 주소·`tailscale serve`·즐겨찾기가 업데이트 순간 조용히 바뀐다.
 *
 * 규칙(한 번만): 홈 `data/ports-settled` 가 있으면 끝. 없으면 —
 *  · DB(`data/tiguclaw.db`)가 이미 있다 = 업데이트 전부터 쓰던 홈 → 포트가 어디에도(홈 `.env`·환경변수) 정해져 있지 않은 쪽만
 *    옛 기본값을 홈 `.env` 에 적는다.
 *  · DB 가 없다 = 새 설치 → 아무것도 안 적는다(새 기본값).
 *  그리고 표시를 남긴다. 표시를 `.env` 밖에 두는 이유: `.env` 없이 쓰던 홈에 나중에 `.env` 가 생겨도 다시 판정하지 않게.
 *
 * ★같은 판단이 `bin/daemon.mjs` 에도 있다 — 그쪽은 의존성 없이 돌아야 해서 코드를 나눌 수 없다(윈도우에서 옛 데몬을 **포트로**
 *  찾아 멈추므로, 업데이트 직후 그 스크립트가 새 기본값으로 옛 데몬을 찾으면 «멈추지 못함» 으로 업데이트가 멈춘다). 두 구현이
 *  같은 결과를 내는지는 회귀 `legacy-ports-settled` 가 같은 입력으로 대조한다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import * as util from "node:util";

export const LEGACY_PORTS: ReadonlyArray<readonly [key: string, port: string]> = [
  ["HTTP_BRIDGE_PORT", "7011"],
  ["DASHBOARD_PORT", "7010"],
];

const parseEnv = (util as { parseEnv?: (s: string) => Record<string, string> }).parseEnv;

/**
 * 기존 설치의 포트를 고정한다 — 적은 키 목록(없으면 빈 배열). 실패는 던지지 않는다(부팅을 막지 않는다).
 * «포트가 이미 정해져 있다» = 홈 `.env` · 레포 `.env`(`repoEnvPath`) · 실제 환경변수 중 어디든 값이 있다 — 데몬이 포트를 읽는 세 곳.
 * ★`.env` 를 process.env 로 올리기 **전에** 부른다 — 여기서 적은 줄이 평소 로드로 들어간다.
 */
export const settleLegacyPorts = (homeAbs: string, repoEnvPath: string, env: NodeJS.ProcessEnv = process.env): string[] => {
  try {
    const dataDir = path.join(homeAbs, "data");
    const marker = path.join(dataDir, "ports-settled");
    if (existsSync(marker)) return [];
    const wrote: string[] = [];
    if (existsSync(path.join(dataDir, "tiguclaw.db"))) {
      const envPath = path.join(homeAbs, ".env");
      let text = "";
      try {
        text = readFileSync(envPath, "utf8");
      } catch {
        /* .env 없음 — 새로 만든다 */
      }
      const parse = (t: string): Record<string, string> => (parseEnv !== undefined ? parseEnv(t) : {});
      const fromFile = parse(text);
      let fromRepo: Record<string, string> = {};
      try {
        if (path.resolve(repoEnvPath) !== path.resolve(envPath)) fromRepo = parse(readFileSync(repoEnvPath, "utf8"));
      } catch {
        /* 레포 .env 없음 */
      }
      const lines: string[] = [];
      for (const [key, port] of LEGACY_PORTS) {
        if ((fromFile[key] ?? "") !== "" || (fromRepo[key] ?? "") !== "" || (env[key]?.trim() ?? "") !== "") continue;
        lines.push(`${key}=${port}`);
        wrote.push(key);
      }
      if (lines.length > 0) {
        const nl = text.includes("\r\n") ? "\r\n" : "\n";
        const head = text === "" || text.endsWith("\n") ? "" : nl;
        appendFileSync(
          envPath,
          head +
            [
              "# The default ports moved to 17010 (dashboard) / 17011 (bridge) — 7010/7011 can fall into a Windows excluded port range.",
              "# This install keeps the ports it was already using. Delete these lines to switch to the new defaults.",
              ...lines,
            ].join(nl) +
            nl,
          "utf8",
        );
      }
    }
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
    if (wrote.length > 0) console.log(`[ports] kept this install's ports in ${path.join(homeAbs, ".env")}: ${wrote.join(", ")}`);
    return wrote;
  } catch (e) {
    console.error(`[ports] could not settle the legacy ports: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
};
