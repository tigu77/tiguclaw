/**
 * self-growth V4 — SELF_GROWTH.md 확정 지침 층 (파일 관리 헬퍼).
 *
 * 위치: `<TIGUCLAW_HOME>/SELF_GROWTH.md` (getPaths().selfGrowthMd) — AGENT.md·SYSTEM.md
 *  와 동급 홈 markdown. 코어는 이 파일을 모른다 — self-growth 플러그인이 *데이터로만*
 *  쓰고, 비서는 `growth_directive_pointer` 메모 안내로 작업 시작 시 Read 한다(단방향).
 *
 * 설계 (임무 §1):
 *  - **원자적 쓰기**: temp 파일(`SELF_GROWTH.md.tmp-<pid>-<n>`) write → 같은 dir 로 rename.
 *    부분 쓰기·crash 중 손상 방지 (POSIX rename atomicity). 항상 *전체 파일*을 재직렬화해
 *    rename 으로 교체 (append 아님 — append 는 부분쓰기 위험 + 키 덮어쓰기 불가).
 *  - **단일 writer 직렬화**: 모든 변경(upsert/cleanup/prune)을 in-process promise chain
 *    (`writeLock`) 으로 직렬화. maintenance interval ↔ event handler 동시 쓰기로 last-write
 *    -wins 충돌·tmp 경합이 안 나게 한다. 같은 프로세스 단일 writer 가정(데몬 1 인스턴스).
 *  - **교정 가능 구조**: 각 지침에 안정 키(상황 slug). 같은 키 재확정 시 그 블록을 *덮어씀*
 *    (append 아님). 사람이 읽는 markdown + 비서 1 Read 통독.
 *  - **하드캡·TTL**: top-N(DIRECTIVE_HARD_CAP) 초과 시 가장 오래된/덜 쓰인 지침 제거.
 *    TTL(DIRECTIVE_TTL_DAYS) 지난 미사용 지침 정리(V2.1 cleanup 패턴 답습).
 *
 * 견고성: 모든 공개 함수 try/catch boundary — 파일 I/O 실패해도 throw 0(데몬 생존).
 *  파싱 실패 시 빈 목록으로 수렴(손상 파일이 후속 쓰기를 막지 않음 — 다음 쓰기가 정상 재생성).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getPaths } from "../core/paths.js";

// ─── 상수 ────────────────────────────────────────────────────────────────────

/** 확정 지침 최대 보관 수 — 초과 시 가장 오래 안 쓰인 것부터 제거. */
export const DIRECTIVE_HARD_CAP = 50;

/** 미사용 지침 TTL(일) — 마지막 확정·사용 이후 이 기간 지나면 정리. */
export const DIRECTIVE_TTL_DAYS = 120;

/** 파일 헤더 — 비서가 1 Read 로 맥락을 잡게. */
const FILE_HEADER = `# SELF_GROWTH.md — 확정 지침 층

이 파일은 self-growth 가 자율(저위험) 또는 사용자 승격으로 확정한 *작업 지침*을 모은
운영 메모리입니다. 작업을 시작할 때 이 파일을 읽고 해당 상황의 지침을 적용하세요.

- 코어(SYSTEM.md·AGENT.md·sysprompt)는 이 파일을 모릅니다 — self-growth 가 데이터로만 관리.
- 각 지침은 안정 키(상황 slug)로 식별되며 같은 상황 재확정 시 덮어쓰기됩니다(중복 누적 없음).
- 자율 확정은 *저위험* 한정. 사용자 승격분은 \`source: user\` 로 표시됩니다.

<!-- 이 아래는 self-growth 가 자동 관리합니다. 직접 편집 가능하나 키/구분자 형식을 유지하세요. -->
`;

/**
 * 파일이 없으면 헤더만으로 seed 생성 — 포인터 메모(`growth_directive_pointer`)가 매 턴
 * "작업 시작 시 SELF_GROWTH.md 를 Read 하라"고 안내하는데, 확정 지침이 아직 하나도 안
 * 쓰인 인스턴스(fresh install)엔 파일이 없어 비서가 "SELF_GROWTH.md 못 찾음" 하던 버그
 * 수정 — 포인터가 dangling 하지 않게 한다. 이미 있으면 no-op. never-throw(데몬 생존).
 * `wx` flag 로 access↔write 사이 경합도 안전(그 사이 생겼으면 write 실패→흡수).
 */
export const ensureSelfGrowthFile = async (): Promise<void> => {
  try {
    const file = getPaths().selfGrowthMd;
    try {
      await fs.access(file);
      return; // 이미 존재 → no-op
    } catch {
      /* 없음 → seed 생성 */
    }
    await fs.writeFile(file, FILE_HEADER, { flag: "wx" }).catch(() => {});
  } catch {
    /* best-effort — 생성 실패해도 throw 0 */
  }
};

// 각 지침 블록 구분자 (machine-parse 가능 + 사람이 읽기 좋은 HTML 주석 마커).
const BLOCK_BEGIN = "<!-- directive:";
const BLOCK_END = "<!-- /directive -->";

// ─── 데이터 모델 ──────────────────────────────────────────────────────────────

export type DirectiveSource = "auto" | "user";

export interface Directive {
  /** 안정 키 (상황 slug) — 같은 키 재확정 시 덮어쓰기 기준. */
  key: string;
  /** 사람·비서가 읽는 명령형 한 줄(+선택 다줄) 지침 본문. */
  text: string;
  /** auto = self-growth 자율(저위험), user = 사용자 승격/직접 교정. */
  source: DirectiveSource;
  /** 그룹/우선순위 표시용(선택). 예: "failure", "preference". */
  group?: string;
  /** 최초 확정 시각(ms). */
  createdAt: number;
  /** 마지막 확정·사용 시각(ms) — TTL·LRU 기준. */
  updatedAt: number;
}

// ─── 직렬화 / 파싱 ────────────────────────────────────────────────────────────

const escapeKey = (key: string): string => key.replace(/[^a-z0-9_.-]+/gi, "_");

const renderBlock = (d: Directive): string => {
  // 메타데이터는 마커 주석에 JSON 으로(사람이 본문만 읽어도 됨, 기계는 메타 파싱).
  const meta = JSON.stringify({
    key: d.key,
    source: d.source,
    group: d.group,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  });
  const heading = d.group !== undefined ? `### [${d.group}] ${d.key}` : `### ${d.key}`;
  const tag = d.source === "user" ? " (source: user)" : "";
  return [
    `${BLOCK_BEGIN} ${escapeKey(d.key)} ${meta} -->`,
    `${heading}${tag}`,
    "",
    d.text.trim(),
    "",
    BLOCK_END,
  ].join("\n");
};

export const renderFile = (directives: Directive[]): string => {
  // 우선순위: source(user 먼저) → group → updatedAt desc. 사람이 보기 좋은 정렬.
  const sorted = [...directives].sort((a, b) => {
    if (a.source !== b.source) return a.source === "user" ? -1 : 1;
    const ga = a.group ?? "";
    const gb = b.group ?? "";
    if (ga !== gb) return ga.localeCompare(gb);
    return b.updatedAt - a.updatedAt;
  });
  const blocks = sorted.map(renderBlock).join("\n\n");
  return `${FILE_HEADER}\n${blocks}\n`;
};

/**
 * 파일 본문 파싱 — 마커 블록에서 메타 JSON 을 복원. 손상/구버전 블록은 skip(robust).
 * 파싱 실패 시 빈 배열(다음 쓰기가 정상 재생성). 절대 throw 안 함.
 */
export const parseFile = (body: string): Directive[] => {
  const out: Directive[] = [];
  if (typeof body !== "string" || body.length === 0) return out;
  // BLOCK_BEGIN 마커 줄에서 JSON 메타만 신뢰 (heading/본문은 표시용 — 메타가 진실 소스).
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const beginIdx = line.indexOf(BLOCK_BEGIN);
    if (beginIdx === -1) {
      i++;
      continue;
    }
    // 메타 JSON 추출: `<!-- directive: <slug> {json} -->`
    const after = line.slice(beginIdx + BLOCK_BEGIN.length);
    const jsonStart = after.indexOf("{");
    const jsonEnd = after.lastIndexOf("}");
    let meta: Partial<Directive> | null = null;
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      try {
        meta = JSON.parse(after.slice(jsonStart, jsonEnd + 1)) as Partial<Directive>;
      } catch {
        meta = null;
      }
    }
    // 본문 = 다음 줄들 중 heading(### …) 다음, BLOCK_END 전까지.
    const textLines: string[] = [];
    let j = i + 1;
    let sawHeading = false;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.includes(BLOCK_END)) break;
      if (!sawHeading && l.trimStart().startsWith("###")) {
        sawHeading = true;
        continue;
      }
      if (sawHeading) textLines.push(l);
    }
    i = j + 1;
    if (
      meta !== null &&
      typeof meta.key === "string" &&
      meta.key.length > 0 &&
      typeof meta.createdAt === "number" &&
      typeof meta.updatedAt === "number"
    ) {
      out.push({
        key: meta.key,
        text: textLines.join("\n").trim(),
        source: meta.source === "user" ? "user" : "auto",
        group: typeof meta.group === "string" ? meta.group : undefined,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      });
    }
  }
  return out;
};

// ─── 단일 writer 직렬화 ──────────────────────────────────────────────────────

// 모든 mutate 작업을 직렬화하는 promise chain. maintenance interval ↔ event handler
// 가 동시에 들어와도 한 번에 하나씩만 read-modify-write 한다(경합·last-write-wins 방지).
let writeLock: Promise<unknown> = Promise.resolve();
let tmpCounter = 0;

const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = writeLock.then(fn, fn);
  // 다음 작업이 이전 실패에 막히지 않게 — 결과 무시한 chain 으로 lock 만 이어감.
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

// ─── 저수준 read / atomic write ──────────────────────────────────────────────

const readDirectivesRaw = async (): Promise<Directive[]> => {
  const file = getPaths().selfGrowthMd;
  let body: string;
  try {
    body = await fs.readFile(file, "utf8");
  } catch {
    return []; // 부재 = 빈 목록.
  }
  return parseFile(body);
};

const atomicWrite = async (directives: Directive[]): Promise<void> => {
  const file = getPaths().selfGrowthMd;
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.SELF_GROWTH.md.tmp-${process.pid}-${tmpCounter++}`,
  );
  const body = renderFile(directives);
  // temp write → 같은 dir 로 rename (atomic). dir 부재 시 mkdir(ensureHome 전 호출 대비).
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // 무시 — 이미 있거나 권한 문제면 write 에서 드러남.
  }
  await fs.writeFile(tmp, body, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // rename 실패 시 tmp 정리 시도 후 재throw (serialize 가 catch).
    try {
      await fs.unlink(tmp);
    } catch {
      // 무시.
    }
    throw err;
  }
};

// ─── 정리 (cap + TTL) ────────────────────────────────────────────────────────

/**
 * 캡·TTL 적용 — TTL 지난 auto 지침 제거 후, 하드캡 초과분을 updatedAt 오름차순(가장
 * 오래 안 쓰인 것)으로 제거. **user 승격 지침은 TTL·캡 양쪽에서 보호**(사용자 명시 확정은
 * 자동 폐기 금지 — 파괴적 행위 승인 원칙). auto 만 자동 정리 대상.
 */
export const applyCapAndTtl = (
  directives: Directive[],
  opts?: { cap?: number; ttlDays?: number; now?: number },
): { kept: Directive[]; removed: Directive[] } => {
  const cap = opts?.cap ?? DIRECTIVE_HARD_CAP;
  const ttlDays = opts?.ttlDays ?? DIRECTIVE_TTL_DAYS;
  const now = opts?.now ?? Date.now();
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;

  const removed: Directive[] = [];
  // 1) TTL — auto 만, updatedAt 이 cutoff 이전.
  let kept = directives.filter((d) => {
    if (d.source === "user") return true;
    if (d.updatedAt <= cutoff) {
      removed.push(d);
      return false;
    }
    return true;
  });

  // 2) 하드캡 — 초과 시 auto 중 updatedAt 오름차순(LRU)으로 제거. user 는 보호.
  if (kept.length > cap) {
    const autos = kept
      .filter((d) => d.source === "auto")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let over = kept.length - cap;
    const dropKeys = new Set<string>();
    for (const d of autos) {
      if (over <= 0) break;
      dropKeys.add(d.key);
      removed.push(d);
      over--;
    }
    kept = kept.filter((d) => !dropKeys.has(d.key));
  }
  return { kept, removed };
};

// ─── 공개 API (전부 serialize + never-throw) ─────────────────────────────────

export interface UpsertDirectiveInput {
  key: string;
  text: string;
  source?: DirectiveSource;
  group?: string;
}

/**
 * 확정 지침 upsert — 같은 key 있으면 본문·source·group 덮어쓰기(append 아님) + updatedAt
 * 갱신, 없으면 추가. 쓰기 후 cap·TTL 적용. 직렬화 + never-throw.
 * @returns 성공 시 최종 Directive, 실패 시 null.
 */
export const upsertDirective = (
  input: UpsertDirectiveInput,
): Promise<Directive | null> =>
  serialize(async () => {
    try {
      const now = Date.now();
      const directives = await readDirectivesRaw();
      const idx = directives.findIndex((d) => d.key === input.key);
      let result: Directive;
      if (idx >= 0) {
        const prev = directives[idx]!;
        result = {
          key: input.key,
          text: input.text,
          // user 승격은 auto 로 강등 금지 — 한번 user 면 user 유지(명시 확정 보호).
          source: input.source ?? (prev.source === "user" ? "user" : "auto"),
          group: input.group ?? prev.group,
          createdAt: prev.createdAt,
          updatedAt: now,
        };
        directives[idx] = result;
      } else {
        result = {
          key: input.key,
          text: input.text,
          source: input.source ?? "auto",
          group: input.group,
          createdAt: now,
          updatedAt: now,
        };
        directives.push(result);
      }
      const { kept } = applyCapAndTtl(directives, { now });
      await atomicWrite(kept);
      return result;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth-md: upsertDirective failed: ${reason}`);
      return null;
    }
  });

/** 키로 1건 조회 (없으면 null). never-throw. */
export const getDirective = (key: string): Promise<Directive | null> =>
  serialize(async () => {
    try {
      const directives = await readDirectivesRaw();
      return directives.find((d) => d.key === key) ?? null;
    } catch {
      return null;
    }
  });

/** 전체 목록 (정렬은 renderFile 순서와 무관 — 호출자 책임). never-throw → 실패 시 []. */
export const listDirectives = (): Promise<Directive[]> =>
  serialize(async () => {
    try {
      return await readDirectivesRaw();
    } catch {
      return [];
    }
  });

/** 키로 1건 삭제. 삭제했으면 true. never-throw. */
export const deleteDirective = (key: string): Promise<boolean> =>
  serialize(async () => {
    try {
      const directives = await readDirectivesRaw();
      const next = directives.filter((d) => d.key !== key);
      if (next.length === directives.length) return false;
      await atomicWrite(next);
      return true;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth-md: deleteDirective failed: ${reason}`);
      return false;
    }
  });

/**
 * 명시 정리 — cap·TTL 만 재적용(upsert 없이). maintenance interval 이 호출.
 * @returns 제거된 지침 수 (실패 시 0).
 */
export const cleanupDirectives = (opts?: {
  cap?: number;
  ttlDays?: number;
}): Promise<number> =>
  serialize(async () => {
    try {
      const directives = await readDirectivesRaw();
      const { kept, removed } = applyCapAndTtl(directives, opts);
      if (removed.length === 0) return 0;
      await atomicWrite(kept);
      return removed.length;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`self-growth-md: cleanupDirectives failed: ${reason}`);
      return 0;
    }
  });
