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
import { execFile, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
    if (isUsableRg(c)) return c;
  }
  return null;
};

/**
 * **실제로 도는 rg 인가** — 존재는 동작이 아니다 (2026-08-09 적대 검토 ①).
 *
 * ★`existsSync` 만 보면 **디렉터리와 깨진 파일도 통과한다.** 실증: 12바이트 텍스트를
 *  `<home>/bin/rg` 로 두면 `ensureRipgrep` 이 `ok:true` 를 답하고, 디렉터리도 경로로 돌려줬다.
 *  설치가 중단돼 부분 파일이 남으면 그게 **정상 `/opt/homebrew/bin/rg` 를 영원히 가린다** —
 *  1순위라서다. 닥터는 "OK" 를 찍고 Grep/Glob 은 계속 죽고, 재실행으로 자가치유가 안 된다.
 *  그래서 파일인지 보고 `--version` 까지 돌린다(짧은 타임아웃).
 */
/**
 * ★**성공만 캐시한다** (2026-08-09 적대 검토 3R).
 *
 * 종전엔 실패도 영구 캐시해서, `file-ops` 가 지연 해소로 바뀌어도 **그 아래가 굳었다**.
 *  실증: `<home>/bin/rg` 가 없을 때 한 번 조회하면 false 가 박히고, doctor 가 거기 설치해도
 *  `findRipgrep` 이 1순위를 영영 건너뛴다 — 온보드 [3/5]→[5/5] 영구 실패 루프가 그대로였다.
 *  내가 "자가치유 실증" 이라고 내놓은 테스트는 빈 폴더에서 `[]` 를 받고 그걸 "rg 없음" 으로
 *  읽은 **부실한 검증**이었다(rg 는 잘 돌았고 매칭이 0이었을 뿐이다).
 *
 * 성공을 캐시하는 이유는 `--version` 을 매번 spawn 하지 않기 위해서다. 실패는 **상태가
 * 바뀔 수 있으므로**(설치가 그 상태 변화다) 절대 굳히지 않는다.
 */
const rgProbeOk = new Set<string>();
/**
 * **실행해 본 실패만** 짧게 기억한다 (2026-08-09 적대 검토 4R).
 *
 * 3R 은 "실패를 캐시하지 마라"(자가치유)로 갔는데 대가가 있었다 — 깨진·매달리는 후보가
 * 있으면 **매 도구 호출마다** 동기 spawn 을 재지불한다(그동안 데몬 이벤트 루프 전체가 멈춘다).
 *
 * ★그런데 두 실패는 비용이 다르다. **없는 파일**은 재확인이 `statSync` 한 번(실측 0.21ms)이라
 *  캐시할 이유가 없고, 캐시하면 **설치 직후 자가치유가 그만큼 늦어진다**. 비싼 건 spawn 뿐이다.
 *  그래서 spawn 을 시도한 실패만 TTL 로 묶는다 — 자가치유는 즉시, 반복 비용은 차단.
 */
const rgProbeFail = new Map<string, number>();
const PROBE_FAIL_TTL_MS = 10_000;
const isUsableRg = (candidate: string): boolean => {
  // ★캐시된 성공도 **존재는 다시 본다** (2026-08-09, 4R 대비 자체 점검에서 발견).
  //  `--version` spawn 만 아끼는 게 목적이지 "한 번 봤으니 영원히 있다" 가 아니다.
  //  실증: rg 를 지운 뒤에도 그 경로를 계속 반환했다 — 사용자가 홈을 정리하거나
  //  패키지 관리자가 갈아치우면 재시작 전까지 영구 실패였다. `existsSync` 는 싸다.
  const failedAt = rgProbeFail.get(candidate);
  if (failedAt !== undefined && Date.now() - failedAt < PROBE_FAIL_TTL_MS) return false;
  if (rgProbeOk.has(candidate)) {
    if (existsSync(candidate)) return true;
    rgProbeOk.delete(candidate); // 사라졌다 — 아래에서 정식 재검증.
  }
  let ok = false;
  let spawned = false; // ★비용을 실제로 치른 경우만 기억한다(아래).
  try {
    if (statSync(candidate).isFile()) {
      spawned = true;
      // ★타임아웃을 짧게 — `execFileSync` 는 **동기**라 그동안 데몬 이벤트 루프 전체가
      //  멈춘다(전 채널·전 세션이 얼어붙는다). 매달리는 바이너리(중단된 다운로드·손상)는
      //  드물지만 그때 5초 × 매 도구 호출은 감당이 안 된다(적대 검토 4R).
      execFileSync(candidate, ["--version"], { timeout: 1_500, stdio: "ignore" });
      ok = true;
    }
  } catch {
    ok = false; // 없음·디렉터리·권한·깨진 바이너리 — 전부 "못 쓴다" 로 같다.
  }
  if (ok) rgProbeOk.add(candidate);
  // ★**실행을 시도한 실패만** 기억한다. 파일이 아예 없는 경우는 재확인이 `statSync` 한 번
  //  (실측 0.21ms)이라 캐시할 이유가 없고, 캐시하면 **설치 직후 자가치유가 늦어진다**.
  //  비싼 건 매달리는·깨진 바이너리를 동기로 spawn 하는 쪽뿐이다 — 그것만 짧게 묶는다.
  else if (spawned) rgProbeFail.set(candidate, Date.now());
  return ok;
};

/** 특정 경로의 프로브 기억을 지운다 — 소비처가 "죽었다" 를 알게 됐을 때 부른다. */
export const forgetRipgrep = (candidate: string): void => {
  rgProbeOk.delete(candidate);
  rgProbeFail.delete(candidate);
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
    // ★타임아웃 필수 — 온보드가 `doctor` 를 거쳐 이걸 부른다. 사내 프록시·오프라인·
    //  IPv6 블랙홀(이 레포가 이미 겪은 사고)에서 **무기한 멈춘다**(적대 검토 ②).
    //  주석은 "온보드가 멈추면 안 된다" 라고 적혀 있었는데 throw 만 막고 hang 은 안 막았다.
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const archive = path.join(tmp, rel.asset);
    await fs.writeFile(archive, Buffer.from(await res.arrayBuffer()));
    // 압축 해제는 OS 기본 도구로 — 새 의존성을 안 만든다.
    if (rel.asset.endsWith(".zip")) {
      await execFileP(
        "powershell",
        ["-NoProfile", "-Command", `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`],
        { timeout: 120_000 },
      );
    } else {
      await execFileP("tar", ["-xzf", archive, "-C", tmp], { timeout: 120_000 });
    }
    const extracted = path.join(tmp, rel.inner);
    if (!existsSync(extracted)) throw new Error(`압축 안에 ${rel.inner} 가 없습니다`);
    const dest = managedRgPath(home);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // ★**원자적으로** 둔다 — 임시 이름으로 쓰고 검증한 뒤 rename. 중단된 복사가 남긴
    //  부분 파일이 1순위 자리를 차지하면 그게 정상 설치본을 영영 가린다(적대 검토 ①).
    const staged = `${dest}.partial`;
    await fs.rm(staged, { force: true });
    await fs.copyFile(extracted, staged);
    if (process.platform !== "win32") await fs.chmod(staged, 0o755);
    const { stdout } = await execFileP(staged, ["--version"], { timeout: 10_000 });
    await fs.rename(staged, dest);
    forgetRipgrep(dest); // 방금 바꿨으니 캐시 무효화(다시 검증하게)

    return {
      ok: true,
      path: dest,
      detail: `${dest} (${stdout.split("\n")[0]?.trim() ?? RG_VERSION})`,
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
    // 실패로 남은 부분 파일까지 치운다 — 다음 실행이 그걸 rg 로 착각하지 않게.
    await fs.rm(`${managedRgPath(home)}.partial`, { force: true }).catch(() => {});
  }
};

/**
 * **부팅에서 없으면 받는다** (2026-08-27 사용자 결정: "부팅에서 받게 해줘").
 *
 * ★종전엔 부팅이 **진단만** 했다 — 없으면 경고 한 줄 찍고 넘어갔다. 그런데 그 줄을 볼
 *  사람이 없다(회사PC는 원격도 안 되고, 데몬 로그를 열어볼 이유도 없다). 그래서 rg 없는
 *  기계는 **매 부팅 같은 경고를 남기며 영원히** 검색이 죽은 채로 돈다 — 2026-08-27 회사
 *  인스턴스가 정확히 그 상태였고, 그 결과 모델이 모든 검색을 윈도우 Bash 로 우회하다
 *  셸이 매달려 작업 하나가 통째로 어긋났다.
 *
 * ★**왜 `/update` 로는 부족한가** — 확보를 거기에만 두면 구멍이 셋이다:
 *   ① 업데이트 칩은 **버전이 올랐을 때만** 뜬다(v0.40.0) — 그런데 rg 복구는 버전과 무관하다.
 *      환경이 깨진 기계는 업데이트가 **더** 필요한데 규칙은 **덜** 부른다.
 *   ② dep-free CLI 복구 경로(`bin/daemon.mjs`)엔 rg 코드가 **0줄**이다.
 *   ③ self-update 변경은 **다음 업데이트부터** 듣는다(수행 주체가 옛 코드다) — 첫 한 번은
 *      그냥 지나간다.
 *  부팅은 이 셋을 전부 우회한다. **환경 복구가 코드 배포에 얹혀 있으면 안 된다.**
 *
 * ★**부팅을 막지 않는다.** 호출부는 `void` 로 던지고 기다리지 않는다 — 여기서 await 하면
 *  사내 프록시·오프라인에서 데몬 기동이 그만큼 늦어진다. 다운로드가 끝나면 다음 `Grep`
 *  호출이 자동으로 새 경로를 집는다(`rgPath()` 가 매번 다시 푼다 + 실패는 안 굳는다).
 *
 * ★`deps` 는 **주입 지점**이다. 이게 없으면 이 판정을 격리해서 부를 수가 없다 —
 *  `findRipgrep` 은 PATH 와 하드코딩 경로(`/opt/homebrew/bin` 등)를 읽으므로, rg 가 깔린
 *  개발 기계에서는 "없는 상태" 를 **재현할 방법이 원리적으로 없다**(실제로 첫 검증이 그렇게
 *  막혔다). 그래서 찾는 쪽·받는 쪽 둘 다 뺀다. 제품 경로는 기본값 그대로다.
 */
export const repairRipgrepAtBoot = async (
  home: string,
  log: (line: string) => void = console.log,
  deps: {
    find?: (h: string) => string | null;
    ensure?: (h: string) => Promise<RipgrepEnsureResult>;
  } = {},
): Promise<RipgrepEnsureResult | null> => {
  const find = deps.find ?? findRipgrep;
  const ensure = deps.ensure ?? ensureRipgrep;
  const found = find(home);
  if (found !== null) {
    log(`[file-ops] ripgrep: ${found}`);
    return null;
  }
  log("[file-ops] ripgrep 없음 — 지금 받아 둡니다(Grep/Glob 이 이것 위에 섭니다).");
  try {
    const r = await ensure(home);
    log(
      r.ok
        ? `[file-ops] ripgrep 확보 — ${r.detail}`
        : `[file-ops] ★ripgrep 확보 실패 — ${r.detail} · Grep/Glob 이 실패합니다(다음 부팅에 다시 시도합니다).`,
    );
    return r;
  } catch (e) {
    // ensureRipgrep 은 throw 하지 않는 계약이지만, 여기서 새면 부팅 로그가 통째로 죽는다.
    const msg = e instanceof Error ? e.message : String(e);
    log(`[file-ops] ★ripgrep 확보 중 예외 — ${msg} (Grep/Glob 이 실패합니다)`);
    return { ok: false, path: null, detail: msg, installed: false };
  }
};
