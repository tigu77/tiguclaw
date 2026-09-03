/**
 * `doctor` 의 **설치 상태** 판정 — 네이티브 모듈 · 전역 명령 (2026-08-20)
 *
 * ★왜 따로 뽑았나: 이 둘은 `doctor` 본문이 **돌기도 전에** 죽는 경우를 다룬다.
 *  `doctor.ts` 는 `store/sessions.js` 를 정적 import 하고 그건 `better-sqlite3` 를 정적
 *  import 한다 — 네이티브가 깨지면 **모듈 로드 단계에서 throw** 해서 `main()` 이 시작조차
 *  못 한다. 즉 **진단 도구가 가장 필요한 순간(데몬이 부팅마다 죽는 그 머신)에 침묵**했다.
 *  실제로 그래서 사용자가 로그를 손으로 보내야 했다(윈도우 사용자 신고, 2026-08-19).
 *
 *  판정을 여기 순수 함수로 두면 회귀가 **실행해서** 지킬 수 있다 — doctor 본문 안에 두면
 *  검사가 "문구가 있나" 를 grep 하는 수준으로 약해진다.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

export type NativeCtor = new (p: string) => { close(): void };

/**
 * 네이티브 모듈을 **실제로 열어본다**.
 *
 * ★`import` 성공은 판정이 아니다 — 바인딩(`.node`)은 **처음 인스턴스를 만들 때** dlopen 된다.
 *  import 만 보면 "설치는 성공했는데 못 쓰는" 바로 그 상태를 통과시킨다(사내 npm 설정으로
 *  네이티브가 안 깔린 머신이 정확히 그랬다 — `npm ci` 는 초록인데 데몬이 부팅마다 죽었다).
 *  종료코드는 "명령이 실패했나" 지 "결과가 쓸 만한가" 가 아니다.
 *
 * @param load 로더 주입(검사용) — 기본은 진짜 모듈.
 */
export const probeNativeModule = async (
  load: () => Promise<{ default: NativeCtor }> = () =>
    import("better-sqlite3") as unknown as Promise<{ default: NativeCtor }>,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    const mod = await load();
    const db = new mod.default(":memory:");
    db.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
};

/** 전역 `tiguclaw` 가 PATH 에서 풀리나(**존재 여부**). 못 풀면 `null`. */
export const resolveGlobalCommand = (
  platform: string = process.platform,
): string | null => {
  try {
    const out = execFileSync(platform === "win32" ? "where" : "which", ["tiguclaw"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split(/\r?\n/).find((l) => l.trim() !== "");
    return first === undefined ? null : first.trim();
  } catch {
    return null; // 없으면 which/where 가 비정상 종료한다.
  }
};

/**
 * 전역 `tiguclaw` 가 **실제로 어느 설치를 서빙하나** — `npm root -g/tiguclaw` 의 실체.
 *
 * ★PATH 상의 파일 경로로는 못 판정한다 (2026-08-20 적대 검토 B-F3). 유닉스에선 그게
 *  심링크라 `realpath` 로 풀리지만, **윈도우에선 `cmd-shim` 이 만든 일반 파일**
 *  (`tiguclaw`·`.cmd`·`.ps1`)이라 풀 것이 없다 — 결과가 영원히 `%APPDATA%\npm\…` 이고
 *  설치 루트 밖이라, **모든 윈도우 사용자가 매번 "다른 설치본" 오경보**를 받는다.
 *  안내대로 재onboard 해도 판정이 안 바뀌니 보장된 무효 처방이다.
 *
 * ★그래서 `src/cli.ts globalTiguclawIsOurs()` 가 쓰는 것과 **같은 근거**로 본다:
 *  npm 이 링크한 패키지 디렉터리의 realpath. 양 플랫폼에서 같은 답을 준다.
 *  (같은 판단을 세 번째로 다시 구현하지 않으려고 여기 한 번만 두고 판정은 순수 함수로 뺀다.)
 */
export type LinkedInstall =
  /** npm 이 링크한 패키지 폴더가 **실제로 있다**. */
  | { kind: "linked"; root: string }
  /**
   * ★npm 은 답했는데 **그 폴더가 없다** — 정션·심링크가 끊긴 것.
   *
   * 이걸 «모름» 과 가르는 게 이 타입의 이유다 (2026-09-03 사용자 신고). 종전엔 둘 다
   * `null` 이라 판정이 «판정 불가» 로 떨어졌고, 처방이 *"이 설치를 확실히 쓰려면
   * `node bin/tiguclaw.mjs <명령>`"* 였다 — **우회로만 알려주고 고치는 법을 안 알려줬다.**
   * 실제 사례: 윈도우에서 `AppData\Roaming\npm\node_modules\tiguclaw` 가 통째로
   * 사라졌는데 `.cmd` shim 만 남아, `tiguclaw update` 가 날것의 `MODULE_NOT_FOUND`
   * 스택으로 죽었다. 레포는 멀쩡했고 답은 `npm link` 한 줄이었다.
   */
  | { kind: "broken"; expected: string }
  /** npm 조회 자체가 실패 — 정말 모른다(npm 부재·권한·비정상 종료). */
  | { kind: "unknown" };

/**
 * 전역 `tiguclaw` 가 **실제로 어느 설치를 서빙하나** — `npm root -g/tiguclaw` 의 실체.
 *
 * ★PATH 상의 파일 경로로는 못 판정한다 (2026-08-20 적대 검토 B-F3). 유닉스에선 그게
 *  심링크라 `realpath` 로 풀리지만, **윈도우에선 `cmd-shim` 이 만든 일반 파일**
 *  (`tiguclaw`·`.cmd`·`.ps1`)이라 풀 것이 없다 — 결과가 영원히 `%APPDATA%\npm\…` 이고
 *  설치 루트 밖이라, **모든 윈도우 사용자가 매번 "다른 설치본" 오경보**를 받는다.
 *
 * ★그래서 `src/cli.ts globalTiguclawIsOurs()` 가 쓰는 것과 **같은 근거**로 본다:
 *  npm 이 링크한 패키지 디렉터리의 realpath. 양 플랫폼에서 같은 답을 준다.
 *
 * ★**실패를 둘로 가른다** — «조회 실패» 와 «조회는 됐는데 폴더가 없다» 는 처방이 다르다.
 *  전자는 정말 모르는 것이고, 후자는 **답을 아는 것**이다(`npm link`).
 */
export const resolveLinkedInstall = (): LinkedInstall => {
  let rootOut: string;
  try {
    rootOut = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
  } catch {
    return { kind: "unknown" }; // npm 이 없거나 비정상 종료 — 정말 모른다.
  }
  const pkg = path.join(rootOut.trim(), "tiguclaw");
  try {
    return { kind: "linked", root: path.resolve(realpathSync(pkg)) };
  } catch {
    // npm 은 답했는데 그 경로가 없다 = **링크가 끊겼다**(모르는 게 아니다).
    return { kind: "broken", expected: path.resolve(pkg) };
  }
};

export type GlobalCommandVerdict =
  | { kind: "ok"; detail: string }
  | { kind: "missing"; detail: string; fix: string }
  | { kind: "elsewhere"; detail: string; fix: string }
  /**
   * ★전역 링크가 **끊겼다** — 명령은 PATH 에 있는데 그게 가리키는 패키지 폴더가 없다.
   *  «모름» 과 가르는 이유는 처방이 있기 때문이다(`npm link` 한 줄).
   */
  | { kind: "broken-link"; detail: string; fix: string }
  // ★"모른다" 를 분리한다 — 밖에 있다고 **다른 설치라고 단정하면** 윈도우에서 전원 오경보다.
  | { kind: "unknown"; detail: string; fix: string };

/**
 * 전역 명령 상태 판정 — **순수**. 조회(위 함수)와 판정을 가른다.
 *
 * ★`elsewhere` 를 굳이 가르는 이유: 여러 인스턴스를 깔면(개발·업무용) `tiguclaw` 하나가
 *  **엉뚱한 설치본**을 가리킨다. 그러면 `tiguclaw update` 가 내가 고치려던 그 설치를
 *  안 고치는데, 아무 에러도 안 난다 — 조용한 오답이라 "명령이 없다" 보다 나쁘다.
 */
export const judgeGlobalCommand = (
  resolved: string | null,
  repoRoot: string,
  /** `npm root -g/tiguclaw` 조회 결과. 미지정=조회 안 함(=`unknown` 과 동형). */
  linked?: LinkedInstall,
): GlobalCommandVerdict => {
  if (resolved === null) {
    return {
      kind: "missing",
      detail: "PATH 에서 못 찾음",
      fix: "설치 폴더에서 `npm run onboard` (전역 명령 등록을 다시 겁니다). 그 전까진 `node bin/tiguclaw.mjs <명령>` 으로 대신할 수 있습니다.",
    };
  }
  const norm = (p: string): string => {
    let r: string;
    try {
      r = path.resolve(realpathSync(p));
    } catch {
      r = path.resolve(p);
    }
    return r.replace(/\\/g, "/").toLowerCase();
  };
  const rootNorm = norm(repoRoot);
  const inside = (p: string): boolean => {
    const n = norm(p);
    return n === rootNorm || n.startsWith(rootNorm + "/");
  };
  // ★1순위: **직접 관측**. PATH 가 준 실행 파일 자체가 이 설치 안에 있으면, `tiguclaw` 를
  //  쳤을 때 도는 건 이 설치다 — 그보다 강한 근거는 없다.
  //  ★2026-08-20 재검토 F5 로 순서를 바꿨다. 종전엔 `linkedRoot`(npm 전역 링크)가 1순위라,
  //   명령 경로가 **이 설치 안이라고 이미 증명됐는데도** 링크가 딴 데를 가리키면
  //   "이 설치가 아닙니다" 로 뒤집었다. 그건 **증명된 답을 추정으로 덮은 것**이다.
  //   실제로 갈리는 상황: 설치가 여럿이라 npm 전역 링크는 B 를 가리키는데 사용자의 PATH 는
  //   A 안의 실행 파일을 먼저 잡는 경우 — 도는 건 A 인데 doctor 는 "A 가 아니다" 라고 했다.
  //   `linkedRoot` 는 **명령이 이 설치 밖일 때** 그게 어디로 가는지를 설명하는 근거다.
  if (inside(resolved)) return { kind: "ok", detail: resolved };
  // 2순위: 명령이 밖이면(윈도우 shim 이 대표적) npm 이 링크한 실체로 판정한다.
  if (linked?.kind === "linked") {
    if (inside(linked.root)) return { kind: "ok", detail: `${resolved} → ${linked.root}` };
    return {
      kind: "elsewhere",
      detail: `${resolved} → ${linked.root} (이 설치가 아닙니다)`,
      fix: "다른 tiguclaw 설치본이 전역 명령을 잡고 있습니다. 이 설치를 쓰려면 여기서 `npm run onboard` 를 다시 돌리거나, 명령마다 `node bin/tiguclaw.mjs <명령>` 을 쓰세요.",
    };
  }
  // ★2.5순위: **링크가 끊겼다** — 모르는 게 아니라 답을 아는 상태다 (2026-09-03 사용자 신고).
  //  명령은 PATH 에 남아 있는데 그게 가리키는 패키지 폴더가 없다. 그러면 `tiguclaw <무엇>`
  //  이 전부 날것의 `MODULE_NOT_FOUND` 스택으로 죽는다 — **`tiguclaw doctor` 조차** 같은
  //  shim 을 지나므로, 이 진단에 도달할 수 있는 건 `node bin/tiguclaw.mjs doctor` 뿐이다.
  //  종전엔 이 경우가 아래 «모름» 으로 흘러 *"판정 불가"* 라고 답했다 — 고치는 법을 아는데
  //  우회로만 알려준 것이다.
  if (linked?.kind === "broken") {
    return {
      kind: "broken-link",
      detail: `${resolved} → ${linked.expected} (없음 — 전역 링크가 끊겼습니다)`,
      fix: "설치 폴더에서 `npm link` 로 전역 명령을 다시 거세요. 그 전까진 `node bin/tiguclaw.mjs <명령>` 으로 대신할 수 있습니다.",
    };
  }
  // 3순위(링크 조회 실패 + 명령도 밖): **단정하지 않는다** — 모른다고 말한다.
  return {
    kind: "unknown",
    detail: `${resolved} — 어느 설치를 가리키는지 확인 못 했습니다(npm 전역 조회 실패)`,
    fix: "판정 불가입니다. 이 설치를 확실히 쓰려면 `node bin/tiguclaw.mjs <명령>` 을 쓰세요.",
  };
};

