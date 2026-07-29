// src/core/version.ts
// 앱 버전 단일 소스 = 레포 루트 package.json 의 "version". 데몬은 유닛 WorkingDirectory
// (=repoRoot)로 돌고 bin/tiguclaw.mjs 도 cwd 를 repoRoot 로 고정하므로 process.cwd() 기준.
// built(dist/src/index.js)여도 cwd 는 repoRoot 라 동일. 1회 읽고 캐시. 실패 시 "unknown".
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

let cached: string | null = null;

/** package.json version (예: "0.13.0"). 읽기 실패 시 "unknown". */
export const appVersion = (): string => {
  if (cached !== null) return cached;
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    cached = typeof v === "string" && v !== "" ? v : "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
};

/**
 * 빌드 식별자 — 지금 이 인스턴스가 **어떤 코드**를 돌고 있나 (2026-07-29).
 *
 * ★버전만으론 알 수 없다. 우리는 싱크를 자주 하되 버전(package.json)은 마일스톤에서만
 *  올린다 — 그래서 "v0.15.0" 인 인스턴스 둘이 실제로는 30커밋 차이일 수 있다. 실제로
 *  같은 증상이 반복될 때 "그쪽이 업데이트를 받았나"를 확인할 방법이 없어 진단이 막혔다.
 *  커밋 해시 + 그 커밋 시각을 함께 보여주면 한 줄로 갈린다.
 *
 * git 이 없거나 배포본이 tarball 이면 ""(표시 생략) — 없는 걸 있는 척하지 않는다.
 */
let cachedBuild: string | null = null;
export const appBuildId = (): string => {
  if (cachedBuild !== null) return cachedBuild;
  try {
    // 동기 1회 — 부팅/명령 경로라 비용 무시. cwd = repoRoot(위 주석과 동일 근거).
    // ★정적 import 를 쓴다 — ESM 에 require 를 쓰면 ReferenceError 가 나는데 아래 catch 가
    //  그걸 삼켜 **조용히 빈 문자열**이 된다(개발 중 실측). best-effort 라도 원인은 남긴다.
    const out = execFileSync("git", ["log", "-1", "--format=%h %cd", "--date=format:%m-%d %H:%M"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    cachedBuild = out;
  } catch (e) {
    // git 부재·tarball 배포 등은 정상 — 다만 첫 실패는 한 줄 남긴다(조용한 빈값 방지).
    console.debug(
      `version: 빌드 식별자 조회 실패(표시 생략): ${e instanceof Error ? e.message : String(e)}`,
    );
    cachedBuild = "";
  }
  return cachedBuild;
};
