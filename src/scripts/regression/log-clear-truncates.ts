/**
 * 회귀: **로그 비우기가 파일을 지우거나 옮기지 않는다 — 내용만 비운다** (2026-08-21).
 *
 * 사고(사용자 신고): 로그 파일을 휴지통으로 옮겼더니 그 뒤로 로그가 안 쌓였다. macOS
 * 휴지통은 삭제가 아니라 **이름 바꾸기**라 inode 가 남고, 데몬은 부팅 때 연 스트림으로
 * **휴지통 안의 그 파일에** 계속 썼다. `logs/` 엔 아무것도 안 생기는데 데몬은 멀쩡히
 * 도니까 **아무 신호도 없었다.**
 *
 * ★그래서 이 기능의 존재 이유가 곧 이 검사의 대상이다 — 편의를 주려고 만든 버튼이
 *  같은 함정을 되풀이하면 안 된다. "지우기가 아니라 비우기" 는 구현 취향이 아니라
 *  **계약**이다.
 *
 * 지키는 것:
 *  ①비운 뒤에도 **같은 inode** 로 파일이 남는다(= 데몬 fd 가 계속 유효하다)
 *  ②append 스트림이 비운 뒤에도 정상으로 이어 쓴다 — **sparse(NUL) 가 안 생긴다**
 *  ③파일이 없을 때 비우기는 에러가 아니다(정상 상태)
 *  ④조회는 실패해도 throw 하지 않는다(관측이 데몬을 죽이지 않는다)
 */
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "log-clear-truncates",
  guards:
    "로그 비우기가 파일을 지우거나 옮겨 데몬이 옛 파일에 계속 쓰던 것(로그가 조용히 사라짐)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const home = mkdtempSync(path.join(tmpdir(), "logclear-"));
    const prevHome = process.env.TIGUCLAW_HOME;
    process.env.TIGUCLAW_HOME = home;
    try {
      const { readLogFileStatus, clearTodayLog, todayLogPath } = await import(
        "../../core/log-file-admin.js"
      );

      // ③ 파일이 없을 때 — 에러가 아니다.
      const none = clearTodayLog();
      out.push(
        assert(
          "파일이 없으면 비우기는 성공(0바이트) — 없는 것은 실패가 아니다",
          none.ok === true && none.clearedBytes === 0,
          JSON.stringify(none),
        ),
      );
      out.push(
        assert(
          "조회는 파일이 없어도 throw 하지 않는다",
          readLogFileStatus().exists === false,
          "exists=false",
        ),
      );

      // 데몬과 **같은 방식**으로 연다(O_APPEND). 이게 이 검사의 핵심 전제다.
      const p = todayLogPath();
      mkdirSync(path.dirname(p), { recursive: true });
      const stream = createWriteStream(p, { flags: "a" });
      await new Promise<void>((r) => stream.write("첫 줄 — 비워질 내용\n", () => r()));

      const before = statSync(p);
      const st = readLogFileStatus();
      out.push(
        assert(
          "조회가 크기·마지막 기록을 준다(볼 수 없는 것을 지우지 않게)",
          st.exists && st.bytes === before.size && st.lastWriteTs !== null,
          `bytes=${st.bytes} lastWrite=${st.lastWriteTs !== null}`,
        ),
      );

      const cleared = clearTodayLog();
      // ★`statSync` 를 그대로 부르면 파일이 사라졌을 때 **검사가 크래시**한다 — 변이는
      //  잡히지만 "무엇이 깨졌는지" 를 안 알려준다(실제로 unlink·rename 변이에서 그랬다).
      //  없어졌다는 것 자체가 이 검사가 잡아야 할 결함이므로, 그걸 **단언 메시지**로 만든다.
      const after = ((): { ino: number; size: number } | null => {
        try {
          const s = statSync(p);
          return { ino: s.ino, size: s.size };
        } catch {
          return null;
        }
      })();
      out.push(
        assert(
          "★비운 뒤에도 **같은 파일(inode)** 이 남는다 — 데몬 fd 가 계속 유효하다",
          cleared.ok === true &&
            after !== null &&
            after.ino === before.ino &&
            after.size === 0,
          after === null
            ? "★파일이 사라졌다 — 비우기가 아니라 지우기/옮기기를 했다(데몬이 옛 파일에 계속 쓴다)"
            : `ok=${cleared.ok} inode ${before.ino}→${after.ino} size=${after.size}`,
        ),
      );
      out.push(
        assert(
          "비운 양을 알려준다(무엇을 지웠는지 사용자가 안다)",
          cleared.clearedBytes === before.size,
          `${cleared.clearedBytes} vs ${before.size}`,
        ),
      );

      // ② 비운 뒤 이어 쓰기 — append 라 offset 0 부터. sparse 가 생기면 NUL 이 섞인다.
      await new Promise<void>((r) => stream.write("비운 뒤 첫 줄\n", () => r()));
      await new Promise<void>((r) => stream.end(() => r()));
      const body = ((): Buffer | null => {
        try {
          return readFileSync(p);
        } catch {
          return null;
        }
      })();
      const nulls = body === null ? -1 : body.filter((b) => b === 0).length;
      out.push(
        assert(
          "★비운 뒤 이어 쓴 내용에 NUL(sparse) 이 없다 — append 스트림이 정상 이어짐",
          body !== null && nulls === 0 && body.toString() === "비운 뒤 첫 줄\n",
          body === null
            ? "★파일이 없어 이어 쓰기가 어디로 갔는지 알 수 없다"
            : `NUL=${nulls} body=${JSON.stringify(body.toString().slice(0, 40))}`,
        ),
      );
    } finally {
      if (prevHome === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
    return out;
  },
};
