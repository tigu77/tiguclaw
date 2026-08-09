/**
 * ripgrep 확보 — **우리 도구의 의존성은 우리가 소유한다** (2026-08-09 사용자 결정).
 *
 * `Grep`/`Glob` 은 ripgrep 위에 서 있다. 그런데 지금까지는 "사용자 기계에 우연히 있으면
 * 동작"이었다. 실측으로 드러난 상태:
 *  - mac(brew 설치됨): codex Grep 72회·Glob 54회, 에러 0 — 잘 돌았다.
 *  - **윈도우: PATH 에도 SDK 동봉에도 없다** → codex 는 전부 실패, 사용자는 "왜 못 찾지" 만 겪는다.
 *  - claude 는 SDK 가 자기 바이너리(259MB) **안에** rg 를 넣고 다녀서 혼자 멀쩡했다.
 *    그래서 같은 질문에 어댑터마다 다른 답이 나왔다("모든 기능 LLM 무관" 위반).
 *
 * ★해소 순서를 여기 하나로 모은다 — 종전엔 `file-ops-mcp` 안에 있었고, 그 코드가
 *  `require.resolve(".../package.json")` 을 썼는데 패키지 `exports` 가 서브패스를 안 열어
 *  **항상 throw** 했다(= SDK 동봉 경로가 한 번도 안 쓰였다). 게다가 SDK 는 이제 `vendor/` 를
 *  담지도 않는다. 근거로 삼은 주석이 낡았던 것이다.
 *
 * ★설치는 **온보드·닥터에서만** 한다(`npm install` 시점이 아니라). postinstall 다운로드는
 *  CI·오프라인·사내 프록시에서 `npm ci` 를 통째로 깨뜨린다 — 설치 자체는 항상 성공해야 한다.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 플랫폼별 실행파일 이름. */
export const rgBinName = (): string =>
  process.platform === "win32" ? "rg.exe" : "rg";

/**
 * 우리가 받아 두는 자리 — `<home>/bin/rg`.
 *
 * 홈에 두는 이유: 레포/`node_modules` 는 `npm ci`·`/update` 로 날아간다. 홈은 사용자의
 * 영속 상태라 한 번 받으면 재설치·업데이트에도 살아남는다.
 */
export const managedRgPath = (home: string): string =>
  path.join(home, "bin", rgBinName());

/**
 * 후보를 순서대로 뒤진다. 찾으면 절대경로, 없으면 `null`.
 *
 * 순서에 뜻이 있다: ①우리가 받아둔 것(버전을 우리가 안다) → ②PATH(사용자가 깐 것)
 * → ③데몬 PATH 가 최소일 때의 흔한 자리. ③이 필요한 이유는 launchd·systemd 로 뜨면
 * 사용자 셸 PATH 를 **물려받지 못하기** 때문이다 — 터미널에선 되는데 데몬에선 안 되는
 * 상태가 실제로 있었다(2026-08-09 실측).
 */
export const findRipgrep = (home?: string): string | null => {
  const bin = rgBinName();
  const candidates: string[] = [];
  if (home !== undefined && home !== "") candidates.push(managedRgPath(home));
  for (const d of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (d !== "") candidates.push(path.join(d, bin));
  }
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
    candidates.push(path.join(d, bin));
  }
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* 접근 불가 경로는 건너뛴다 */
    }
  }
  return null;
};

/** GitHub 릴리스 자산 이름 — 플랫폼·아키텍처별. 지원 밖이면 `null`. */
const releaseAsset = (): { asset: string; inner: string } | null => {
  const v = RG_VERSION;
  const arch = process.arch;
  if (process.platform === "win32" && arch === "x64") {
    return {
      asset: `ripgrep-${v}-x86_64-pc-windows-msvc.zip`,
      inner: `ripgrep-${v}-x86_64-pc-windows-msvc/rg.exe`,
    };
  }
  if (process.platform === "darwin") {
    const t = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    return { asset: `ripgrep-${v}-${t}.tar.gz`, inner: `ripgrep-${v}-${t}/rg` };
  }
  if (process.platform === "linux") {
    const t =
      arch === "arm64"
        ? "aarch64-unknown-linux-gnu"
        : "x86_64-unknown-linux-musl";
    return { asset: `ripgrep-${v}-${t}.tar.gz`, inner: `ripgrep-${v}-${t}/rg` };
  }
  return null;
};

/** 받아올 버전 — 고정한다(재현 가능한 설치). 올릴 땐 여기만 바꾼다. */
const RG_VERSION = "14.1.1";

export interface RipgrepEnsureResult {
  ok: boolean;
  /** 최종 경로(있으면). */
  path: string | null;
  /** 사람이 읽는 한 줄 — 온보드·닥터가 그대로 출력한다. */
  detail: string;
  /** 이번 호출이 실제로 내려받았는가(이미 있으면 false). */
  installed: boolean;
}

/**
 * 있으면 그대로, 없으면 **받아서** `<home>/bin` 에 둔다.
 *
 * 실패해도 throw 하지 않는다 — 온보드가 이것 때문에 멈추면 안 된다. 못 받으면 수동 설치
 * 안내를 담아 돌려주고, 런타임은 기존대로 "없으면 시끄럽게 실패" 로 간다.
 */
export const ensureRipgrep = async (
  home: string,
  opts?: { download?: boolean },
): Promise<RipgrepEnsureResult> => {
  const found = findRipgrep(home);
  if (found !== null) {
    return { ok: true, path: found, detail: found, installed: false };
  }
  if (opts?.download === false) {
    return { ok: false, path: null, detail: "미설치", installed: false };
  }
  const rel = releaseAsset();
  if (rel === null) {
    return {
      ok: false,
      path: null,
      detail: `자동 설치 미지원 플랫폼(${process.platform}/${process.arch}) — 수동 설치 필요`,
      installed: false,
    };
  }
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${rel.asset}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tiguclaw-rg-"));
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const archive = path.join(tmp, rel.asset);
    await fs.writeFile(archive, Buffer.from(await res.arrayBuffer()));
    // 압축 해제는 OS 기본 도구로 — 새 의존성을 안 만든다.
    if (rel.asset.endsWith(".zip")) {
      await execFileP("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`,
      ]);
    } else {
      await execFileP("tar", ["-xzf", archive, "-C", tmp]);
    }
    const extracted = path.join(tmp, rel.inner);
    if (!existsSync(extracted)) throw new Error(`압축 안에 ${rel.inner} 가 없습니다`);
    const dest = managedRgPath(home);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(extracted, dest);
    if (process.platform !== "win32") await fs.chmod(dest, 0o755);
    // 받은 게 진짜 도는지 확인한다 — 파일 존재는 동작이 아니다.
    const { stdout } = await execFileP(dest, ["--version"]);
    return {
      ok: true,
      path: dest,
      detail: `${dest} (${stdout.split("\\n")[0]?.trim() ?? RG_VERSION})`,
      installed: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const manual =
      process.platform === "win32"
        ? "winget install BurntSushi.ripgrep.MSVC"
        : process.platform === "darwin"
          ? "brew install ripgrep"
          : "apt install ripgrep (또는 배포판 패키지 관리자)";
    return {
      ok: false,
      path: null,
      detail: `자동 설치 실패(${msg}) — 수동: ${manual}`,
      installed: false,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
};
