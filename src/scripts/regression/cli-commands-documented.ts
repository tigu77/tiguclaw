/**
 * 회귀: **CLI 명령 목록이 실물과 갈리지 않는다.**
 *
 * 사고 (2026-08-11): 윈도우 신규 설치가 부팅을 못 해 사용자와 내가 `git pull` + `npm ci` 를
 *  손으로 돌렸고, 그게 **멀쩡히 돌던 설치를 깨뜨렸다**(데몬이 네이티브 모듈을 잡고 있어
 *  `EPERM`). 정작 `tiguclaw update` 가 stop→npm ci→build→start+롤백을 이미 하고 있었다.
 *  왜 아무도 안 썼나 — **README 의 명령 목록에 `update` 가 없었다.**
 *    문서: `status | restart | stop | start | logs | doctor | uninstall`
 *    실물: install · uninstall · restart · stop · start · status · logs · print · **update**
 *
 * ★부류: **손으로 관리하는 목록은 조용히 낡는다.** 목록이 틀렸다고 아무도 신고하지 않는다 —
 *  없는 명령은 안 쓰이고, 안 쓰이면 없는 줄 안다. 그래서 사용자는 더 위험한 손 절차로 간다.
 *  고침은 문서에 한 줄 더 적는 게 아니라 **정의점에서 파생시켜 검사**하는 것이다.
 *
 * ★두 레포를 다 본다: dev 는 `_workspace/public-overlay/README.md`, 배포 레포는 루트
 *  `README.md` 다(오버레이가 거기로 복사된다). 한쪽만 읽으면 CI 에서만 빨간불이 된다 —
 *  실제로 2026-08-02 에 그렇게 두 건이 깨졌다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Assertion, RegressionCheck } from "./_framework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

/** 진실 소스 — `bin/tiguclaw.mjs` 의 LIFECYCLE Set 을 **읽어서** 뽑는다(다시 적지 않는다). */
const lifecycleCommands = (): string[] => {
  const src = readFileSync(path.join(REPO, "bin/tiguclaw.mjs"), "utf8");
  const block = /const LIFECYCLE = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (block === null) return [];
  return [...block[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
};

/**
 * 문서에 안 나와도 되는 것 — **이유를 적는다**(조용한 면제 금지).
 * `print` = 서비스 유닛 정의를 stdout 에 찍는 진단용. 사용자가 찾아 쓸 명령이 아니다.
 */
const NOT_USER_FACING = new Set(["print"]);

const readReadme = (): { text: string; from: string } | null => {
  for (const rel of ["_workspace/public-overlay/README.md", "README.md"]) {
    try {
      return { text: readFileSync(path.join(REPO, rel), "utf8"), from: rel };
    } catch {
      /* 다른 쪽 시도 */
    }
  }
  return null;
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const cmds = lifecycleCommands();

  out.push({
    name: "진실 소스(bin/tiguclaw.mjs LIFECYCLE)를 읽어낸다",
    ok: cmds.length >= 8 && cmds.includes("update"),
    got: `${cmds.length}개: ${cmds.join(" · ")}`,
  });

  const readme = readReadme();
  if (readme === null) {
    out.push({
      name: "README 를 찾는다(dev 오버레이 또는 배포 루트)",
      ok: false,
      got: "🔴 양쪽 다 없음",
    });
    return out;
  }

  // ── ★문서에 없는 명령 = 없는 것과 같다 ──────────────────────────────────
  const missing = cmds
    .filter((c) => !NOT_USER_FACING.has(c))
    .filter((c) => !new RegExp(`tiguclaw ${c}\\b|daemon:${c}\\b`).test(readme.text));
  out.push({
    name: "★사용자 대면 CLI 명령이 전부 README 에 있다(없는 명령은 안 쓰인다)",
    ok: missing.length === 0,
    got:
      missing.length === 0
        ? `${readme.from} — 누락 0 (면제: ${[...NOT_USER_FACING].join(", ")})`
        : `🔴 누락: ${missing.join(", ")} (${readme.from})`,
  });

  // ── ★복구 경로가 문서에 있다 — 이번 사고의 핵심 ─────────────────────────
  //  `update` 가 목록에 있기만 하고 "깨졌을 때 이걸 써라" 가 없으면 또 손 절차로 간다.
  out.push({
    name: "★깨졌을 때 쓸 명령이 `tiguclaw update` 라고 적혀 있다",
    ok: /tiguclaw update/.test(readme.text),
    got: /tiguclaw update/.test(readme.text) ? "복구 안내 존재" : "🔴 복구 경로 미기재",
  });

  // ── ★손 절차를 권하지 않는다 ────────────────────────────────────────────
  //  실측: `git pull && npm run daemon:restart` 를 "직접 하려면" 으로 권하고 있었고,
  //  built 모드의 build:prod 는 괄호 각주였다. 그 순서를 따르면 데몬이 안 뜬다.
  out.push({
    name: "★`git pull && …restart` 손 절차를 권하지 않는다(순서를 빠뜨리게 된다)",
    ok: !/git pull && npm run daemon:restart/.test(readme.text),
    got: /git pull && npm run daemon:restart/.test(readme.text)
      ? "🔴 손 절차가 되살아났다"
      : "손 절차 없음",
  });

  return out;
};

export const check: RegressionCheck = {
  name: "cli-commands-documented",
  guards:
    "README 명령 목록에 `update` 가 빠져 있어 복구 명령이 있는 줄도 모르고 사용자와 내가 손으로 git pull+npm ci 를 돌려 멀쩡한 설치를 깨뜨린 것 — 손으로 관리하는 목록이 조용히 낡던 부류",
  run,
};
