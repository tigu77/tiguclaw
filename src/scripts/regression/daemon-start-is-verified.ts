/**
 * 회귀: 데몬 기동이 **떴는지 확인하고** 보고한다 — `✅` 를 먼저 찍지 않는다 (2026-08-15).
 *
 * 사고: 윈도우 돌쇠가 `tiguclaw update` 후 **93분간 죽어 있었다**. 그런데 CLI 는
 * `✅ started` 를 찍었다 — `winStart` 가 `wscript` 로 런처를 쏘고 **결과를 안 봤기**
 * 때문이다(`spawnSync(..., {stdio:"ignore"})` 라 실패도 조용하다). 사용자는 "반응이
 * 없다" 로 겪었고, 같은 구조인 회사 인스턴스도 같은 증상이 의심됐다(원격 확인 불가).
 *
 * ★증거의 등급을 정한다: 런처 실행 성공 = **쏜 것**뿐 · PID 존재 = 떴다가 죽는 중일 수
 *  있음 · **브리지 포트 LISTEN = 실제로 서비스 중**. 그래서 포트로 판정한다.
 *
 * ★윈도우에서 특히 치명적: 등록이 `HKCU Run`(로그온 1회)이라 **supervisor 가 없다**.
 *  맥 launchd `KeepAlive`·리눅스 systemd `Restart=` 는 죽으면 되살리지만 윈도우는 한 번
 *  죽으면 그대로 — 거짓 성공이 곧 **무기한 먹통**이다.
 *
 * ★이 파일은 **의존성-프리**다(깨진 node_modules 에서도 도는 최후 복구 경로). 그래서
 *  확인도 빌트인만으로 한다: `Atomics.wait` 로 자고 `netstat` 로 본다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const src = await readFile(path.join(REPO, "bin/daemon.mjs"), "utf8");
  // 주석은 뺀다 — "왜 이렇게 했는지" 설명하는 글이 판정을 흔들면 안 된다(같은 오탐을 오늘 겪었다).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // ── ① 확인 없이 성공을 찍지 않는다 — 세 플랫폼 여섯 자리 ────────────────────
  const bare = [...code.matchAll(/console\.log\(\s*["'`]✅ (started|restarted)["'`]\s*\)/g)];
  out.push(
    assert(
      "★확인 없이 `✅ started/restarted` 를 찍는 자리가 없다",
      bare.length === 0,
      bare.length === 0 ? "무검증 성공 0곳" : `★${bare.length}곳 — 기동 명령만 보내고 성공 보고`,
    ),
  );

  // ── ② 여섯 자리가 전부 검증 경로를 탄다 ────────────────────────────────────
  //  darwin/linux/win × start/restart. 하나라도 빠지면 그 플랫폼에서 사고가 되돌아온다.
  const reports = (code.match(/reportLaunch\(/g) ?? []).length;
  out.push(
    assert(
      "★start·restart 6자리가 모두 검증 후 보고한다(3 플랫폼 × 2)",
      reports === 6,
      `reportLaunch 호출 ${reports}곳 (기대 6)`,
    ),
  );

  // ── ③ 실패는 **실패로** 말한다 ──────────────────────────────────────────────
  out.push(
    assert(
      "★못 뜨면 ✅ 대신 🔴 + exit 1",
      /process\.exitCode = 1;/.test(code) && /🔴 \$\{verb\} 실패/.test(code),
      "실패 경로 확인",
    ),
  );

  // ── ④ 포트 판정이 **OS 별 표기**를 다 본다 ─────────────────────────────────
  //  macOS/BSD 는 `127.0.0.1.3000`(점), 리눅스·윈도우는 `:3000`(콜론). 콜론만 보다가
  //  맥에서 **살아 있는 데몬을 못 찾아 거짓 실패**를 냈다(헬퍼를 넣자마자 첫 시험에서 걸림).
  out.push(
    assert(
      "★포트 매칭이 점·콜론 표기를 모두 본다(맥 netstat 은 점을 쓴다)",
      /\[\.:\]\$\{port\}/.test(code),
      /\[\.:\]\$\{port\}/.test(code) ? "양쪽 표기 확인" : "★콜론만 봄 — 맥에서 거짓 실패",
    ),
  );
  // 경계도 본다 — `:3000` 이 `:30001` 을 맞히면 엉뚱한 프로세스를 데몬으로 오인한다.
  out.push(
    assert(
      "포트 뒤 경계를 본다(3000 이 30001 을 맞히지 않게)",
      /\(\?:\\\\s\|\$\)/.test(code) || /\(\?:\\s\|\$\)/.test(code),
      "경계 확인",
    ),
  );

  // ── ⑤ 의존성-프리 유지 — 확인 때문에 import 가 늘면 최후 복구가 깨진다 ──────
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1] ?? "");
  const nonBuiltin = imports.filter((m) => !m.startsWith("node:"));
  out.push(
    assert(
      "★빌트인만 쓴다(깨진 node_modules 에서도 도는 최후 복구 경로)",
      nonBuiltin.length === 0,
      nonBuiltin.length === 0 ? `import ${imports.length}개 전부 node:` : `★비빌트인: ${nonBuiltin.join(",")}`,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "daemon-start-is-verified",
  guards:
    "기동 명령만 보내고 `✅ started` 를 찍어 윈도우 데몬이 93분간 죽은 채로 '성공' 이던 것 — 윈도우는 supervisor 가 없어 거짓 성공이 곧 무기한 먹통이다",
  run,
};
