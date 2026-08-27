/**
 * 회귀: **검색 도구의 의존성은 우리가 소유한다** (2026-08-09 사용자 결정).
 *
 * `Grep`/`Glob` 은 ripgrep 위에 선다. 그런데 "사용자 기계에 우연히 있으면 동작" 이었다.
 * 실측:
 *  - mac(brew 설치됨) — codex Grep 72회·Glob 54회, **에러 0**. 잘 돌고 있었다.
 *  - **윈도우 — PATH 에도 SDK 동봉에도 rg 가 없다.** codex 검색이 전부 실패했고 사용자는
 *    "왜 못 찾지" 만 겪었다. claude 는 SDK 가 자기 바이너리(259MB) *안에* rg 를 넣고 다녀
 *    혼자 멀쩡했다 — 같은 질문에 어댑터마다 다른 답이 나오는 상태였다.
 *
 * ★그리고 종전 해소 코드는 **한 번도 동작한 적이 없었다**: `require.resolve(
 *  "@anthropic-ai/claude-agent-sdk/package.json")` 이 패키지 `exports` 때문에 항상 throw 해
 *  catch → PATH 폴백으로 떨어졌다. 근거로 삼은 주석("npm tarball 동봉")도 낡았다.
 *
 * 그래서 **온보드·닥터에서 없으면 받아 `<home>/bin` 에 둔다**. `npm install` 시점이 아니다 —
 * postinstall 다운로드는 CI·오프라인·사내 프록시에서 `npm ci` 를 통째로 깨뜨린다.
 *
 * ★등급: **행동 게이트**(해소 순서를 실행) + **배선 린트**(닥터가 실제로 부르는가).
 *  윈도우 실측: 다운로드 2,011KB → 해제 → `<home>\\bin\\rg.exe` → `ripgrep 14.1.1` 실행 확인.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DOCTOR = "../../../src/scripts/doctor.ts";
const FILEOPS = "../../../src/core/llm-runtime/capabilities/file-ops-mcp.ts";
const RIPGREP = "../../../src/core/ripgrep.ts";
const SELFUPDATE = "../../../src/core/self-update.ts";
const ENTRY = "../../../src/index.ts";

export const check: RegressionCheck = {
  name: "ripgrep-owned",
  guards:
    "Grep/Glob 의 ripgrep 의존성 — 없는 기계에서 codex 검색이 통째로 죽던 것(윈도우 실측)",
  run: async (): Promise<Assertion[]> => {
    const { findRipgrep, managedRgPath, rgBinName, ensureRipgrep } = await import(
      "../../core/ripgrep.js"
    );
    const doctor = await readFile(new URL(DOCTOR, import.meta.url), "utf8");
    const srcOfRipgrep = await readFile(new URL(RIPGREP, import.meta.url), "utf8");
    const fileops = await readFile(new URL(FILEOPS, import.meta.url), "utf8");
    const selfUpdate = await readFile(new URL(SELFUPDATE, import.meta.url), "utf8");
    const entry = await readFile(new URL(ENTRY, import.meta.url), "utf8");

    const { statSync } = await import("node:fs");
    // ── 판정을 실제로 실행한다 ──
    const sysRg = (() => {
      for (const d of (process.env["PATH"] ?? "").split(path.delimiter)) {
        if (d === "") continue;
        const c = path.join(d, rgBinName());
        try {
          if (statSync(c).isFile()) return c;
        } catch {
          /* 없음 */
        }
      }
      return null;
    })();

    const bin = rgBinName();
    const managed = managedRgPath("/tmp/regr-home");
    // 우리가 받아두는 자리는 **홈 아래**여야 한다 — 레포/node_modules 는 /update·npm ci 로 날아간다.
    const managedUnderHome =
      managed.startsWith(path.join("/tmp/regr-home", "bin")) && managed.endsWith(bin);
    // 없는 홈을 줘도 터지지 않고, 시스템에 있으면 그걸 찾는다(이 기계엔 있다).
    const found = findRipgrep("/tmp/regr-home-없음");
    // ★다운로드를 끄면 **네트워크를 안 탄다**(회귀가 외부에 의존하면 안 된다).
    const offline = await ensureRipgrep("/tmp/regr-home-없음", { download: false });

    // ── ★깨진 후보가 **정상 설치본을 가리지 않는다** (적대 검토 ① 실증) ──
    //  `existsSync` 만 보면 디렉터리·부분 파일·12바이트 텍스트도 통과했다. 그게 1순위
    //  자리(`<home>/bin/rg`)에 있으면 정상 rg 를 **영원히 가린다** — 닥터는 "OK" 를 찍고
    //  Grep/Glob 은 계속 죽고 재실행으로 자가치유가 안 된다.
    const { mkdirSync, writeFileSync, rmSync, chmodSync } = await import("node:fs");
    const trapBase = "/tmp/regr-rgtrap";
    rmSync(trapBase, { recursive: true, force: true });
    const mk = (name: string): string => {
      const h = path.join(trapBase, name);
      mkdirSync(path.join(h, "bin"), { recursive: true });
      return h;
    };
    const hBroken = mk("broken");
    writeFileSync(path.join(hBroken, "bin", rgBinName()), "not-a-binary");
    try { chmodSync(path.join(hBroken, "bin", rgBinName()), 0o755); } catch { /* win32 */ }
    const hDir = mk("dir");
    mkdirSync(path.join(hDir, "bin", rgBinName()), { recursive: true });
    // ★2R·3R 지적 반영 — 종전엔 `bin/rg.partial` 만 뒀는데 `findRipgrep` 은 `.partial` 을
    //  후보로 보지도 않아 **어떤 구현에서도 통과**하는 공허한 단언이었다. 실제 위험은
    //  중단된 복사가 **`bin/rg` 자리에** 부분 파일을 남기는 것이다.
    const hPartial = mk("partial");
    writeFileSync(path.join(hPartial, "bin", rgBinName()), "\x7fELF-truncated");
    // ★**긍정 단언**이 없어서 "후보에서 managedRgPath 를 아예 빼는" 변이가 통과했다
    //  (적대 검토 3R #6 — 이 배치 전체의 전제인 "우리가 rg 를 소유한다" 가 통째로 죽어도
    //   12건이 초록이었다). 정상 rg 를 `<home>/bin` 에 두면 **그걸 골라야** 한다.
    const hGood = mk("good");
    // ★검사의 **전제 탐지기를 제품 코드로 쓰지 않는다** (적대 검토 4R MUT-5).
    //  종전엔 `findRipgrep(undefined)` 로 "이 기계에 rg 가 있나" 를 쟀는데, 그 시그니처는
    //  제품 호출부가 **하나도 없어서**(전부 home 을 넘긴다) 아무도 고정해 주지 못했다.
    //  거기에 조기 return 을 넣으면 신설 긍정 단언 둘이 통째로 무력화됐다. 검사가 쓰는
    //  탐지는 검사가 소유한다 — PATH 를 직접 훑는다.
    if (sysRg !== null) {
      const { copyFileSync, chmodSync } = await import("node:fs");
      copyFileSync(sysRg, path.join(hGood, "bin", rgBinName()));
      try { chmodSync(path.join(hGood, "bin", rgBinName()), 0o755); } catch { /* win32 */ }
    }
    const goodPick = findRipgrep(hGood);
    // ★그리고 **자가치유** — 없을 때 조회한 뒤 설치하면 다음 조회가 그걸 잡아야 한다
    //  (실패를 캐시하면 영원히 못 잡는다. 종전 구현이 그랬고 온보드 순서 결함이 살아 있었다).
    const hHeal = mk("heal");
    const beforeHeal = findRipgrep(hHeal);
    if (sysRg !== null) {
      const { copyFileSync, chmodSync } = await import("node:fs");
      copyFileSync(sysRg, path.join(hHeal, "bin", rgBinName()));
      try { chmodSync(path.join(hHeal, "bin", rgBinName()), 0o755); } catch { /* win32 */ }
    }
    const afterHeal = findRipgrep(hHeal);
    // ★캐시된 성공이 **사라져도** 붙잡지 않는다(사용자가 홈을 정리하거나 패키지 관리자가
    //  갈아치우는 상황). 실증에서 재시작 전까지 영구 실패였다.
    const hStale = mk("stale");
    let staleAfterDelete: string | null = null;
    let staleAfterRestore: string | null = null;
    if (sysRg !== null) {
      const { copyFileSync, chmodSync, rmSync: rmFile } = await import("node:fs");
      const m = path.join(hStale, "bin", rgBinName());
      copyFileSync(sysRg, m);
      try { chmodSync(m, 0o755); } catch { /* win32 */ }
      findRipgrep(hStale);            // 성공 캐시에 담기게 한 번 조회
      rmFile(m);
      staleAfterDelete = findRipgrep(hStale);
      copyFileSync(sysRg, m);
      try { chmodSync(m, 0o755); } catch { /* win32 */ }
      staleAfterRestore = findRipgrep(hStale);
    }

    const brokenPick = findRipgrep(hBroken);
    const dirPick = findRipgrep(hDir);
    const partialPick = findRipgrep(hPartial);
    const managedOf = (h: string): string => managedRgPath(h);
    rmSync(trapBase, { recursive: true, force: true });

    // ── ★자가치유: 해소가 **첫 사용 시점**이라 설치 뒤 재시작 없이 산다 (적대 검토 ①) ──
    //  온보드는 데몬을 [3/5] 에 띄우고 doctor 를 [5/5] 에 돌린다. 종전엔 해소가 모듈 로드
    //  상수라 데몬이 먼저 뜨며 `"rg"` 로 굳었고, doctor 가 <home>/bin 에 받아도 **도는 데몬은
    //  영영 못 찾았다**(launchd PATH 에 <home>/bin 이 없다). 사용자는 에러 문구대로 doctor 를
    //  다시 돌리고 "OK" 를 보고 또 실패하는 루프에 빠진다 — 그게 이 커밋의 주 타깃이었다.
    // ★해소·기억의 **소유자가 하나**여야 한다 (적대 검토 4R MUT-4). 층이 둘이면 위층에
    //  캐시를 얹는 것만으로 아래층의 행동 검사가 통째로 무의미해진다 — 실제 변이가
    //  ENOENT 뒤 "없는 게 확인됐으니 재탐색 생략" 한 줄로 통과했다.
    //  그래서 file-ops 는 **상태를 갖지 않는다**: 매 호출 findRipgrep 에 위임.
    const fileopsBody = fileops.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const lazyOk =
      /const rgPath = \(\): string => findRipgrep\(getPaths\(\)\.home\) \?\? rgBinName\(\);/.test(
        fileopsBody,
      ) &&
      // 상태(memo·플래그)가 이 층에 없다 — 있으면 아래 행동 검사가 못 본다.
      !/\blet rg[A-Za-z]*\s*[:=]/.test(fileopsBody) &&
      !/const RG_PATH = /.test(fileopsBody);

    // ★**업데이트 경로에도** 있어야 한다 (2026-08-09 사용자 지적). 기존 설치본은
    //  `/update` 로 올라오지 doctor 를 안 돌린다 — doctor 에만 두면 윈도우·회사PC 처럼
    //  rg 없는 기계는 업데이트를 받아도 검색이 계속 죽어 있다. 이 변경이 겨냥한 그 인스턴스다.
    const suBody = selfUpdate.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const updateEnsures = /ensureRipgrep\(getPaths\(\)\.home\)/.test(suBody);
    // ★**변경 0 경로에도** 있어야 한다 (2026-08-09 윈도우 실측). self-update 변경은 다음
    //  업데이트부터 듣는데(수행 주체가 옛 코드다) 그때는 pull 할 게 없어 조기 반환으로 간다
    //  — 거기 없으면 이미 최신인 인스턴스는 영영 못 받는다. 그게 정확히 "검색이 죽은 채
    //  오래 살던" 기계들이다.
    const upToDatePath =
      /await ensureRipgrepBestEffort\(\);[\s\S]{0,120}return \{ status: "up-to-date"/.test(suBody);
    // ★실패해도 업데이트를 막지 않는다(견고성 불변식) — try/catch 로 감싸야 한다.
    // ★업데이트 전체에 상한이 있는가 — 안쪽 타임아웃(60+120초)을 합치면 3분이고
    //  `/update` 응답은 그 뒤에 나간다(사용자 무응답). throw 만 막는 건 부족하다.
    // ★모양이 아니라 **수치**까지 본다 — 종전엔 `new Promise(()=>{})`(영영 안 끝남)나
    //  45_000_000 으로 바꿔도 통과했다(적대 검토 4R MUT-1).
    const boundMs = /setTimeout\([\s\S]{0,200}?,\s*(\d[\d_]*),?\s*\)/.exec(suBody);
    const boundVal = boundMs === null ? 0 : Number(boundMs[1]!.replace(/_/g, ""));
    const updateBounded =
      /Promise\.race\(\[[\s\S]{0,200}ensureRipgrep\(getPaths\(\)\.home\)/.test(suBody) &&
      /setTimeout\(/.test(suBody) &&
      boundVal >= 10_000 &&
      boundVal <= 120_000;
    const updateBestEffort =
      /try \{[\s\S]{0,900}ensureRipgrep\(getPaths\(\)\.home\)[\s\S]{0,900}\} catch/.test(suBody) &&
      // ★catch **본문**까지 본다 — `throw e` 로 바꾸면 견고성 불변식이 정확히 반대가 된다
      //  (적대 검토 3R #3: try/catch 모양만 보던 것).
      // 개행을 요구하면 한 줄로 쓰는 변이가 빠져나간다(적대 검토 4R MUT-2).
      !/\} catch \([^)]*\) \{[\s]*throw\b/.test(suBody);

    // ★부팅 로그에 rg 유무가 남는가 (적대 검토 3R #5 — 이 줄을 지워도 12건이 초록이었다).
    //  원격 불가한 회사PC·윈도우의 **1차 진단면**이고, 두 커밋이 싸워서 넣은 줄이다.
    // ★주석을 걷어내고 본다 — 종전엔 IIFE 를 지우고 **그걸 설명하는 주석만** 남겨도
    //  통과했다(적대 검토 4R MUT-3). doctor·self-update 는 걷어내는데 여기만 안 걷었다.
    const entryBody = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // ★**진단이 아니라 조치**여야 한다 (2026-08-27). 종전엔 부팅이 `findRipgrep` 으로 보고만
    //  했고, 그 경고를 볼 사람이 없어서 rg 없는 기계는 검색이 죽은 채 영원히 돌았다.
    //  그리고 **기다리면 안 된다** — 여기서 await 하면 오프라인·프록시에서 데몬 기동이 막힌다.
    const bootRepairs =
      /void repairRipgrepAtBoot\(getPaths\(\)\.home\)/.test(entryBody) &&
      !/await repairRipgrepAtBoot/.test(entryBody);

    // ── 배선 ──
    const body = doctor.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // ★[린트 한계 명시] 닥터가 확보를 부르는지는 **소스로만** 본다. 조건으로 감싸는 변이
    //  (`if (env.SKIP) { ... }`)는 이 검사가 못 잡는다 — 괄호 세기는 앞 코드의 중괄호에 쉽게
    //  속는다. 행동 게이트로 만들려면 닥터를 실제로 돌려야 하는데, **rg 없는 CI 에서
    //  다운로드를 타므로** 그게 더 나쁘다(회귀가 네트워크에 의존하면 안 된다).
    //  대신 제품 쪽을 튼튼하게 했다: 런타임(`file-ops`)이 같은 해소를 쓰고 부팅 로그에
    //  결과를 남기므로, 닥터가 조용히 꺼져도 **데몬 로그에서 드러난다**.
    const doctorChecks = /const rg = await ensureRipgrep\(getPaths\(\)\.home\)/.test(body);
    const doctorReports = /issues\.push\("ripgrep 없음/.test(body);
    // 런타임이 **같은 판정**을 쓴다 — 여기서 또 뒤지면 "닥터는 찾았다는데 데몬은 못 찾는" 상태가 된다.
    const runtimeShares =
      /findRipgrep\(getPaths\(\)\.home\)/.test(fileops) &&
      !/require\.resolve\([\s\S]{0,80}package\.json/.test(fileops);

    // ── ★부팅 복구를 **실제로 부른다** (동작 검사) ────────────────────────────────
    //  ★`find`·`ensure` 를 주입한다 — `findRipgrep` 이 PATH 와 하드코딩 경로를 읽으므로
    //   rg 가 깔린 기계에서는 "없는 상태" 를 **원리적으로 재현할 수 없다**(실증: PATH 를
    //   비워도 `/opt/homebrew/bin/rg` 가 잡혔다). 다운로드는 안 탄다(회귀는 네트워크에
    //   의존하지 않는다) — 받는 쪽 자체는 이 변경이 건드리지 않았다.
    const { repairRipgrepAtBoot } = await import("../../core/ripgrep.js");
    const say = (): { lines: string[]; log: (l: string) => void } => {
      const lines: string[] = [];
      return { lines, log: (l) => lines.push(l) };
    };
    const miss = say();
    let ensureCalls = 0;
    const missResult = await repairRipgrepAtBoot("/tmp/regr-rg-home", miss.log, {
      find: () => null,
      ensure: async (h) => {
        ensureCalls += 1;
        return { ok: true, path: `${h}/bin/rg`, detail: "받음", installed: true };
      },
    });
    const have = say();
    let ensureCallsWhenPresent = 0;
    const haveResult = await repairRipgrepAtBoot("/tmp/regr-rg-home", have.log, {
      find: () => "/usr/bin/rg",
      ensure: async () => {
        ensureCallsWhenPresent += 1;
        return { ok: false, path: null, detail: "부르면 안 된다", installed: false };
      },
    });
    const boom = say();
    const boomResult = await repairRipgrepAtBoot("/tmp/regr-rg-home", boom.log, {
      find: () => null,
      ensure: () => {
        throw new Error("프록시 차단");
      },
    });
    const bootRepair: Assertion[] = [
      assert(
        "★없으면 실제로 받으러 간다(경고만 찍고 넘어가지 않는다)",
        ensureCalls === 1 && missResult?.ok === true,
        `ensure 호출 ${ensureCalls}회 · ok=${String(missResult?.ok)} · ${JSON.stringify(miss.lines)}`,
      ),
      assert(
        "★있으면 안 받는다(멀쩡한 기계가 매 부팅 네트워크를 타지 않는다)",
        ensureCallsWhenPresent === 0 && haveResult === null,
        `ensure 호출 ${ensureCallsWhenPresent}회 · ${JSON.stringify(have.lines)}`,
      ),
      assert(
        "★확보가 던져도 부팅이 안 죽고 그 사실이 로그에 남는다",
        boomResult?.ok === false && boom.lines.some((l) => l.includes("프록시 차단")),
        JSON.stringify(boom.lines),
      ),
    ];

    return [
      assert(
        "★받아두는 자리가 **홈 아래**다(레포·node_modules 는 update·npm ci 로 날아간다)",
        managedUnderHome,
        managed,
      ),
      assert(
        "해소가 시스템 설치본도 찾는다(사용자가 직접 깐 것을 무시하지 않는다)",
        // ★**rg 가 있는 기계에서만** 의미가 있다. CI(리눅스)엔 rg 가 없어서 이 단언이
        //  빨간불이었다 — 검사가 **환경을 가정**한 것이지 제품 결함이 아니다.
        //  없으면 "대상 없음" 으로 통과시키되 **그 사실을 적는다**(조용한 통과 금지 —
        //  안 본 것과 본 것이 구분돼야 한다).
        sysRg === null || (found !== null && found.endsWith(bin)),
        sysRg === null ? "이 기계엔 rg 없음 — 대상 없음(CI 리눅스 등)" : (found ?? "★못 찾음"),
      ),
      assert(
        "★`download:false` 면 네트워크를 안 탄다(회귀가 외부에 의존하지 않게)",
        offline.installed === false,
        `installed=${String(offline.installed)} ok=${String(offline.ok)}`,
      ),
      assert(
        "★정상 rg 를 `<home>/bin` 에 두면 **그걸 고른다**(우리가 소유한다는 전제 자체)",
        sysRg === null || goodPick === managedOf(hGood),
        `${goodPick ?? "null"} (기대 ${managedOf(hGood)})`,
      ),
      assert(
        "★없을 때 조회한 뒤 설치하면 **다음 조회가 잡는다**(실패를 캐시하면 영구 실패)",
        sysRg === null || (beforeHeal !== managedOf(hHeal) && afterHeal === managedOf(hHeal)),
        `전 ${beforeHeal ?? "null"} → 후 ${afterHeal ?? "null"}`,
      ),
      assert(
        "★캐시된 성공이 **사라지면 놓아준다**(지운 뒤 폴백, 되돌리면 다시 잡음)",
        sysRg === null ||
          (staleAfterDelete !== managedOf(hStale) && staleAfterRestore === managedOf(hStale)),
        `삭제후 ${staleAfterDelete ?? "null"} → 복구후 ${staleAfterRestore ?? "null"}`,
      ),
      assert(
        "★깨진 파일이 1순위에 있어도 **안 고른다**(존재는 동작이 아니다)",
        brokenPick !== managedOf(hBroken),
        `골랐다: ${brokenPick ?? "null"}`,
      ),
      assert(
        "★디렉터리를 바이너리로 오인하지 않는다",
        dirPick !== managedOf(hDir),
        `골랐다: ${dirPick ?? "null"}`,
      ),
      assert(
        "★중단된 설치가 남긴 `.partial` 이 자리를 차지하지 않는다(원자적 설치의 짝)",
        partialPick !== managedOf(hPartial),
        `골랐다: ${partialPick ?? "null"}`,
      ),
      assert(
        "★설치가 **원자적**이다(임시명 → 검증 → rename) + 다운로드에 타임아웃이 있다",
        (() => {
          const src = srcOfRipgrep;
          return (
            /\.partial`/.test(src) &&
            /await fs\.rename\(staged, dest\)/.test(src) &&
            /AbortSignal\.timeout\(/.test(src)
          );
        })(),
        "staged→rename · fetch timeout",
      ),
      assert(
        "★해소·기억의 소유자가 **하나**다(file-ops 는 무상태 — 층을 얹으면 검사가 눈먼다)",
        lazyOk,
        lazyOk ? "findRipgrep 위임 · 무상태" : "★file-ops 에 상태가 생겼다",
      ),
      assert(
        "★**업데이트 경로**에도 확보가 있다 — 정상 경로 **와** 변경 0 조기 반환 둘 다",
        updateEnsures && upToDatePath,
        `정상=${String(updateEnsures)} · 변경0=${String(upToDatePath)}`,
      ),
      assert(
        "★업데이트가 그것 때문에 멈추지 않는다 — 예외도, **지연도** 막는다",
        updateBestEffort && updateBounded,
        `try/catch=${String(updateBestEffort)} · 시간상한=${String(updateBounded)}`,
      ),
      assert(
        "★부팅이 **받는다**(진단만 하지 않는다) + 기다리지 않는다",
        bootRepairs,
        `void 호출=${/void repairRipgrepAtBoot\(getPaths\(\)\.home\)/.test(entryBody)} · ` +
          `await 아님=${!/await repairRipgrepAtBoot/.test(entryBody)}` +
          (bootRepairs ? "" : " — 진단만 하면 그 경고를 볼 사람이 없다"),
      ),
      ...bootRepair,
      assert(
        "[배선 린트] 닥터가 확보를 호출하고 결과를 문제로 보고한다(조건 감싸기는 못 잡는다 — 헤더 참조)",
        doctorChecks && doctorReports,
        `호출=${String(doctorChecks)} · 보고=${String(doctorReports)}`,
      ),
      assert(
        "★런타임이 닥터와 **같은 해소**를 쓴다(두 곳이 갈리면 진단이 거짓이 된다)",
        runtimeShares,
        runtimeShares ? "findRipgrep 공유 · 옛 resolve 제거" : "★해소가 두 벌",
      ),
    ];
  },
};
