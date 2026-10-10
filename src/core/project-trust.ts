// src/core/project-trust.ts
/**
 * **이 폴더의 프로젝트 설정(`.mcp.json`·`settings.json` 훅)을 켜도 되나** — 판정은 여기 하나 (2026-10-09 전체 적대 검토 · 정태님 결정).
 *
 * ★사고: 비서가 남의 레포를 받아 그 폴더로 일을 맡기면(`spawn_agent`·매니저의 `path`), 그 레포의 `.mcp.json` 의
 *  `command` 와 `settings.json` 의 훅이 **확인 없이 실행됐다**(`touch PWNED` 로 재현). 레포 내용만으로 명령이 도는 것이다 —
 *  Claude Code 는 프로젝트 MCP·훅에 신뢰 확인을 거친다.
 * ★정태님 결정: *"위임할 때 해당 폴더가 프로젝트가 아닌 경우엔 처음에 승인을 받는 것"*. 그래서 «믿는 폴더» 는 둘뿐이다:
 *  ① 데몬이 도는 폴더(사용자가 거기서 띄웠다) ② **등록된 프로젝트**와 그 안쪽(등록 = 사용자가 고른 것).
 *  그 밖이면 그 폴더의 MCP·훅은 끈 채로 일하고, 비서가 사용자에게 묻는다 — 승인되면 프로젝트로 등록해 켠다.
 *  새 저장소·새 화면을 만들지 않는다: 이미 있는 «등록» 이 곧 신뢰 표시다.
 * ★모르면 안 믿는다 — 저장소를 못 읽으면(초기화 전 등) 데몬 폴더만 믿는다.
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { listProjects } from "../store/projects.js";
import { projectScope, projectScopeLegacy } from "./paths.js";

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export const isTrustedProjectDir = (dir: string): boolean => {
  const d = real(dir);
  if (d === real(process.cwd())) return true;
  try {
    return listProjects().some((p) => isInside(d, real(p.path)));
  } catch {
    return false;
  }
};

/**
 * 믿지 않는 폴더에서 **꺼 둔 것** — 위임 결과에 실어 비서가 사용자에게 물을 재료다. 믿는 폴더면 빈 배열.
 */
export const untrustedProjectAssets = (dir: string): string[] => {
  if (isTrustedProjectDir(dir)) return [];
  const found: string[] = [];
  if (existsSync(path.join(dir, ".mcp.json"))) found.push(".mcp.json");
  for (const f of [projectScope(dir).settings, projectScopeLegacy(dir).settings]) {
    if (existsSync(f)) found.push(path.relative(dir, f));
  }
  return found;
};

/**
 * 위임 응답에 붙일 한 줄 — 꺼 둔 것이 있을 때만. 비서가 이걸 보고 사용자에게 묻는다(묻지 않고 등록하지 않는다).
 */
export const untrustedDelegationNote = (dir: string): string => {
  const off = untrustedProjectAssets(dir);
  if (off.length === 0) return "";
  return (
    `\n⚠ 이 폴더(${dir})는 등록된 프로젝트가 아니라서 그 폴더의 ${off.join("·")} (MCP 서버·훅 = 명령 실행)을 **끈 채로** 진행합니다. ` +
    "필요하면 사용자에게 «이 폴더의 MCP·훅을 켤까요?» 라고 묻고, 승인받으면 project_register 로 등록한 뒤 다시 맡기세요(묻지 않고 등록하지 마세요)."
  );
};
