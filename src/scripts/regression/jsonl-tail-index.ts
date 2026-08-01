/**
 * 회귀: **claude 세션 jsonl 을 매 턴 통째로 다시 읽지 않는다** (2026-08-01 A4a).
 *
 * 사고 형상: `indexJsonlIfNeeded` 가 새 줄 몇 개를 얻으려고 **파일 전체**를 동기로 읽었다.
 * 줄 수(`lines_indexed`)만 기억하고 바이트 위치를 안 기억했기 때문이다.
 *  - 라이브 실측: 19.7MB 세션 → **47ms 이벤트루프 정지 · 270MB 피크 RSS**
 *  - 꼬리만 읽는 대조군: 0.7ms · 42MB → **67배**
 *  - 세션이 길수록 선형으로 나빠지고 **상한이 없다**. 상시 데몬이 매 claude 턴마다
 *    그만큼 멎으면 텔레그램·SSE·스케줄러가 같이 멎는다.
 *
 * ★이 검사의 본체는 속도가 아니라 **등가성**이다. 빨라지려다 줄을 빠뜨리거나 중복
 *  색인하면 대화 기록이 조용히 망가진다 — 그건 속도보다 훨씬 비싸다. 그래서 매 단계
 *  "전체를 읽었을 때와 같은 결과인가" 를 대조한다.
 */
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const rec = (role: string, text: string): string =>
  `${JSON.stringify({ type: role, message: { role, content: text } })}\n`;

export const check: RegressionCheck = {
  name: "jsonl-tail-index",
  guards:
    "claude 턴마다 세션 jsonl 전체를 동기로 재읽어 이벤트루프가 47ms 멎고 RSS 가 270MB 튀던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore } = await import("../../store/sessions.js");
    const { indexJsonlIfNeeded, loadCodexTurnHistoryBySessionId } = await import(
      "../../store/memory.js"
    );
    // 세션의 색인된 대화를 시간순으로 읽는다(role user/assistant 만 — jsonl 픽스처가 그것뿐).
    const getTranscripts = (sid: string): Array<{ content: string }> =>
      loadCodexTurnHistoryBySessionId(sid, { limitTurns: 1000 });
    initStore();

    const dir = await mkdtemp(path.join(tmpdir(), "tiguclaw-jsonl-"));
    try {
      const file = path.join(dir, "session.jsonl");
      const sid = "regr-jsonl-session";
      const key = { channel: "cli" as const, threadKey: "regr:jsonl", claudeSessionId: sid };

      // ① 첫 색인 — 레거시 행(바이트 위치 없음)과 같은 경로.
      await writeFile(file, rec("user", "첫 질문") + rec("assistant", "첫 답변"), "utf8");
      const r1 = indexJsonlIfNeeded({ ...key, jsonlPath: file });
      out.push(
        assert("첫 색인이 전부 들어간다", r1.lines === 2, `${r1.lines}줄`),
      );

      // ② 자란 만큼만 색인 — 이미 넣은 줄을 **다시 넣지 않는다**(중복 = 기록 오염).
      await appendFile(file, rec("user", "두번째 질문"), "utf8");
      const r2 = indexJsonlIfNeeded({ ...key, jsonlPath: file });
      out.push(
        assert("★자란 줄만 색인한다(중복 0)", r2.lines === 1, `${r2.lines}줄`),
      );

      // ③ 안 자랐으면 0 — 파일을 열지도 않는다.
      const r3 = indexJsonlIfNeeded({ ...key, jsonlPath: file });
      out.push(assert("안 자랐으면 색인 0", r3.lines === 0, `${r3.lines}줄`));

      // ★④ 등가성 — 누적 결과가 "전체를 읽었을 때" 와 같아야 한다.
      const rows = getTranscripts(sid);
      const texts = rows.map((t) => t.content);
      out.push(
        assert(
          "★누적 결과가 전체 읽기와 동일하다(순서·개수·내용)",
          texts.length === 3 &&
            texts[0] === "첫 질문" &&
            texts[1] === "첫 답변" &&
            texts[2] === "두번째 질문",
          `${texts.length}건: ${texts.join(" / ")}`,
        ),
      );

      // ★⑤ 쓰다 만 줄(개행 없음)은 **소비하지 않는다** — 부분 파싱은 조용한 유실이 된다.
      await appendFile(file, `{"type":"user","message":{"role":"user","content":"아직 쓰`, "utf8");
      const r5 = indexJsonlIfNeeded({ ...key, jsonlPath: file });
      out.push(
        assert(
          "★개행 없는 마지막 조각은 건너뛴다(부분 줄 색인 0)",
          r5.lines === 0 && getTranscripts(sid).length === 3,
          `색인 ${r5.lines}줄 · 누적 ${getTranscripts(sid).length}건`,
        ),
      );
      // 그리고 그 줄이 완성되면 **그때 들어온다**(건너뛴 게 유실이 아니다).
      await appendFile(file, `는 중"}}\n`, "utf8");
      const r6 = indexJsonlIfNeeded({ ...key, jsonlPath: file });
      out.push(
        assert(
          "★완성되면 그때 색인된다(건너뛴 줄이 유실되지 않는다)",
          r6.lines === 1 && getTranscripts(sid).length === 4,
          `색인 ${r6.lines}줄 · 누적 ${getTranscripts(sid).length}건`,
        ),
      );

      // ★⑥ 파일이 줄면(회전·절단) 전체 재읽기로 안전 복귀 — 바이트 위치를 맹신하면
      //  엉뚱한 지점부터 읽어 쓰레기를 색인한다.
      const key2 = { ...key, claudeSessionId: "regr-jsonl-rotated" };
      const rotated = path.join(dir, "rotated.jsonl");
      await writeFile(rotated, rec("user", "긴 세션") + rec("assistant", "긴 답변"), "utf8");
      indexJsonlIfNeeded({ ...key2, jsonlPath: rotated });
      await writeFile(rotated, rec("user", "회전 후 첫 줄"), "utf8"); // 더 작아짐
      const r7 = indexJsonlIfNeeded({ ...key2, jsonlPath: rotated });
      const rotTexts = getTranscripts("regr-jsonl-rotated").map((t) => t.content);
      out.push(
        assert(
          "★파일이 줄면 전체 재읽기로 복귀한다(쓰레기 색인 0)",
          r7.lines === 1 && rotTexts.includes("회전 후 첫 줄"),
          `색인 ${r7.lines}줄 · ${rotTexts.join(" / ")}`,
        ),
      );

      // ★⑦ 비용 — 큰 파일에 한 줄 붙였을 때 **전체를 읽지 않는다**. 시간이 아니라
      //  "읽은 바이트" 로 본다(타이밍은 기계마다 흔들려 플래키하다).
      const key3 = { ...key, claudeSessionId: "regr-jsonl-big" };
      const big = path.join(dir, "big.jsonl");
      await writeFile(big, rec("user", "x".repeat(200)).repeat(4000), "utf8"); // ~1MB
      indexJsonlIfNeeded({ ...key3, jsonlPath: big });
      const fsMod = await import("node:fs");
      const realRead = fsMod.default.readFileSync;
      let fullReadBytes = 0;
      const spy = ((...args: Parameters<typeof realRead>) => {
        const res = realRead(...args);
        if (typeof res === "string") fullReadBytes += res.length;
        return res;
      }) as typeof realRead;
      (fsMod.default as { readFileSync: typeof realRead }).readFileSync = spy;
      try {
        await appendFile(big, rec("user", "새 줄 하나"), "utf8");
        indexJsonlIfNeeded({ ...key3, jsonlPath: big });
      } finally {
        (fsMod.default as { readFileSync: typeof realRead }).readFileSync = realRead;
      }
      out.push(
        assert(
          "★1MB 파일에 한 줄 추가 시 전체를 다시 읽지 않는다",
          fullReadBytes === 0,
          fullReadBytes === 0
            ? "readFileSync 전체 읽기 0회 (꼬리만)"
            : `★전체 읽기 ${fullReadBytes}자 — 여전히 통째로 읽는다`,
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return out;
  },
};
