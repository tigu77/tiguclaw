/**
 * **자식 프로세스에서 단언을 모으는** 작은 틀 (2026-11-03, 프로젝트 공통 커맨드).
 *
 * ★왜 자식인가: 홈 플러그인 설치·`settings.json` 의 `modules` 기록·`LIVE` 표·`process.cwd()`·`PATH` 는 **프로세스 전역**이다.
 *  러너 프로세스에서 바꾸면 같은 실행의 다른 검사가 그 흔적을 본다. 자식은 자기 임시 홈(러너 홈 아래)에서 돌고 끝나면 사라진다.
 *  자식은 마지막에 표식 줄 하나로 단언 목록을 낸다 — 제품 로그가 stdout 에 섞여도 그 줄만 읽는다.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, type Assertion } from "./_framework.js";

const MARK = "@@CHILD-ASSERTIONS@@";

/** 부모: 자식 파일을 돌려 단언을 받는다. 자식이 끝까지 못 가면 실패 단언 하나(종료 코드·stderr 꼬리). */
export const runChildChecks = (childUrl: URL, timeoutMs = 180_000): Assertion[] => {
  const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(childUrl)], {
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith(MARK));
  if (line === undefined) {
    return [assert(`자식 검사(${fileURLToPath(childUrl).split("/").at(-1)})가 끝까지 돌았다`, false, { exit: r.status, signal: r.signal, err: (r.stderr ?? "").slice(-1500), out: (r.stdout ?? "").slice(-800) })];
  }
  return (JSON.parse(line.slice(MARK.length)) as { assertions: Assertion[] }).assertions;
};

/** 자식: 단언을 모으고 끝에 한 줄로 낸다. */
export const childCollector = () => {
  const out: Assertion[] = [];
  return {
    check: (name: string, ok: boolean, got: unknown): void => {
      out.push(assert(name, ok, got));
    },
    done: (): never => {
      process.stdout.write(`\n${MARK}${JSON.stringify({ assertions: out })}\n`, () => process.exit(0));
      // 쓰기 콜백이 exit 한다 — 여기서 멈춘다.
      return undefined as never;
    },
  };
};
