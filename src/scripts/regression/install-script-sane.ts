/**
 * 회귀: **한 줄 설치 스크립트가 반쯤 설치된 상태로 사람을 버리지 않는다.**
 *
 * 이 스크립트는 우리 제품에서 **가장 먼저 실행되는 코드**다. 여기서 조용히 끝나면 사용자는
 * tiguclaw 를 한 번도 못 보고 떠난다 — 그리고 우리는 그 사실을 영영 모른다(신고할 창구가
 * 아직 없다). 다른 어떤 코드보다 "실패해도 다음 행동이 남는가" 가 중요한 자리다.
 *
 * ★실측으로 잡은 결함 (2026-08-11, 작성 직후 실행): `curl … | sh` 는 stdin 이 파이프라
 *  대화형 마법사가 입력을 못 읽는다. 그래서 `/dev/tty` 를 되찾도록 짰는데, 판정을
 *  **`[ -r /dev/tty ]`(존재 확인)** 로 했다. 제어 터미널이 없는 환경(CI·컨테이너·일부 SSH)
 *  에서 그 검사는 **true 를 주고 실제 열기는 실패한다**(`Device not configured`) →
 *  `exec` 가 죽으며 안내문도 못 뿌리고 **종료코드 0 으로 조용히** 끝났다. 의존성은 깔렸는데
 *  다음 할 일을 아무도 모르는 상태 = 스크립트가 막겠다고 적어둔 바로 그 상태.
 *  ★**존재 확인은 판정이 아니다 — 열어보고 갈라야 한다.**
 *
 * ★검사 등급 — ①은 **행동**(`sh -n` 을 실제로 돌린다), ②~⑤는 소스 판정이다. 셸 스크립트라
 *  판정을 모듈로 뽑을 수 없다(그 자체가 배포 산출물이다). 다만 ②는 *구조*를 본다 —
 *  "열기 검사를 쓰는가" 는 동의어로 우회하기 어렵다.
 *
 * ★못 보는 것(정직하게): `install.ps1` 은 **구문 검사조차 못 한다** — 개발 기계에 pwsh 가
 *  없다. 아래는 문자열 대조뿐이고, 진짜 검증은 윈도우 인스턴스에서 실제로 돌리는 것이다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Assertion, RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

/**
 * ★주석을 뺀 **실행되는 줄**만 남긴다. 이 검사가 처음에 그걸 안 해서, 결함을 *설명한*
 *  주석 안의 `[ -r /dev/tty ]` 를 코드로 세고 상시 실패했다 — 이 레포가 이미 한 번
 *  당한 형상이다(주석 안 `<style>` 를 태그로 세던 게이트가 몇 주 빨간불이었다).
 *  **검사 대상은 코드이지 그것을 설명하는 글이 아니다.**
 */
const codeOnly = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const sh = read("install.sh");
  const ps = read("install.ps1");

  // ── ① 실제로 파싱된다 (sh 만 — pwsh 부재) ────────────────────────────────
  {
    let ok = true;
    let detail = "sh -n 통과";
    try {
      execFileSync("sh", ["-n", path.join(REPO, "install.sh")], { stdio: "pipe" });
    } catch (e) {
      ok = false;
      detail = `🔴 구문 오류: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    }
    out.push({ name: "★install.sh 가 실제로 파싱된다(sh -n 실행)", ok, got: detail });
  }

  // ── ② ★tty 는 **열어서** 판정한다 — 존재 확인이 아니다 ──────────────────
  {
    const code = codeOnly(sh);
    const opensIt = /\{\s*:\s*<\s*\/dev\/tty;\s*\}\s*2>\/dev\/null/.test(code);
    const existsOnly = /\[\s*-[re]\s+\/dev\/tty\s*\]/.test(code);
    out.push({
      name: "★/dev/tty 를 열어보고 판정한다(존재 확인은 거짓 양성을 준다)",
      ok: opensIt && !existsOnly,
      got: opensIt
        ? existsOnly
          ? "🔴 존재 확인이 되살아났다"
          : "열기 검사 사용"
        : "🔴 열기 검사 없음 — 제어 터미널 없는 환경에서 조용히 죽는다",
    });
  }

  // ── ③ ★어느 경로로 끝나든 다음 행동이 남는다 ────────────────────────────
  //  `exec` 로 넘기면 실패 시 껍데기가 없어 안내를 낼 수 없다. 그래서 안 쓴다.
  {
    const code = codeOnly(sh);
    const noExecHandoff = !/^\s*exec\s+npm/m.test(code);
    const hasFallback = /npm run onboard/.test(code) && /cd \$DIR/.test(code);
    out.push({
      name: "★마법사를 못 띄워도 다음 명령을 알려준다(조용한 종료 0)",
      ok: noExecHandoff && hasFallback,
      got: `exec 핸드오프 없음=${noExecHandoff} · 폴백 안내=${hasFallback}`,
    });
  }

  // ── ④ 이미 설치된 곳을 덮지 않고, 업데이트는 도구를 가리킨다 ─────────────
  for (const [name, src] of [
    ["install.sh", sh],
    ["install.ps1", ps],
  ] as const) {
    out.push({
      name: `${name}: 기존 설치를 덮지 않고 tiguclaw update 로 안내한다`,
      ok: /\.git/.test(src) && /tiguclaw update/.test(src),
      got: /tiguclaw update/.test(src) ? "기존 설치 감지 + update 안내" : "🔴 덮어쓸 위험",
    });
  }

  // ── ④-2 ★ps1 이 네이티브 명령에 **따옴표 든 인자**를 넘기지 않는다 (2026-08-19 실사고) ──
  //  신고: 설치가 *"Node.js 20 이상이 필요합니다 (지금 v24.19.0)"* 로 멈췄다 — 자기모순이다.
  //  원인은 Node 가 아니라 이 줄이었다:
  //      $nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
  //  **Windows PowerShell(5.1 계열)은 네이티브 명령 인자의 큰따옴표를 이스케이프하지 않는다.**
  //  그래서 node.exe 가 `"` 를 먹고 `split(.)` 을 받아 SyntaxError → 빈 출력 → `[int]` 가 0 →
  //  "버전 부족" 으로 오판. PowerShell 7.3+ 는 동작이 바뀌어 안 터진다 = **기계마다 갈린다**.
  //  같은 코드가 `install.sh` 엔 있어도 멀쩡하다(bash 는 argv 를 그대로 넘긴다).
  //
  //  ★등급: **소스 판정**이다. 이 기계엔 pwsh 가 없고(위 헤더), 있어도 macOS 의 pwsh 7 은
  //   **고쳐진 동작**이라 재현이 안 된다. 그래서 "따옴표를 넘기지 않는다" 는 구조를 본다 —
  //   문법 오류가 아니라 *전달 방식*이 원인이므로 구문 검사로는 원래 못 잡는 부류다.
  {
    // ★주석을 걷어내고 본다 — 위 codeOnly 를 **그대로 쓴다**(같은 판단을 두 벌 두지 않는다).
    //  첫 판이 그걸 안 해서 **이 검사를 설명하는 내 주석**(옛 코드를 인용한 문장)을 잡아
    //  빨간불을 냈다. 이 파일 헤더가 이미 같은 사고를 적어뒀는데 또 밟았다.
    const psCode = codeOnly(ps);
    const risky = [...psCode.matchAll(/^.*\b(node|npm|git)\b[^\r\n]*'[^'\r\n]*"[^'\r\n]*'[^\r\n]*$/gm)].map(
      (m) => m[0].trim(),
    );
    out.push({
      name: "install.ps1: 네이티브 명령에 큰따옴표 든 인자를 넘기지 않는다(PowerShell 이 안 이스케이프한다)",
      ok: risky.length === 0,
      got:
        risky.length === 0
          ? "따옴표 전달 0"
          : `🔴 ${risky.length}곳: ${risky.join(" / ").slice(0, 160)}`,
    });
    out.push({
      name: "install.ps1: node 버전을 PowerShell 안에서 판정한다(node 에 표현식을 안 넘긴다)",
      ok: /node --version/.test(psCode) && !/node -p/.test(psCode),
      got: /node -p/.test(psCode) ? "🔴 node -p 가 남아 있다" : "node --version 파싱",
    });
  }

  // ── ④-3 ★"설치됐다" 를 **종료코드로만** 판단하지 않는다 (2026-08-19 실사고) ────────
  //  사용자 머신에서 `npm ci` 가 **성공했는데**(added 177 packages, ERR 0) 데몬이 부팅마다
  //  죽었다. 원인은 사내 정책 `ignore-scripts=true` — 네이티브 빌드 스크립트가 아예 안 돌아
  //  `better_sqlite3.node` 가 안 생겼다. 설치는 끝난 것처럼 보이고 데몬은 6회 연속 크래시했다.
  //  ★종료코드는 "명령이 실패했나" 지 "결과가 쓸 만한가" 가 아니다 — **열어봐야 안다.**
  //  ★우리 클린룸 검증(sync 스킬 §7)은 이미 `require('better-sqlite3')` 로 실제 로드를
  //   확인하고 있었다. 정작 **사용자가 돌리는 스크립트**에만 없었다 — 우리 설치는 검증하고
  //   사용자 설치는 안 하고 있었던 셈이다(같은 판단이 한쪽에만 있던 것, 오늘 여러 번 본 형상).
  for (const [name, src] of [
    ["install.sh", codeOnly(sh)],
    ["install.ps1", codeOnly(ps)],
  ] as const) {
    out.push({
      name: `${name}: 설치 후 네이티브 모듈을 **실제로 열어** 확인한다`,
      ok: /require\(['"]better-sqlite3['"]\)/.test(src),
      got: /require\(['"]better-sqlite3['"]\)/.test(src)
        ? "로드 확인 있음"
        : "🔴 종료코드만 보고 '설치 완료' 라고 한다",
    });
    out.push({
      name: `${name}: 못 열리면 ignore-scripts 를 원인 후보로 짚는다`,
      ok: /ignore-scripts/.test(src),
      got: /ignore-scripts/.test(src) ? "원인 안내 있음" : "🔴 '빌드 도구' 만 말한다",
    });
  }

  // ── ⑤ 배포 URL 을 가리킨다(개발 기계 경로가 새지 않는다) ─────────────────
  for (const [name, src] of [
    ["install.sh", sh],
    ["install.ps1", ps],
  ] as const) {
    out.push({
      name: `${name}: 공개 레포를 clone 한다(로컬 경로 유출 0)`,
      ok:
        src.includes("https://github.com/tigu77/tiguclaw.git") &&
        !/\/Users\/|C:\\\\Users\\\\[A-Za-z]/.test(src),
      got: src.includes("https://github.com/tigu77/tiguclaw.git")
        ? "공개 URL"
        : "🔴 URL 이 아니거나 로컬 경로",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "install-script-sane",
  guards:
    "한 줄 설치가 제어 터미널 없는 환경에서 안내도 없이 종료 0 으로 끝나 사용자를 반쯤 설치된 상태로 버리던 것(/dev/tty 를 존재 확인으로 판정) + 기존 설치 덮어쓰기·로컬 경로 유출",
  run,
};
