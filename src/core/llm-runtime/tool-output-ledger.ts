/**
 * **현재 실행의 도구 결과 보관함** — 진입 상한·턴 안 압축으로 모델 입력에서 생략된 결과를 **같은 턴 안에서** 다시 읽는 자리
 * (2026-11-19, docs/decisions/2026-11-19-tool-output-recovery-design.md §3-1).
 *
 * ★왜: 저장 참조(`<기록id>#<순번>`)는 턴이 끝나 기록될 때 생긴다. 진행 중인 턴에서 방금 잘린 결과는 가리킬 길이 없어, 뉴돌쇠가
 *  예약 목록 가운데를 끝내 못 읽고 게시를 보류했다(11-18·11-19).
 * ★실행마다 하나 — 어댑터가 턴 시작에 만들어 결과 진입·재조회 도구에 같이 넘긴다(클로저). 다른 실행·다른 대화의 보관함은
 *  보이지 않는다. 참조는 실행 토큰을 담아(`r<8자>.<순번>`) 호출 번호(`call_id`)만으로 남의 값을 읽는 일이 없다.
 * ★같은 참조 문자열을 저장 항목의 `ref` 에도 남긴다 → 턴이 끝난 뒤엔 저장본에서 같은 참조로 읽힌다(`store/tool-recall.ts`).
 *  취소·실패로 기록되지 않은 실행의 참조는 거기서 «찾을 수 없음» 이 된다.
 * 담는 글은 **가린 보존본**이다(호출자가 만든다) — 보관함은 다시 가리지 않는다.
 */
import { randomInt } from "node:crypto";

export interface ToolOutputLedgerEntry {
  tool: string;
  /** 호출 인자(가린 것). */
  args: string;
  /** 가린 보존본 — 길이·offset 의 기준. */
  text: string;
  at: number;
}

export interface ToolOutputLedger {
  readonly token: string;
  /** 넣고 참조를 돌려준다. */
  add(e: Omit<ToolOutputLedgerEntry, "at">): string;
  get(ref: string): ToolOutputLedgerEntry | undefined;
}

/** 실행 참조 모양 — 저장 참조(`\d+#\d+`)와 겹치지 않는다. */
export const RUN_REF_RE = /^r[0-9a-z]{8}\.\d+$/;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export const createToolOutputLedger = (): ToolOutputLedger => {
  const token = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const entries = new Map<string, ToolOutputLedgerEntry>();
  return {
    token,
    add: (e) => {
      const ref = `r${token}.${entries.size + 1}`;
      entries.set(ref, { ...e, at: Date.now() });
      return ref;
    },
    get: (ref) => entries.get(ref),
  };
};
