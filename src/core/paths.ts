/**
 * V9.1 — tiguclaw 런타임 경로 단일화 (앱 런타임 홈 분리).
 *
 * 진실 소스:
 *  - ADR: `docs/decisions/2026-05-24-v9-runtime-home.md` (architect V9 contract)
 *  - 메모리: project-workspace-per-project-harness (TIGUCLAW_HOME + tiguclaw 자체 경로)
 *
 * 정체성 원칙 (사용자 확정 2026-05-24):
 *  - 앱 런타임은 tiguclaw *독립* 디렉터리 — `skills`/`agents`/`commands` 자체 컨벤션.
 *    `.claude` 안 씀 (멀티 LLM 앱이 claude 종속 인상 회피). 슈퍼셋은 *능력* 이지
 *    디렉터리명 무관.
 *  - `.claude` 는 *개발 레포* 한정 (tiguclaw 를 Claude Code 로 개발하니까).
 *  - 런타임 홈 = `TIGUCLAW_HOME` env, 기본 `~/.tiguclaw`. 개발은
 *    `TIGUCLAW_HOME=./.dev-home` 로 격리 (gitignore).
 *
 * V9.1 범위: 경로 결정 + 부팅 시드만. 아무 모듈도 아직 getPaths() 안 씀
 *  (DB=V9.2 · registry=V9.3 · hook/AGENT=V9.4 점진 전환). 순수 추가 = 회귀 0.
 *
 * 규칙: `process.cwd()` 직접 호출은 향후 본 모듈로 일원화 (file-ops-mcp 의 샌드박스
 *  cwd 는 *작업 디렉터리 격리* 라 별개 — 자산 발견 경로 아님).
 *
 * α (appRoot 분리, 2026-05-25): 앱과 함께 배포되는 읽기전용 아티팩트(plugins,
 *  sysprompt 가 가리키는 헌법 SYSTEM.md 정본)의 루트를 `appRoot()` 로 분리한다.
 *  3분류 = appRoot(앱 아티팩트, import.meta.url 기반·cwd 무관) / home(getPaths,
 *  사용자 런타임 데이터) / cwd(현재 프로젝트 폴더 — project-scope 자산 발견·작업dir).
 *  file-ops-mcp 의 샌드박스 cwd 는 여전히 별개이며, appRoot 는 자산 발견 경로다.
 */
import os from "node:os";
import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface TiguclawPaths {
  /** TIGUCLAW_HOME resolved (절대경로). */
  home: string;
  /** <home>/data — DB·brain (V9.2 가 DATA_DIR 대체). */
  data: string;
  /**
   * <home>/data/attachments — 멀티모달 첨부 바이너리 루트 (2026-05-27 멀티모달 입력 V1).
   * 채널이 `<attachmentsDir>/<channel>/<yyyymmdd>/<id>.<ext>` 로 조합해 저장한다
   * (동적 하위 세그먼트는 채널 책임 — 정적 루트만 단일 진실 소스). file-no-wall 모델상
   * 양 어댑터가 native file 도구로 읽는 home 하위 공간. 별도 attachments 테이블 없음
   * (contract Q3 — 경로는 prompt placeholder text 에 녹아 transcripts 로 자연 인덱싱).
   */
  attachmentsDir: string;
  /** <home>/AGENT.md — 런타임 인격 hub. */
  agentMd: string;
  /** <home>/settings.json — 런타임 훅 등. */
  settings: string;
  /**
   * 작동 헌법 SYSTEM.md 의 **정본 경로** = `appRoot()/SYSTEM.md`.
   *
   * ★2026-08-20 까지는 `<home>/SYSTEM.md` 로 **매 부팅 복사**했다(sync-on-boot 미러).
   *  없앤 이유: ①읽는 곳이 `identity.ts` 한 곳뿐인데 ②사본이 **없던 실패 모드를 만들었다** —
   *  미러가 실패하면 `readSystem()` 이 빈 문자열을 주고 비서가 **헌법 없이 돈다**(경고는
   *  뜨지만 턴은 계속된다). 반면 정본은 **없을 수가 없다**: `appRoot()` 탐지 자체가
   *  "`plugins/` 와 `SYSTEM.md` 를 함께 가진 디렉터리" 를 마커로 쓰므로, appRoot 가 풀렸다는
   *  건 거기 SYSTEM.md 가 있다는 뜻이다. ③덤으로 사용자 홈에 "이게 왜 여기 있지" 가 사라진다.
   *
   * 오버라이드는 **파일이 아니라 env**(`TIGUCLAW_SYSTEM_MD`)다 — 벤치가 헌법 변종
   *  (`--prompt none|minus:<절>`)으로 재려면 정본 아닌 걸 읽혀야 하는데, 그걸 *홈 파일* 로
   *  두면 비서가 자기 헌법을 스스로 갈아치울 수 있게 된다(미러의 매일 덮어쓰기가 그걸
   *  막고 있었다).
   *  ★2026-08-20 적대 검토 A2 정정: 여기 원래 *"프로세스 env 는 턴이 못 바꾸므로 봉인이
   *   유지된다"* 고 적혀 있었는데 **거짓이었다**. `load-env.ts` 가 `<home>/.env` 를 부팅마다
   *   process.env 로 올리고, 홈은 비서가 쓰는 곳이며, 재시작도 비서가 한다. 그래서 봉인은
   *   `load-env.ts` 에서 **이 키를 .env 로부터 안 받는 것**으로 실제로 닫았다(경고 후 무시).
   */
  systemMd: string;
  /**
   * <home>/SELF_GROWTH.md — self-growth V4 확정 지침 층 (2026-06-22).
   * AGENT.md(사용자 인격)·SYSTEM.md(앱 헌법) 와 *동급 홈 위치* 의 제3 markdown.
   * 코어는 이 파일을 모름 — self-growth 플러그인이 데이터로만 쓰고 읽는다(단방향).
   * 비서는 `growth_directive_pointer` 메모를 통해 작업 시작 시 이 파일을 Read 한다.
   * 코어 sysprompt/SYSTEM.md/AGENT.md 무수정(원칙 20) — 파일 쓰기는 *이것만*.
   */
  selfGrowthMd: string;
  /** <home>/skills — 공통 스킬 (모든 프로젝트 공유). */
  commonSkills: string;
  /** <home>/agents — 공통 서브에이전트. */
  commonAgents: string;
  /** <home>/commands — 공통 슬래시 커맨드. */
  commonCommands: string;
  /**
   * <home>/plugins — 유저 설치 생태계 플러그인 루트 (2026-05-27).
   * `appRoot()/plugins`(1st-party 번들, 앱과 함께 배포되는 코드)와 별개 — 사용자가
   * 자기 런타임 홈에 설치하는 플러그인. registry 발견이 두 루트를 모두 walk 한다
   * (자산=skill/agent/command 마크다운 발견. 실행 코드 로딩은 번들만 — 별도 라운드).
   */
  commonPlugins: string;
  /**
   * <home>/endpoints — 데이터 기반 커스텀 HTTP 엔드포인트 정의 루트 (2026-06-18).
   * 다른 common*(skills/agents/commands) 와 동형 — endpoint-registry 가 home 발견 루트로
   * walk 한다(슬래시 명령의 HTTP 판). contract `_workspace/custom-endpoints_architect.md` §2.
   */
  commonEndpoints: string;
  /** <home>/workspace — 프로젝트 폴더 컨테이너. */
  workspace: string;
}

/** TIGUCLAW_HOME env → 절대경로. 미설정 시 `~/.tiguclaw`. */
export const resolveHome = (): string => {
  const env = process.env.TIGUCLAW_HOME?.trim();
  const raw = env !== undefined && env !== "" ? env : path.join(os.homedir(), ".tiguclaw");
  return path.resolve(raw);
};

let cachedAppRoot: string | undefined;

/**
 * α — 앱 설치/레포 루트 (앱과 함께 배포되는 읽기전용 아티팩트 발견 기준). cwd 무관.
 *
 * D1-a (2026-07-14, ADR built-artifact-production-runtime) — ★marker walk-up.
 *  이전엔 고정 2-레벨-업(`core/` 의 2단계 위)이었으나, built(디렉터리 보존 tsc, rootDir=".")
 *  레이아웃에서 이 파일은 `<root>/dist/src/core/paths.js` 로 emit 되어 2단계 위가
 *  `dist/src`(plugins 없음)가 되어 어긋난다. dev 는 `<root>/src/core/paths.ts` 로 2단계
 *  위가 repo root(정상) — 즉 두 레이아웃의 정답 깊이가 달라 고정 카운트로는 둘 다 못 맞춘다.
 *
 *  대신 이 파일 위치에서 위로 올라가며 **앱 아티팩트 루트 마커**를 찾는다:
 *    루트 == `plugins/`(배포 코드) 와 `SYSTEM.md`(작동 헌법 정본) 를 *함께* 가진 디렉터리.
 *  둘을 함께 요구하는 이유: `src/core/plugins/`(로더 자신의 홈) 가 `plugins` 단독 마커의
 *  가짜 양성이기 때문 — 하지만 그 디렉터리엔 SYSTEM.md 가 없으므로 복합 마커가 걸러낸다.
 *   - dev:   src/core → src → repo root(plugins + SYSTEM.md) ✓
 *   - built: dist/src/core → dist/src → dist (dist/plugins + 복사된 dist/SYSTEM.md) ✓
 *  build:prod 의 copy 단계가 SYSTEM.md·skills·agents·플러그인 package.json 을 dist/ 로
 *  미러하므로 built 의 appRoot=dist/ 가 자립(self-contained).
 *
 * dev 회귀 0: dev 에서 walk-up 결과 = repo root = 종전 고정 2-업 값과 동일(동치). 모든
 *  소비처(appRoot()/plugins·skills·agents·SYSTEM.md·packages)의 dev 값 불변.
 *
 * 마커 미발견(이론상 비정상 레이아웃) 시 종전 고정 2-업으로 폴백 — 부팅 생존 우선.
 *
 * getPaths(home) 와 완전 별개 — appRoot=앱 아티팩트, getPaths=home/사용자 데이터.
 */
const isArtifactRoot = (dir: string): boolean =>
  existsSync(path.join(dir, "plugins")) && existsSync(path.join(dir, "SYSTEM.md"));

export const appRoot = (): string => {
  if (cachedAppRoot !== undefined) return cachedAppRoot;
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  // 파일시스템 루트까지 위로 탐색하며 복합 마커를 찾는다.
  for (;;) {
    if (isArtifactRoot(dir)) {
      cachedAppRoot = dir;
      return cachedAppRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 파일시스템 루트 도달 — 미발견.
    dir = parent;
  }
  // 폴백: 종전 고정 2-레벨-업(dev 소스 레이아웃에서 repo root 와 동치).
  cachedAppRoot = path.resolve(start, "..", "..");
  return cachedAppRoot;
};

/**
 * 소스 빌드 루트 — self-update 의 재빌드가 필요한 *소스 툴체인* 위치
 * (`tsconfig.build.json`·`node_modules`·`bin/`·`.git` 가 있는 곳).
 *
 * ★appRoot() 와 구분해야 하는 이유: built 런타임에선 `dist/` 가 `plugins/`+`SYSTEM.md`
 *   미러를 가져 **appRoot()=`<repo>/dist`**(런타임 artifact root)로 잡힌다. 하지만 dist 엔
 *   node_modules·tsconfig.build.json·bin·.git 이 없어, self-update 가 cwd=appRoot 로 재빌드하면
 *   `dist/node_modules/typescript/bin/tsc` 를 못 찾아 MODULE_NOT_FOUND 로 전체 실패한다
 *   (Windows /update 실사고 2026-07-22). dev 에선 appRoot=repo root 라 문제 없이 잠복했다.
 *
 * appRoot 에서 위로(자신 포함) `tsconfig.build.json` 을 찾는다 — dist 엔 없으니 built 는
 * repo root 로 올라가고, dev 는 appRoot(=repo root)에서 즉시 발견. 미발견(소스 없는 설치 =
 * self-update git 경로 자체가 불가한 케이스)이면 appRoot 폴백.
 */
export const sourceRoot = (): string => {
  let dir = appRoot();
  for (;;) {
    if (existsSync(path.join(dir, "tsconfig.build.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return appRoot();
};

let cached: TiguclawPaths | undefined;

/** 런타임 경로 묶음. 부팅 시 1회 계산 + freeze (캐시). */
export const getPaths = (): TiguclawPaths => {
  if (cached !== undefined) return cached;
  const home = resolveHome();
  cached = Object.freeze({
    home,
    data: path.join(home, "data"),
    attachmentsDir: path.join(home, "data", "attachments"),
    agentMd: path.join(home, "AGENT.md"),
    settings: path.join(home, "settings.json"),
    systemMd:
      process.env.TIGUCLAW_SYSTEM_MD !== undefined && process.env.TIGUCLAW_SYSTEM_MD !== ""
        ? process.env.TIGUCLAW_SYSTEM_MD
        : path.join(appRoot(), "SYSTEM.md"),
    selfGrowthMd: path.join(home, "SELF_GROWTH.md"),
    commonSkills: path.join(home, "skills"),
    commonAgents: path.join(home, "agents"),
    commonCommands: path.join(home, "commands"),
    commonPlugins: path.join(home, "plugins"),
    commonEndpoints: path.join(home, "endpoints"),
    workspace: path.join(home, "workspace"),
  });
  return cached;
};

/**
 * 프로젝트 전용 하네스 경로 (cwd = 프로젝트 폴더).
 * registry 머지 시 공통(getPaths)과 함께 walk. (V9.3 에서 registry 가 사용)
 */
export const projectScope = (
  cwd: string,
): { skills: string; agents: string; commands: string; settings: string } => ({
  skills: path.join(cwd, ".tiguclaw", "skills"),
  agents: path.join(cwd, ".tiguclaw", "agents"),
  commands: path.join(cwd, ".tiguclaw", "commands"),
  settings: path.join(cwd, ".tiguclaw", "settings.json"),
});

/**
 * 레거시 flat 프로젝트 자산 경로 (deprecated, 2026-07-10). `.tiguclaw/` 메타 폴더 도입 전엔
 * `<cwd>/{skills,agents,commands}` 를 평면으로 뒀다. 하위호환 — 발견 시 `.tiguclaw/`(projectScope)
 * *우선* + 이 레거시 flat 을 함께 스캔(같은 이름은 신규가 이김). 신규 쓰기는 projectScope 사용.
 * ★flat 은 프로젝트 자기 skills/·agents/ 폴더와 충돌 여지가 있어 deprecated — 새 프로젝트는 `.tiguclaw/`.
 */
export const projectScopeLegacy = (
  cwd: string,
): { skills: string; agents: string; commands: string; settings: string } => ({
  skills: path.join(cwd, "skills"),
  agents: path.join(cwd, "agents"),
  commands: path.join(cwd, "commands"),
  settings: path.join(cwd, "settings.json"),
});

// 테스트용 — 캐시 리셋 (TIGUCLAW_HOME 변경 후 재계산).
export const __resetPathsCache = (): void => {
  cached = undefined;
};

// V9.4 — export 화 (이전 module-private). migrateLegacyAgent 가 "untouched 시드"
// 정확 일치 판정에 사용 (휴리스틱 금지 — 바이트 정확 비교만 신뢰).
export const AGENT_TEMPLATE = `# tiguclaw

당신은 tiguclaw — 항상 떠 있는 멀티 LLM 비서 데몬입니다. 사용자에게 존댓말로 응대합니다.
(이 파일은 런타임 인격 hub 입니다. 자유롭게 편집하세요.)
`;

/**
 * 부팅 시 홈 디렉터리 준비 — 부재 시 생성 (mkdir 최소 + AGENT/settings 시드).
 * 멱등 (이미 있으면 무변). 데몬 부팅 초반 1회 호출.
 */
export const ensureHome = async (): Promise<void> => {
  const p = getPaths();
  for (const dir of [
    p.home,
    p.data,
    p.commonSkills,
    p.commonAgents,
    p.commonCommands,
    p.commonPlugins,
    p.commonEndpoints,
    p.workspace,
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }
  // AGENT.md / settings.json 미존재 시에만 템플릿 시드 (기존 보존).
  try {
    await fs.access(p.agentMd);
  } catch {
    await fs.writeFile(p.agentMd, AGENT_TEMPLATE);
  }
  try {
    await fs.access(p.settings);
  } catch {
    await fs.writeFile(p.settings, `${JSON.stringify({ hooks: {} }, null, 2)}\n`);
  }
  // ★옛 홈 미러 청소 (2026-08-20). 이제 헌법은 앱 정본을 직접 읽는다 — 홈에 남은 사본은
  //  아무도 안 읽으면서 **헌법처럼 보이는** 파일이라, 두면 다음에 볼 사람이 그걸 고친다.
  //  우리가 쓴 파일이고 사용자 내용이 0이며(매 부팅 통째로 덮어써 왔다) 정본이 그대로
  //  있으므로 되돌릴 수 있다. 한 번 지우면 다시 안 생긴다.
  await removeLegacyHomeSystemMd();
};

/** 옛 `<home>/SYSTEM.md` 미러 제거 — 실패는 부팅에 영향 0 (경고만). */
const removeLegacyHomeSystemMd = async (): Promise<void> => {
  const legacy = path.join(getPaths().home, "SYSTEM.md");
  if (legacy === getPaths().systemMd) return; // 오버라이드로 홈을 겨눈 경우 — 건드리지 않는다.
  try {
    await fs.unlink(legacy);
    console.log(`[paths] 옛 홈 SYSTEM.md 미러 제거 (${legacy}) — 헌법은 앱 정본을 직접 읽습니다.`);
  } catch {
    /* 없으면 정상(대부분) */
  }
};


/**
 * V9.4 — 레거시 레포 `./AGENT.md`(사용자 인격, 예: "내비서") → 홈 `getPaths().agentMd`
 * 1회 마이그레이션 (멱등·안전·비클로버). V9.2 `migrateLegacyData` copy-verify 패턴 답습.
 *
 * 배경: readAgent() 경로가 V9.4 에서 `process.cwd()/AGENT.md` → `getPaths().agentMd` 로
 *  전환된다. ensureHome 이 홈에 시드 템플릿을 깔아두므로, 그대로 두면 런타임이 사용자
 *  인격 대신 템플릿을 읽게 됨 = 인격 소실. 경로 전환과 동시에 인격을 홈으로 옮긴다.
 *
 * 발동 조건 (AND — 모두 충족 시에만):
 *  1. 레거시 `<cwd>/AGENT.md` 존재 (옮길 인격이 있음).
 *  2. 레거시 경로 ≠ 홈 경로 (홈이 곧 cwd 면 no-op).
 *  3. 홈 AGENT.md 가 **untouched 시드 템플릿**(AGENT_TEMPLATE 와 trim 바이트 일치)
 *     또는 부재. 홈을 사용자가 이미 편집했으면(시드 불일치) **절대 덮어쓰지 않고 skip**.
 *
 * 동작: 레거시 → 홈 copy(덮어쓰기, 시드 위라 안전) + 검증. 원본 ./AGENT.md 는 **보존**
 *  (🚩B — 인격 데이터 안전 우선, readAgent 는 홈 단일 소스라 공존해도 충돌 0).
 *
 * 멱등: 1회 후 홈 = 인격 내용 → 조건3 false → 2회차부터 skip. tsx watch 핫리로드 안전.
 * 실패 시 throw 0 — console.error 후 진행(데몬 생존 우선).
 */
export const migrateLegacyAgent = async (
  cwd: string = process.cwd(),
): Promise<void> => {
  const p = getPaths();
  const legacy = path.resolve(cwd, "AGENT.md");
  // 동일 경로(홈이 곧 cwd)면 no-op.
  if (legacy === p.agentMd) return;

  let legacyBody: string;
  try {
    legacyBody = await fs.readFile(legacy, "utf8");
  } catch {
    return; // 옮길 인격이 없음.
  }

  // 홈 AGENT.md 가 untouched 시드(또는 부재)일 때만 덮어쓴다.
  let homeBody: string | undefined;
  try {
    homeBody = await fs.readFile(p.agentMd, "utf8");
  } catch {
    homeBody = undefined; // 부재 — 덮어쓰기 대상.
  }
  if (homeBody !== undefined && homeBody.trim() !== AGENT_TEMPLATE.trim()) {
    // ★`log` 레벨이다 (2026-08-01 A4c). 이건 **정상 상태**다 — 이미 마이그레이션됐거나
    //  사용자가 편집한 것이고, 그때 건드리지 않는 게 이 함수의 옳은 동작이다.
    //  종전엔 `error` 라 부팅마다 1건씩 쌓였고(부팅 206회 ↔ 206건), 12일치 `[error]`
    //  515줄 중 **40%** 가 이 한 줄이었다. 정상 상태가 에러 로그의 절반을 차지하면
    //  진짜 사고가 배경 소음에 묻힌다.
    console.log(
      `[paths] migrateLegacyAgent skip: home AGENT.md is not the untouched seed (already migrated or user-edited) at ${p.agentMd} — leaving untouched.`,
    );
    return;
  }

  try {
    await fs.writeFile(p.agentMd, legacyBody);
    // 검증 — 홈 파일이 레거시 내용과 일치하는지 확인.
    const verify = await fs.readFile(p.agentMd, "utf8");
    if (verify !== legacyBody) {
      throw new Error("copy verification failed — home AGENT.md mismatch after write");
    }
    // 성공도 에러 레벨로 찍고 있었다 — 성공은 성공으로 남긴다(A4c).
    console.log(
      `[paths] migrateLegacyAgent: copied ${legacy} → ${p.agentMd} (legacy preserved).`,
    );
  } catch (err) {
    console.error(
      `[paths] migrateLegacyAgent failed (${String(err)}) — readAgent may return seed template; identity at ${legacy} is preserved.`,
    );
  }
};