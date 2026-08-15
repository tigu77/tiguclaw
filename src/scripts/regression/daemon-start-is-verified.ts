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
import { stripComments } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const src = await readFile(path.join(REPO, "bin/daemon.mjs"), "utf8");
  // ★주석 제거는 `_wiring.stripComments` 를 **공유**한다 (적대 검토 P13). 여기 있던 자체
  //  구현은 줄 첫머리 `//` 만 걷어서 **줄 끝 주석**에 오탐했다(같은 판정이 세 벌이었고
  //  그중 둘이 약했다).
  const code = stripComments(src);

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

  // ── ④-b ★포트를 잡은 게 **우리 데몬인지** 확인한다 (적대 검토 P7) ────────────
  //  실증: 아무 http 서버가 그 포트를 잡아도 성공으로 읽혔다(mac/linux 는 `netstat -an`
  //  이라 PID 도 없다). "PID 존재 = 죽는 중일 수 있음 · 포트 LISTEN = 서비스 중" 이라고
  //  등급을 적어놨는데 정작 mac/linux 에선 성립하지 않았다. `/health`(인증 밖)로 묻는다.
  out.push(
    assert(
      "★포트만 보지 않고 /health 로 우리 데몬임을 확인한다",
      /healthSaysOurs\(c\)/.test(code) && /"\/health"/.test(code),
      /healthSaysOurs/.test(code) ? "신원 확인 확인" : "★포트만 보고 성공 판정",
    ),
  );
  // ★재시작은 **정착 대기** 후에 잰다 — 옛 데몬이 종료 중 포트를 물고 있으면 그 소켓으로
  //  ✅ 가 찍힌다(옛 데몬도 /health 에 답하므로 신원 확인으로는 못 거른다).
  {
    const settled = (code.match(/waitForListening\(c, listeningOnBridge, 20000, \d+\)/g) ?? []).length;
    out.push(
      assert(
        "★restart 3자리는 정착 대기 후에 잰다(죽어가는 소켓을 성공으로 읽지 않게)",
        settled === 3,
        `정착 대기 있는 자리 ${settled}곳 (기대 3 — darwin·linux·win restart)`,
      ),
    );
  }

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
