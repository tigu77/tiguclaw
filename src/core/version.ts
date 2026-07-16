// src/core/version.ts
// 앱 버전 단일 소스 = 레포 루트 package.json 의 "version". 데몬은 유닛 WorkingDirectory
// (=repoRoot)로 돌고 bin/tiguclaw.mjs 도 cwd 를 repoRoot 로 고정하므로 process.cwd() 기준.
// built(dist/src/index.js)여도 cwd 는 repoRoot 라 동일. 1회 읽고 캐시. 실패 시 "unknown".
import { readFileSync } from "node:fs";
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
