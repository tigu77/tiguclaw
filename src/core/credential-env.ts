/**
 * **인증값은 재시작 없이 따라간다** — 홈 `.env` 의 인증 키가 바뀌면 다음 턴부터 쓴다 (2026-09-29).
 *
 * ★왜: `.env` 는 부팅 때 한 번 process.env 로 올라간다. 터미널에서 `claude-auth`·`codex-auth` 로 재발급하면
 *  파일만 바뀌고 돌고 있는 데몬은 옛 토큰을 계속 써서, 재시작을 모르는 사용자는 «재발급했는데 계속 401» 을 겪었다.
 *  Claude 는 발급기가 터미널을 요구해 **터미널이 정식 경로**다.
 *
 * ★★«매 턴 파일로 덮어쓰기» 가 **아니다** — 파일이 **마지막으로 본 뒤 바뀌었을 때, 바뀐 인증 키만** 반영한다.
 *  - 데몬은 codex 토큰을 스스로 갱신한다(갱신 토큰 회전). 파일 쓰기가 실패해도 메모리는 새 값이라(`env-file.ts`),
 *    덮어쓰면 **이미 무효가 된 옛 토큰으로 되돌아간다.** 파일이 그대로면 메모리를 안 건드린다.
 *  - 셸·유닛 환경변수가 `.env` 보다 우선인 규칙(`load-env.ts`)도 부팅 때는 그대로다. 그 키를 누가 `.env` 에서
 *    **새로 쓰면** 그때부터 파일 값을 따른다 — 재인증했다는 뜻이다.
 *  - 파일에서 키가 사라져도 지우지 않는다(지운 것은 재시작 뒤에 반영된다).
 * ★인증 키만이다 — 포트·채널 같은 나머지는 여전히 부팅 고정이다(연결을 다시 맺어야 하는 값이다).
 * ★값은 절대 로그에 안 남는다. 키 이름만.
 */
import { readFileSync } from "node:fs";
import * as util from "node:util";

/**
 * ★이름 있는 import 로 받지 않는다 — `parseEnv` 는 Node 20.12+ 인데 요구 버전은 `>=20` 이다. 없는 이름을
 *  import 하면 **모듈 연결에서 죽고**, 이 모듈은 모든 진입점이 가장 먼저 여는 `load-env` 가 부른다(= 부팅 불능).
 *  `loadEnvFile` 을 동적으로 부르는 것과 같은 규칙이다. 없으면 이 기능만 꺼진다(재시작하면 반영되는 종전 동작).
 */
const parseEnv = (util as { parseEnv?: (s: string) => Record<string, string> }).parseEnv;

/**
 * 따라가는 인증 키와 **그 자격을 쓰는 어댑터** — 자격이 바뀌면 그 어댑터의 쉼을 푼다(`followHomeCredentials`).
 * `rotates` = 갱신 때마다 바뀌고 옛 값이 서버에서 무효가 되는 키(codex OAuth). 이것만 «옛 값으로 되돌아가기» 를 막는다.
 */
const CREDENTIALS = {
  CLAUDE_CODE_OAUTH_TOKEN: { adapter: "claude", rotates: false },
  ANTHROPIC_API_KEY: { adapter: "claude", rotates: false },
  OPENAI_CODEX_OAUTH_TOKEN: { adapter: "codex-oauth", rotates: true },
  OPENAI_CODEX_OAUTH_REFRESH: { adapter: "codex-oauth", rotates: true },
  OPENAI_CODEX_OAUTH_EXPIRES: { adapter: "codex-oauth", rotates: true },
} as const;

export const CREDENTIAL_ENV_KEYS = Object.keys(CREDENTIALS) as Array<keyof typeof CREDENTIALS>;

/** 이 인증 키를 쓰는 어댑터(모르는 키면 undefined). */
export const credentialAdapterOf = (key: string): "claude" | "codex-oauth" | undefined =>
  (CREDENTIALS as Record<string, { adapter: "claude" | "codex-oauth" }>)[key]?.adapter;

type Seen = Partial<Record<string, string>>;

/**
 * 파일의 인증 키만 읽는다. 못 읽으면 `null` — **판단하지 않는다**(부재·권한·잠금·쓰는 도중 전부).
 * ★읽기 실패를 «빈 파일» 로 기록하면 안 된다 — 그러면 파일이 돌아오는 순간 거기 적힌 **옛 값**이 «변경» 으로 보여
 *  메모리를 되돌린다(적대 검토 P3 재현: chmod 000 한 턴 → 회전된 codex 토큰이 옛 값으로). `env-file.ts` ① 이 경고한
 *  «읽기 실패를 부재로 오인» 과 같은 부류다. 부팅 때 파일이 없는 것만 따로 «빈 기록» 으로 시작한다(`snapshot`).
 * ★수정 시각으로 거르지 않는다 — 시각 해상도가 거친 파일시스템에서 같은 크기로 두 번 쓰면 놓친다.
 */
const read = (envPath: string): Seen | null => {
  if (parseEnv === undefined) return null;
  try {
    const all = parseEnv(readFileSync(envPath, "utf8"));
    const vals: Seen = {};
    for (const k of CREDENTIAL_ENV_KEYS) if (all[k] !== undefined) vals[k] = all[k];
    return vals;
  } catch {
    return null;
  }
};

/** 한 `.env` 경로를 지켜보는 단위 — 데몬은 홈 하나를 쓰고, 검사는 임시 파일로 같은 것을 돌린다. */
export const makeCredentialWatch = (envPath: string, env: NodeJS.ProcessEnv = process.env) => {
  let seen: Seen | null = null;
  /**
   * **회전하는 키**(codex OAuth)마다 거쳐 간 값 — 여기 있는 값으로는 되돌아가지 않는다.
   * ★회전된 갱신 토큰은 한 번 바뀌면 옛 값이 서버에서 무효다. 다른 프로세스(터미널 CLI)가 파일을 읽은 뒤 데몬이
   *  토큰을 갱신하고 CLI 가 옛 본문으로 덮으면(적대 검토 P1 경합) 파일엔 옛 값이 «새로» 나타난다 — 따르면 죽는다.
   * ★회전하지 않는 키(Claude 토큰·API 키)엔 걸지 않는다 — 일부러 이전 토큰으로 되돌린 것을 조용히 무시했다(전체 검토).
   *  무시할 때는 로그를 남긴다(«새 토큰을 씁니다» 라고 들은 사용자가 로그로 이유를 찾을 수 있게).
   */
  const past = new Map<string, Set<string>>();
  const remember = (k: string, v: string | undefined): void => {
    if (v === undefined || v === "" || !CREDENTIALS[k as keyof typeof CREDENTIALS].rotates) return;
    const set = past.get(k) ?? new Set<string>();
    set.add(v);
    past.set(k, set);
  };
  return {
    /** 부팅 때 — 지금 파일에 있는 값을 «본 것» 으로 기록한다(반영은 로더가 이미 했다). */
    snapshot(): void {
      // 해석기가 없는 Node 면 끈다(null). 파일이 없거나 못 읽으면 빈 기록으로 시작한다 — 나중에 생기면 그게 변경이다.
      seen = parseEnv === undefined ? null : (read(envPath) ?? {});
      for (const k of CREDENTIAL_ENV_KEYS) {
        remember(k, seen?.[k]);
        remember(k, env[k]);
      }
    },
    /** 턴마다 — 바뀐 인증 키를 반영하고 그 이름을 돌려준다. 스냅샷이 없거나 못 읽으면 아무것도 안 한다. */
    refresh(): string[] {
      if (seen === null) return [];
      const now = read(envPath);
      if (now === null) return [];
      const changed: string[] = [];
      for (const k of CREDENTIAL_ENV_KEYS) {
        remember(k, env[k]); // 데몬이 스스로 바꾼 값(갱신)도 «거쳐 간 값» 이다.
        const v = now[k];
        if (v === undefined || v === "" || v === seen[k] || v === env[k]) continue;
        if (past.get(k)?.has(v) === true) {
          console.warn(`[env] ${k} 가 이전 값으로 돌아간 파일 변경은 따르지 않습니다(회전된 토큰 — 옛 값은 무효). 다시 로그인하면 새 값이 들어옵니다.`);
          continue;
        }
        env[k] = v;
        remember(k, v);
        changed.push(k);
      }
      seen = now;
      return changed;
    },
  };
};

let home: ReturnType<typeof makeCredentialWatch> | null = null;

/** 이 Node 에서 재시작 없이 따라갈 수 있나 — 없으면 재발급 안내가 «재시작하세요» 라고 말해야 한다. */
export const credentialFollowAvailable = (): boolean => parseEnv !== undefined;

/** 로더가 홈 `.env` 를 올린 직후 부른다. */
export const startHomeCredentialWatch = (envPath: string): void => {
  home = makeCredentialWatch(envPath);
  home.snapshot();
  // 꺼졌으면 **말한다** — 조용히 꺼지면 «재발급했는데 안 먹는다» 를 로그로 풀 수 없다(전체 검토).
  if (!credentialFollowAvailable()) {
    console.warn("[env] 인증값 따라가기 꺼짐 — 이 Node 에 util.parseEnv 가 없습니다(20.12 미만). 재발급한 토큰은 재시작 뒤에 반영됩니다.");
  }
};

/** 입구마다 — 바뀐 인증 키를 반영하고 그 이름을 돌려준다(쉼 해제는 호출자 `followHomeCredentials`). 로더가 꺼져 있으면 아무것도 안 한다. */
export const refreshHomeCredentials = (): string[] => {
  const changed = home?.refresh() ?? [];
  if (changed.length > 0) {
    console.log(`[env] 인증값 변경 반영: ${changed.join(", ")} — 홈 .env 가 바뀌어 재시작 없이 다음 호출부터 씁니다.`);
  }
  return changed;
};
