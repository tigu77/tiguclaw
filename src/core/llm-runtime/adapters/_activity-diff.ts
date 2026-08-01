/**
 * 영역 A 어댑터 공유 — `llm.activity` 의 리치 diff(`ActivityDiff`) 빌더.
 *
 * 진실 소스: `docs/decisions/2026-07-09-dashboard-tool-rich-render.md` (슬라이스 1).
 *
 * ★LLM-agnostic 하드게이트(원칙 #2): claude·codex·openai-agents 세 어댑터가 도구 인자에서
 * *동일 의미*의 구조화 diff 를 만든다. `_activity-detail.ts`(1줄 요약)의 쌍둥이 — 이 함수를
 * 셋이 공유하면 같은 입력 → 같은 diff 가 코드 차원에서 강제된다(parity DRY).
 *
 * ★캡처/렌더 분리(ADR): 여기선 *구조화*만(줄 op + 텍스트 + 카운트). 초록/빨강 뷰는
 * 대시보드 렌더 몫. diff 알고리즘은 표준 jsdiff 위임(원칙 #5 — LCS 손자작 금지).
 */

import { diffLines } from "diff";
import fs from "node:fs";
import type { ActivityDiff, ActivityDiffLine } from "../types.js";

/** 렌더용 줄 수 상한 — 초과 시 컷 + truncated. 스트림 위생. */
const MAX_LINES = 60;
/** 총 문자 상한 — 매우 긴 줄 폭주 방지. */
const MAX_CHARS = 6000;
/** 한 줄 폭 상한 — 초과 시 컷(diff 줄 하나가 미니파이 파일 전체인 경우). */
const LINE_MAX = 400;

/**
 * 파일을 읽어 위치를 구할 때의 크기 상한. 초과하면 **번호를 포기**한다.
 *
 * ★실측(2026-08-01): 15KB 0.07ms · 131KB 0.64ms · 1MB 4.0ms · **4MB 18.9ms**.
 *  선형이고 상한이 없으면 오늘 고친 jsonl 전량 재읽기(47ms 정지)와 같은 병이 된다.
 *  화면 표시용 편의 기능이 상시 데몬을 멎게 할 수는 없다 — 2MB 에서 끊는다(최악 ~9ms).
 */
const LINE_LOOKUP_MAX_BYTES = 2 * 1024 * 1024;

/**
 * `needle` 이 `content` 의 **몇 번째 줄에서 시작**하는가(1-based). 없으면 null — 순수 함수.
 *
 * ★두 어댑터가 각자 계산하지 않게 여기 하나만 둔다. claude 는 SDK 네이티브 Edit,
 *  codex 는 file-ops Edit 이라 실행 경로는 다르지만 **diff 는 이 빌더가 공유**한다.
 */
export function lineOfMatch(content: string, needle: string): number | null {
  if (needle === "") return null;
  const i = content.indexOf(needle);
  if (i < 0) return null;
  let line = 1;
  for (let k = 0; k < i; k += 1) if (content.charCodeAt(k) === 10) line += 1;
  return line;
}

/**
 * 편집 대상 파일에서 시작 줄을 구한다. **못 구하면 undefined**(지어내지 않는다).
 *
 * ★타이밍: 관측(diff 생성)은 도구 **실행 전**에 일어난다 — 라이브 이벤트로 확인했다
 *  (diff 이벤트 → +27ms → tool end). 그래서 이 시점 파일엔 아직 `old_string` 이 있다.
 *  실행 후였다면 못 찾고 undefined 로 떨어질 뿐, 틀린 번호를 만들지는 않는다.
 *
 * ★`replace_all` 처럼 매칭이 여럿이면 **첫 번째**다. diff 카드가 보여주는 게 한 덩어리이므로
 *  "이 diff 가 시작하는 곳" 으로는 맞다. 나머지 위치까지 표시하려면 diff 구조 자체가
 *  덩어리(hunk) 목록이어야 하는데, 그건 지금 필요한 게 아니다.
 */
function startLineOf(path: unknown, oldStr: string): number | undefined {
  if (typeof path !== "string" || path === "" || oldStr === "") return undefined;
  try {
    const st = fs.statSync(path);
    if (!st.isFile() || st.size > LINE_LOOKUP_MAX_BYTES) return undefined;
    return lineOfMatch(fs.readFileSync(path, "utf8"), oldStr) ?? undefined;
  } catch {
    return undefined; // 파일 없음·권한·바이너리 — 번호 없이 간다.
  }
}

function clipLine(s: string): string {
  return s.length > LINE_MAX ? s.slice(0, LINE_MAX - 1) + "…" : s;
}

/** 문자열을 줄 배열로 (끝 개행은 빈 줄 안 만들게 정리). */
function toLines(s: string): string[] {
  const arr = s.split("\n");
  if (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
  return arr;
}

/** 줄 배열 → 크기 캡 적용된 ActivityDiff (added/removed 는 호출부가 총계로 넘김). */
function capped(
  rows: ActivityDiffLine[],
  added: number,
  removed: number,
  path: string | undefined,
  startLine?: number,
): ActivityDiff {
  let truncated = false;
  const out: ActivityDiffLine[] = [];
  let chars = 0;
  for (const r of rows) {
    if (out.length >= MAX_LINES || chars >= MAX_CHARS) {
      truncated = true;
      break;
    }
    const text = clipLine(r.text);
    out.push({ op: r.op, text });
    chars += text.length + 1;
  }
  return {
    ...(path !== undefined ? { path } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    added,
    removed,
    lines: out,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Edit: old_string↔new_string 줄 diff. */
function editDiff(input: Record<string, unknown>): ActivityDiff | undefined {
  const oldStr = input.old_string;
  const newStr = input.new_string;
  if (typeof oldStr !== "string" || typeof newStr !== "string") return undefined;
  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : undefined;

  const rows: ActivityDiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldStr, newStr)) {
    const op: "+" | "-" | " " = part.added ? "+" : part.removed ? "-" : " ";
    for (const line of toLines(part.value)) {
      rows.push({ op, text: line });
      if (op === "+") added++;
      else if (op === "-") removed++;
    }
  }
  if (rows.length === 0) return undefined;
  return capped(rows, added, removed, path, startLineOf(path, oldStr));
}

/** Write: 쓴 내용 전부 추가(before 는 관측 시점에 없음 — I/O 결합 회피). */
function writeDiff(input: Record<string, unknown>): ActivityDiff | undefined {
  const content = input.content;
  if (typeof content !== "string") return undefined;
  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : undefined;
  const lines = toLines(content);
  if (lines.length === 0) return undefined;
  const rows: ActivityDiffLine[] = lines.map((text) => ({ op: "+" as const, text }));
  // 파일 전체를 새로 쓰는 것이므로 **1번 줄부터**다 — 읽을 필요 없이 확정이다.
  return capped(rows, lines.length, 0, path, 1);
}

/**
 * 정규화된 tool input 객체 → 구조화 diff (Edit/Write 만, 그 외 undefined).
 * best-effort — 어떤 예외도 undefined 로(턴을 무르지 않음, 원칙 #3).
 */
export function buildActivityDiff(
  toolName: string,
  input: Record<string, unknown> | undefined | null,
): ActivityDiff | undefined {
  if (!input || typeof input !== "object") return undefined;
  try {
    if (toolName === "Edit") return editDiff(input);
    if (toolName === "Write") return writeDiff(input);
  } catch {
    /* diff 생성 실패가 관측/턴을 무르지 않는다. */
  }
  return undefined;
}

/**
 * JSON 문자열 인자(codex/openai function_call arguments) → 구조화 diff.
 * 파싱 실패/비객체면 undefined. best-effort.
 */
export function buildActivityDiffFromJson(
  toolName: string,
  argsJson: string | undefined | null,
): ActivityDiff | undefined {
  if (toolName !== "Edit" && toolName !== "Write") return undefined;
  if (!argsJson || argsJson.trim() === "" || argsJson.trim() === "{}") return undefined;
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return buildActivityDiff(toolName, parsed as Record<string, unknown>);
    }
  } catch {
    /* 부분 JSON — diff 생략(detail 은 원문 요약으로 별도 확보). */
  }
  return undefined;
}
