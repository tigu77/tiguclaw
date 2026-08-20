/**
 * `doctor` 의 **설치 상태** 판정 — 네이티브 모듈 · 전역 명령 (2026-08-20)
 *
 * ★왜 따로 뽑았나: 이 둘은 `doctor` 본문이 **돌기도 전에** 죽는 경우를 다룬다.
 *  `doctor.ts` 는 `store/sessions.js` 를 정적 import 하고 그건 `better-sqlite3` 를 정적
 *  import 한다 — 네이티브가 깨지면 **모듈 로드 단계에서 throw** 해서 `main()` 이 시작조차
 *  못 한다. 즉 **진단 도구가 가장 필요한 순간(데몬이 부팅마다 죽는 그 머신)에 침묵**했다.
 *  실제로 그래서 사용자가 로그를 손으로 보내야 했다(SANTO, 2026-08-19).
 *
 *  판정을 여기 순수 함수로 두면 회귀가 **실행해서** 지킬 수 있다 — doctor 본문 안에 두면
 *  검사가 "문구가 있나" 를 grep 하는 수준으로 약해진다.
 */
import { execFileSync } from "node:child_process";
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

/** 전역 `tiguclaw` 가 PATH 에서 풀리나. 못 풀면 `null`. */
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

export type GlobalCommandVerdict =
  | { kind: "ok"; detail: string }
  | { kind: "missing"; detail: string; fix: string }
  | { kind: "elsewhere"; detail: string; fix: string };

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
): GlobalCommandVerdict => {
  if (resolved === null) {
    return {
      kind: "missing",
      detail: "PATH 에서 못 찾음",
      // ★조치는 **이미 있는 것 하나**를 가리킨다 — onboard 가 npm link 를 한다.
      fix: "설치 폴더에서 `npm run onboard` (전역 명령 등록을 다시 겁니다). 그 전까진 `node bin/tiguclaw.mjs <명령>` 으로 대신할 수 있습니다.",
    };
  }
  // 심링크 실체가 이 설치 안을 가리키는지 — 경로 비교는 대소문자·구분자 차이를 흡수한다.
  const norm = (p: string): string => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  if (norm(resolved).startsWith(norm(repoRoot))) {
    return { kind: "ok", detail: resolved };
  }
  return {
    kind: "elsewhere",
    detail: `${resolved} — 이 설치(${repoRoot})가 아닙니다`,
    fix: "다른 tiguclaw 설치본이 전역 명령을 잡고 있습니다. 이 설치를 쓰려면 여기서 `npm run onboard` 를 다시 돌리거나, 명령마다 `node bin/tiguclaw.mjs <명령>` 을 쓰세요.",
  };
};
