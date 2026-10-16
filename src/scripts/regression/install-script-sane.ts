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
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Assertion, RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

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
    // ★`npm` 을 **리터럴로** 요구하지 않는다 (2026-09-09). 전용 Node 를 쓰는 설치본에선
    //  그 사람 셸에 `npm` 이 없어서, 안내가 `$NPM_CMD`(절대경로)로 나가야 실제로 돌아간다.
    //  이 검사가 지키려는 성질은 «어느 경로로 끝나든 다음 행동이 남는가» 이지 «그 문자열이
    //  적혀 있는가» 가 아니다 — 리터럴을 요구하면 옳은 수정을 막는다.
    const hasFallback = /\$RETRY_CD && \$NPM_SHOW run onboard/.test(code);
    out.push({
      name: "★마법사를 못 띄워도 다음 명령을 알려준다(조용한 종료 0)",
      ok: noExecHandoff && hasFallback,
      got: `exec 핸드오프 없음=${noExecHandoff} · 폴백 안내=${hasFallback}`,
    });

    // ★안내한 명령이 **새 셸에서 실제로 돈다** (2026-10-16 아스트라 «초보자 설치 검토» 2번). 종전엔 npm 절대경로를
    //  적었는데 npm 첫 줄이 `#!/usr/bin/env node` 라 시스템 node 가 없는 셸에선 127 이었다 — 문자열 검사로는 초록.
    //  그래서 install.sh 의 안내 변수 블록을 그대로 떼어 돌리고, 나온 명령을 **node 없는 PATH** 에서 실행한다.
    //  설치 폴더엔 공백·`$`·작은따옴표를 넣는다(인용 — 재검토 2차 P6). 가짜 npm·npx 는 진짜와 같은 shebang 이고, 시스템 PATH 를
    //  잃었으면 실패한다(`:$PATH` 를 빼면 사용자 셸의 다른 명령이 사라진다 — 변이 M8 이 살아남았던 자리).
    //  «이미 설치됨» 의 업데이트 안내도 같은 방식으로 돌린다(재검토 2차 P5 — 다섯 번째 자리).
    const lines = sh.split("\n");
    const shqLine = lines.find((l) => /^shq\(\) \{/.test(l)) ?? "";
    const blockOf = (start: RegExp, end: RegExp): string => {
      const from = lines.findIndex((l) => start.test(l));
      const to = from >= 0 ? lines.findIndex((l, i) => i > from && end.test(l)) : -1;
      return from >= 0 && to > from ? lines.slice(from, to + 1).join("\n") : "";
    };
    const block = blockOf(/^RETRY_CD=/, /^fi$/);
    const updBlock = blockOf(/^\s*UPDATE_CMD="cd /, /^\s{4}fi$/);
    const iso = mkdtempSync(path.join(tmpdir(), "retry-cmd-"));
    try {
      const dir = path.join(iso, "my $HOME 'tc' tiguclaw");
      const bin = path.join(dir, ".node", "bin");
      mkdirSync(bin, { recursive: true });
      symlinkSync(process.execPath, path.join(bin, "node"));
      const fake = (name: string): string =>
        `#!/usr/bin/env node\nif (!(process.env.PATH ?? "").split(":").includes("/usr/bin")) { console.log("lost system PATH"); process.exit(3); }\nconsole.log("${name}-ran " + process.argv.slice(2).join(" ") + " @" + process.cwd());\n`;
      writeFileSync(path.join(bin, "npm"), fake("npm"), { mode: 0o755 });
      writeFileSync(path.join(bin, "npx"), fake("npx"), { mode: 0o755 });
      const show = (b: string, expr: string): string => execFileSync("/bin/sh", ["-c", `${shqLine}\n${b}\nprintf '%s' "${expr}"`], {
        env: { PATH: "/usr/bin:/bin", DIR: dir, NODE_DIR: path.join(dir, ".node"), NEED_NODE: "1" },
        encoding: "utf8",
      });
      const runIt = (cmd: string): string => {
        try {
          return execFileSync("/bin/sh", ["-c", cmd], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim();
        } catch (e) {
          return `rc=${(e as { status?: number }).status} ${String((e as { stdout?: string }).stdout ?? "").trim()} ${String((e as { stderr?: string }).stderr ?? "").trim()}`;
        }
      };
      const ran = runIt(show(block, "$RETRY_CD && $NPM_SHOW run onboard"));
      const upd = runIt(show(updBlock, "$UPDATE_CMD"));
      // 안내 네 자리(의존 설치 실패 · 네이티브 재빌드 · 마법사 멈춤 · 마지막 안내)가 전부 이 명령 모양을 쓴다.
      const uses = (code.match(/\$RETRY_CD && \$NPM_SHOW (ci|rebuild|run onboard)/g) ?? []).length;
      out.push({
        name: "★전용 Node 설치의 재시도·업데이트 명령이 node 없는 새 셸에서 그대로 돈다(공백·$·따옴표 경로 · 시스템 PATH 유지) · 안내 네 자리가 같은 명령 모양",
        ok: block !== "" && updBlock !== "" && shqLine !== "" &&
          ran === `npm-ran run onboard @${realpathSync(dir)}` && upd === `npx-ran tiguclaw update @${realpathSync(dir)}` && uses >= 4 && !/\$NODE_DIR\/bin\/npm/.test(code),
        got: `실행=${ran.slice(0, 120)} · 업데이트=${upd.slice(0, 120)} · 안내 자리=${uses}`,
      });
    } finally {
      rmSync(iso, { recursive: true, force: true });
    }
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
  //  ★사용자 지정 (2026-08-19): "한 줄 설치나 업데이트나 다 동일하게 잘 설치되도록 하자."
  //   그래서 **세 경로**(한 줄 설치 sh/ps1 · `tiguclaw update`)를 같은 잣대로 본다 —
  //   하나만 고치면 또 갈린다(오늘 하루에 이 형상을 다섯 번 봤다).
  //  ★그리고 감지에서 멈추지 않는다: **스스로 한 번 고쳐본다**(npm rebuild). 사용자가
  //   명령 세 줄을 외워야 하면 그건 도구가 일을 안 한 것이다.
  // ★대상을 **손으로 적지 않는다** (2026-08-20 적대 검토 B-F1). 종전엔 이 목록이
  //  `install.sh`·`install.ps1`·`bin/daemon.mjs` 세 줄이었는데, 실제 설치 경로는 **다섯**이고
  //  빠진 둘이 하필 `bin/tiguclaw.mjs`(clone 후 onboard)와 `src/core/self-update.ts`
  //  (**unix 의 `/update` 본체**)였다. 그 둘엔 보호가 하나도 없었고 검사는 초록이었다.
  //  ★목록을 판정으로 바꾼다: "npm 으로 의존성을 설치하는 파일" 이면 대상이다.
  //   새 설치 경로가 생기면 저절로 걸린다 — 그게 이 사고의 재발 조건이었다.
  // ★후보를 **레포에서 발견한다** (2026-08-20 재검토 F4). 종전엔 바로 위 주석이
  //  "목록을 판정으로 바꾼다" 고 적어놓고 정작 후보 여섯 줄을 **손으로 적고** 있었다 —
  //  판정으로 바뀐 건 *필터*뿐이고 *후보 집합*은 그대로 손 목록이었다. 그리고 단언 이름은
  //  "손으로 열거하지 않는다" 라고 말하고 있었으니, **검사가 자기에 대해 거짓을 말한** 셈이다.
  //  (이 목록을 만든 게 바로 "손 목록이 빠뜨려서 사고가 났다" 를 고치는 커밋이었다.)
  //  진실 소스는 `git ls-files` — `shipped-repo-complete.ts` 와 같은 근거로 파일시스템이
  //  아니라 추적 파일이다(빌드 산출물·미추적물이 섞이면 판정이 흐려진다).
  const INSTALL_CANDIDATES = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(sh|ps1|mjs|ts)$/.test(f))
    // 회귀 자신과 작업 스크래치는 제외 — 검사 픽스처가 자기를 대상으로 세면 순환이다.
    .filter((f) => !f.startsWith("src/scripts/regression/") && !f.startsWith("_workspace/"));
  const installers: Array<readonly [string, string]> = [];
  for (const f of INSTALL_CANDIDATES) {
    const body = codeOnly(read(f));
    // 의존성을 **설치하는** 파일만(안내문에 명령을 적기만 한 파일은 제외).
    // ★`npm` 을 **실제로 부르는** 것만. 종전 판은 `"install"` 문자열만 봐서
    //  `case "install": runDaemon("install")`(데몬 supervisor 등록)까지 설치자로 오탐했다 —
    //  검사가 켜지자마자 그 오탐을 냈다. 셸 호출(`npm ci …`)과 argv 호출(`"npm", ["ci"…]`) 둘 다.
    if (
      // ★셸 형태(`npm ci …`)는 **셸 스크립트에서만** 인정한다. `.ts`/`.mjs` 는 그 문자열이
      //  보통 **도움말 문구**다(`src/cli.ts` 가 "복구 순서: … npm ci …" 를 출력한다) —
      //  `codeOnly` 는 주석을 걷지만 문자열 리터럴은 안 걷으므로 그걸로는 안 갈린다.
      //  코드에서 실제로 부르는 형태는 argv 배열이다.
      (/\.(sh|ps1)$/.test(f) && /npm\s+(ci|install)\b/.test(body)) ||
      /["'`]npm["'`]\s*,\s*\[\s*["'`](ci|install)["'`]/.test(body) ||
      /\[\s*useCi \? ["'`]ci["'`] : ["'`]install["'`]/.test(body)
    ) {
      installers.push([f, body] as const);
    }
  }
  out.push({
    name: "★설치 경로를 손으로 열거하지 않는다 — 실제 설치자를 찾아 전수 검사한다",
    ok: installers.length >= 5,
    got: `${installers.length}곳: ${installers.map(([n]) => n).join(", ")}`,
  });
  // ★«열어 확인» 은 **실행해서** 본다 (2026-10-16 아스트라 «초보자 설치 검토» 1번). 종전엔 다섯 곳이 각자
  //  `require('better-sqlite3')` 를 적었고 이 검사는 그 문자열만 봤다 — 그런데 require 는 바인딩이 없어도 통과한다
  //  (바인딩은 DB 를 만들 때 붙는다). 그래서 판정을 `bin/check-native.cjs` 한 곳에 두고, 바인딩을 뺀 격리 사본에서
  //  **실패하는지**를 돌려 본다. 판정을 plain require 로 되돌리면 첫 단언이 빨개진다.
  {
    const iso = mkdtempSync(path.join(tmpdir(), "native-probe-"));
    try {
      const mods = path.join(iso, "node_modules");
      const sq = path.join(mods, "better-sqlite3");
      mkdirSync(sq, { recursive: true });
      cpSync(path.join(REPO, "node_modules/better-sqlite3/package.json"), path.join(sq, "package.json"));
      cpSync(path.join(REPO, "node_modules/better-sqlite3/lib"), path.join(sq, "lib"), { recursive: true });
      for (const dep of ["bindings", "file-uri-to-path"]) cpSync(path.join(REPO, "node_modules", dep), path.join(mods, dep), { recursive: true });
      mkdirSync(path.join(iso, "bin"));
      cpSync(path.join(REPO, "bin/check-native.cjs"), path.join(iso, "bin/check-native.cjs"));
      const probe = (root: string): number => {
        try {
          execFileSync(process.execPath, [path.join(root, "bin/check-native.cjs")], { cwd: root, stdio: "ignore", timeout: 20_000 });
          return 0;
        } catch (e) {
          return (e as { status?: number }).status ?? -1;
        }
      };
      const missing = probe(iso);
      const real = probe(REPO);
      out.push({
        name: "★네이티브 점검은 바인딩이 없으면 실패하고(require 만으론 통과하던 것) · 정상 설치에선 통과한다",
        ok: missing !== 0 && real === 0,
        got: `바인딩 없는 사본 rc=${missing} · 실제 설치 rc=${real}`,
      });
    } finally {
      rmSync(iso, { recursive: true, force: true });
    }
  }
  // ★install.ps1 의 «리디렉션한 네이티브 호출» 은 Continue 구간 안에서만 (2026-10-16 재검토 2차 P4, 집 윈도우 5.1 실측).
  //  Windows PowerShell 5.1 은 Stop 아래서 `cmd 2>$null` 의 stderr 를 종료 오류로 바꾼다(실측: RemoteException 으로 종료,
  //  Continue 에선 rc=1 로 다음 줄 도달). 그러면 점검이 실패하는 순간 rebuild·안내에 닿지 못한다.
  {
    let mode = "Stop";
    const exposed: string[] = [];
    for (const l of codeOnly(ps).split("\n")) {
      const m = /^\s*\$ErrorActionPreference\s*=\s*'(\w+)'/.exec(l);
      if (m !== null) { mode = m[1]!; continue; }
      if (/2>\$null/.test(l) && !/Get-Command|-ErrorAction/.test(l) && mode !== "Continue") exposed.push(l.trim());
    }
    out.push({
      name: "★install.ps1: 리디렉션한 네이티브 호출(2>$null)은 Continue 구간 안에서만 — 5.1 은 Stop 아래서 stderr 를 종료 오류로 바꾼다",
      ok: exposed.length === 0 && mode === "Stop",
      got: exposed.length === 0 ? `노출 0 · 끝 상태 ${mode}` : `🔴 ${exposed.join(" / ").slice(0, 160)}`,
    });
  }
  for (const [name, src] of installers) {
    out.push({
      name: `${name}: 설치 후 네이티브 모듈을 **실제로 열어** 확인한다(공용 판정 bin/check-native.cjs)`,
      ok: /check-native\.cjs/.test(src) && !/require\(['"]better-sqlite3['"]\)/.test(src),
      got: /check-native\.cjs/.test(src)
        ? /require\(['"]better-sqlite3['"]\)/.test(src) ? "🔴 옛 require 점검이 남아 있다" : "공용 판정 사용"
        : "🔴 종료코드만 보거나 require 만 본다",
    });
    out.push({
      name: `${name}: **설치 명령 자체**에 --ignore-scripts=false 가 붙는다(사내 정책에도 성립)`,
      // ★"파일 어딘가에 그 문자열이 있나" 로는 부족하다 — 안내문·주석에도 같은 명령이
      //  적혀 있어서, 정작 실행되는 줄에서 빼도 초록이었다(변이로 확인). 설치 명령에
      //  **붙어 있는지**를 본다. 셸(`npm ci …`)과 배열 인자(`"ci", …`) 둘 다 받는다.
      // ★표기를 셋 다 받는다: `npm ci`(sh) · `& $Npm ci`(ps1, npm.cmd 경유) · `"ci"`(배열 인자).
      //  같은 판단이 셸마다 다른 모양으로 쓰인다 — 한 표기에 묶으면 **옳은 코드가 빨간불**이
      //  되고, 그러면 코드를 검사에 맞추게 된다(오늘 세 번째다).
      // ★`install` 도 받는다 (2026-08-20). 종전엔 `ci` 만 봐서 `npm install` 을 쓰는
      //  `self-update.ts`(unix `/update` 본체)가 **플래그가 붙어 있는데도** 빨간불이었다.
      ok: /(npm (ci|install)|\$Npm ci|["'`](ci|install)["'`])[^\n]{0,140}--ignore-scripts=false/.test(src),
      got: /(npm (ci|install)|\$Npm ci|["'`](ci|install)["'`])[^\n]{0,140}--ignore-scripts=false/.test(src)
        ? "설치 명령에 명시됨"
        : "🔴 정책이 켜지면 조용히 못 쓰게 된다",
    });
    out.push({
      name: `${name}: 안 열리면 **스스로 rebuild 를 시도**한다(알려주고 끝내지 않는다)`,
      // ★셸(`npm rebuild better-sqlite3`)과 배열 인자(`["rebuild","better-sqlite3",…]`)가
      //  같은 일을 다른 모양으로 쓴다. 검사를 한 문법에 묶으면 **옳은 코드가 빨간불**이 되고,
      //  그러면 검사를 느슨하게 고치는 게 아니라 코드를 검사에 맞추게 된다(꼬리가 개를 흔든다).
      // ★안내문에도 `npm rebuild better-sqlite3` 가 적혀 있다 — 그래서 **플래그까지** 봐야
      //  실행되는 복구와 사람에게 시키는 문장이 갈린다(변이로 확인: 실행부만 지워도 초록이었다).
      ok: /rebuild[^\n]{0,60}better-sqlite3[^\n]{0,60}--ignore-scripts=false/.test(src),
      got: /rebuild[^\n]{0,60}better-sqlite3[^\n]{0,60}--ignore-scripts=false/.test(src)
        ? "자가 복구 있음"
        : "🔴 사용자에게 떠넘긴다",
    });
  }

  // ── ④-4 ★ps1 이 npm 을 **npm.cmd** 로 부른다 (2026-08-19 실사고, 다른 윈도우 머신) ──
  //  증상: 한 줄 설치가 *"이 시스템에서 스크립트를 실행할 수 없으므로 npm.ps1 파일을 로드할
  //  수 없습니다"* 로 멈췄다. PowerShell 에서 `npm` 을 부르면 **`npm.ps1`** 이 잡히는데,
  //  실행 정책이 기본 잠금인 윈도우에서는 그 파일을 못 읽는다. `npm.cmd` 는 배치라 정책
  //  대상이 아니다.
  //  ★사용자에게 `Set-ExecutionPolicy` 를 시키지 않는다 — 설치 하나 하려고 시스템 보안
  //   설정을 바꾸게 하는 건 우리가 할 말이 아니다. 우리가 부르는 방식만 바꾸면 되는 일이다.
  //  ★업데이터(bin/daemon.mjs)는 `shell: isWin` → cmd.exe 라 이 문제가 없다(확인함).
  {
    const psCode2 = codeOnly(ps);
    // 실행되는 줄에서 **맨 앞의 `npm `** 호출(= npm.ps1 이 잡히는 형태)이 남아 있나.
    const bare = [...psCode2.matchAll(/^\s*npm\s+(ci|run|rebuild|install)\b[^\n]*/gm)].map((m) =>
      m[0].trim(),
    );
    out.push({
      name: "install.ps1: npm 을 npm.cmd 로 부른다(실행 정책이 잠긴 윈도우에서도 설치된다)",
      ok: bare.length === 0 && /npm\.cmd/.test(psCode2),
      got:
        bare.length > 0
          ? `🔴 정책에 막히는 호출 ${bare.length}곳: ${bare.join(" / ").slice(0, 120)}`
          : /npm\.cmd/.test(psCode2)
            ? "npm.cmd 사용"
            : "🔴 npm.cmd 폴백이 없다",
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
