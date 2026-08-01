/**
 * 회귀: **채팅 복원이 상황에 따라 갈리지 않는다** (2026-08-01, 사용자 신고).
 *
 * 신고: "대시보드에서 다른 세션 갔다 오면 선택지가 사라지고, 새로고침하면 다시 생긴다."
 *
 * 근본은 선택지 하나가 아니라 **같은 일을 하는 경로가 둘인데 서로 다른 데이터를 본 것**이다.
 *  - 새로고침 → SSE 재연결 → 서버가 **최근 50건 재생** → 그려짐
 *  - 세션 탭 이동 → SSE 는 연결된 채 → 재생 없음 → `/chat-history`(DB)로만 그림
 * 그래서 DB 에 없는 종류는 탭 이동에서만 사라졌다. 종류가 늘 때마다 양쪽에 따로 가르쳐야 했고,
 * 안 가르친 것이 조용히 갈렸다. 게다가 재생 창이 50건이라 **새로고침도 운**이었다
 * (선택지 후 이벤트 50건이 지나면 새로고침해도 안 돌아온다).
 *
 * → 복원의 진실 소스를 **DB 하나로** 모았다. 대화에 보여야 하는 이벤트는 `chat_log` 에 남고
 *   `/chat-history` 가 상황과 무관하게 같은 것을 돌려준다.
 *
 * ★이 검사가 지키는 것 두 가지:
 *  ①**동작** — 대화 가시 이벤트가 실제로 대화 기록에 남고 복원되는가.
 *  ②**드리프트** — 프런트가 버블로 그리는 종류와 서버가 "대화"로 보는 종류가 갈리지 않는가.
 *   서버는 프런트가 뭘 그리는지 알 수 없어 열거가 불가피하다. 대신 **빠지면 요란하게 실패**
 *   하게 만든다 — 조용히 빠지는 목록이 병이지 목록 자체가 병은 아니다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "chat-restore-parity",
  guards:
    "탭 이동하면 선택지가 사라지고 새로고침하면 돌아오던 것(복원 소스가 둘이라 상황마다 결과가 갈림)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore } = await import("../../store/sessions.js");
    const { recordChatMessage, getRecentChatLog } = await import("../../store/chat-log.js");
    const { CHAT_VISIBLE_EVENT_TYPES, isChatVisibleEvent } = await import(
      "../../core/chat-visible-events.js"
    );
    initStore();

    // ★① 동작 — 선택지가 대화 기록에 남고, 페이로드까지 그대로 복원된다.
    const tk = "regr:restore";
    const payload = {
      threadKey: tk,
      question: "어느 쪽으로 갈까요?",
      options: [{ label: "A안", value: "a" }, { label: "B안", value: "b" }],
    };
    recordChatMessage({
      ts: 1_800_000_000_000,
      threadKey: tk,
      channel: "http-bridge",
      role: "assistant",
      text: "", // 본문은 payload 에 있다 — 빈 text 로도 저장돼야 한다.
      notice: true,
      kind: "prompt.options",
      data: payload,
    });
    const restored = getRecentChatLog({ limit: 50, threadKey: tk });
    const row = restored.find((r) => r.kind === "prompt.options");
    out.push(
      assert(
        "★선택지가 대화 기록에 남는다(빈 text 여도 스킵되지 않는다)",
        row !== undefined,
        row === undefined ? "★복원 0건 — 탭 이동에서 사라진다" : `복원 ${restored.length}건`,
      ),
    );
    const opts = (row?.data?.options ?? []) as Array<{ label?: string }>;
    out.push(
      assert(
        "★버튼·질문이 원본 그대로 복원된다(서버가 문구를 다시 짓지 않는다)",
        row?.data?.question === payload.question && opts.length === 2 && opts[0]?.label === "A안",
        `질문=${String(row?.data?.question)} 버튼=${opts.map((o) => o.label).join(",")}`,
      ),
    );
    // 대조군 — 일반 메시지는 종전대로다(kind 없음, 빈 text 는 여전히 스킵).
    recordChatMessage({
      ts: 1_800_000_000_001,
      threadKey: tk,
      channel: "http-bridge",
      role: "assistant",
      text: "",
    });
    out.push(
      assert(
        "대조군 — kind 없는 빈 메시지는 여전히 스킵된다(무의미 로그 0)",
        getRecentChatLog({ limit: 50, threadKey: tk }).length === 1,
        `${getRecentChatLog({ limit: 50, threadKey: tk }).length}건`,
      ),
    );

    // ★② 드리프트 — 서버 판정 ↔ 프런트 복원 빌더가 **정확히 같은가**(양방향).
    //  종전 초안은 `sse.js` 를 긁어 "버블 렌더러를 부르는 분기"를 추정했는데, 한 분기가
    //  두 종류를 처리하는 곳(`turn_done || turn_error`)에서 **엉뚱한 쪽을 집었다**.
    //  추정 대신 **선언**을 본다: 프런트가 `registerChatKindBuilder("X", …)` 로 밝힌 것만이
    //  복원 가능한 종류다. 한쪽만 늘리면 반쪽이 된다 —
    //   서버만: 저장되는데 안 그려짐(빈 행 적재) / 프런트만: 그릴 것이 DB 에 없음.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const jsDir = path.join(root, "packages/dashboard/js");
    const { readdir } = await import("node:fs/promises");
    const registered = new Set<string>();
    for (const f of await readdir(jsDir)) {
      if (!f.endsWith(".js")) continue;
      const src = await readFile(path.join(jsDir, f), "utf8");
      for (const m of src.matchAll(/registerChatKindBuilder\(\s*"([a-z_.]+)"/g)) {
        registered.add(m[1]);
      }
    }
    const serverOnly = [...CHAT_VISIBLE_EVENT_TYPES].filter((t) => !registered.has(t));
    const frontOnly = [...registered].filter((t) => !isChatVisibleEvent(t));
    out.push(
      assert(
        "★서버가 남기는 종류 = 프런트가 복원하는 종류(반쪽 0)",
        serverOnly.length === 0 && frontOnly.length === 0,
        serverOnly.length === 0 && frontOnly.length === 0
          ? `양쪽 ${registered.size}종 일치: ${[...registered].join(",")}`
          : `★서버만(${serverOnly.join(",") || "-"}) / 프런트만(${frontOnly.join(",") || "-"})`,
      ),
    );
    // 대조군 — 스캔이 실제로 선언을 찾았는지(0종이면 위 단언은 공짜다).
    out.push(
      assert(
        "대조군 — 복원 빌더 선언을 실제로 찾았다(공짜 통과 아님)",
        registered.has("prompt.options"),
        `등록 ${registered.size}종: ${[...registered].join(",") || "(없음)"}`,
      ),
    );
    return out;
  },
};
