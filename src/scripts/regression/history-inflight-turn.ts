/**
 * 회귀: **탭 전환 시 진행 중 턴이 보인다** (2026-07-30).
 *
 * 사고: 다른 세션 탭을 누르면 그 세션에서 *돌고 있는* 턴이 통째로 안 보였다. 도구 스텝도
 * 쓰고 있던 텍스트도 없고, 뒤이어 오는 SSE 가 별도 카드를 만들어 한 턴이 둘로 갈라졌다.
 *
 * 원인은 **두 겹**이었고 둘 다 서버였다(프런트 방어 코드는 멀쩡했는데 재료를 못 받았다):
 *
 *  ①상한 컷 — `historyActivities` 가 활동을 `chat_log` 마지막 행 시각으로 잘랐다.
 *   그런데 chat_log 는 `channel.message.in`(사용자 발화, 즉시) / `channel.message.out`
 *   (비서 응답, **턴 완료 후**)로만 쌓인다. 진행 중 턴엔 assistant 행이 없으니
 *   상한 = 사용자 발화 시각이고, 그 턴의 활동은 전부 그 뒤라 **100% 버려졌다**.
 *   → `tabs.js` 의 "진행 중 턴 seamless 재개"(`activeTurns.has(tk) && activities.length > 0`)가
 *     **한 번도 발동하지 못했다.** 방어 코드가 있는데 조건이 구조적으로 거짓이었다.
 *
 *  ②정렬 뒤집힘 — `listEvents` 가 `ORDER BY id DESC` 라 activities 가 최신순으로 나갔는데,
 *   분할 로직은 배열 끝에서부터 seq 증가 구간을 되짚어 "마지막 턴"을 찾는다(ASC 가정).
 *   DESC 면 가장 오래된 1건만 집는다. ①에 가려 드러나지 않았다.
 *
 * ★이 검사가 지키는 진짜 성질: "방어 코드가 있다"가 아니라 **"그 조건이 실제로 참이 된다"**.
 */
import { initStore } from "../../store/sessions.js";
import { recordChatMessage } from "../../store/chat-log.js";
import { insertEvent } from "../../store/events.js";
import { sourceHas } from "./_wiring.js";
import {
  assert,
  assertIsolated,
  type Assertion,
  type RegressionCheck,
} from "./_framework.js";

const TK = "dashboard:regr-inflight";

export const check: RegressionCheck = {
  name: "history-inflight-turn",
  guards:
    "탭 전환 시 진행 중 턴이 통째로 안 보이고 한 턴이 두 카드로 갈라지던 것(상한 컷 + 정렬 뒤집힘)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const t0 = Date.now() - 60_000;
    // 진행 중 턴 재현: 사용자 발화만 chat_log 에 있고(assistant 행 없음),
    // 그 뒤로 도구 스텝·텍스트 세그먼트가 쌓이는 중.
    recordChatMessage({
      ts: t0,
      threadKey: TK,
      channel: "dashboard",
      role: "user",
      text: "진행 중 턴 재현",
    });
    for (let i = 0; i < 3; i++) {
      insertEvent(
        t0 + 1000 * (i + 1),
        "llm.activity",
        JSON.stringify({
          threadKey: TK,
          adapter: "claude",
          seq: i,
          label: `Tool${i}`,
          detail: "d",
          kind: "tool",
          phase: "start",
        }),
      );
    }

    // /chat-history 최신 페이지가 하는 것과 동일 계약으로 재현한다.
    const { listEvents } = await import("../../store/events.js");
    const raw = listEvents({ types: ["llm.activity"], sinceTs: t0, limit: 3000 })
      .map((e) => {
        try {
          return { ts: e.ts, p: JSON.parse(e.payload) as Record<string, unknown> };
        } catch {
          return null;
        }
      })
      .filter((x): x is { ts: number; p: Record<string, unknown> } => x !== null)
      .filter((x) => x.p.threadKey === TK);

    const out: Assertion[] = [
      assert(
        "★진행 중 턴의 활동이 조회된다(상한 컷에 안 잘린다)",
        raw.length === 3,
        `${raw.length}/3건 — 사용자 발화 이후 시각`,
      ),
    ];

    // ②정렬 — 서버가 ASC 로 내보내야 tabs.js 의 "마지막 seq-run" 분할이 성립한다.
    //  DESC 였다면 아래 되짚기가 가장 오래된 1건만 집는다.
    const asc = [...raw].sort((a, b) => a.ts - b.ts);
    let start = asc.length - 1;
    while (
      start > 0 &&
      ((asc[start]!.p.seq as number) ?? 0) > ((asc[start - 1]!.p.seq as number) ?? 0)
    )
      start--;
    out.push(
      assert(
        "★ASC 면 분할이 진행 중 턴 전체(3건)를 라이브로 집는다",
        asc.length - start === 3,
        `liveResume ${asc.length - start}건`,
      ),
    );
    const desc = [...raw].sort((a, b) => b.ts - a.ts);
    let dstart = desc.length - 1;
    while (
      dstart > 0 &&
      ((desc[dstart]!.p.seq as number) ?? 0) > ((desc[dstart - 1]!.p.seq as number) ?? 0)
    )
      dstart--;
    out.push(
      assert(
        "DESC 로 되돌아가면 1건만 집힌다(뒤집힘 재도입 감지의 근거)",
        desc.length - dstart === 1,
        `DESC 시 liveResume ${desc.length - dstart}건 — 그래서 ASC 가 계약`,
      ),
    );

    // ★배선 — 순수 로직만 보면 서버가 상한을 다시 걸어도 초록이다.
    const w = await sourceHas("../../../plugins/http-bridge", [
      // 상한은 기본 off, 역방향 페이지에서만 켠다.
      /upperBounded = false,/,
      /historyActivities\(entries, threadKey, beforeTs !== undefined\)/,
      /historyActivities\(entries, undefined, beforeTs !== undefined\)/,
      // ASC 정렬로 내보낸다.
      /out\.sort\(\(a, b\) => a\.ts - b\.ts \|\| a\.seq - b\.seq\);/,
    ]);
    out.push(
      assert(
        "★서버 배선 — 상한은 beforeTs 에서만 + ASC 로 내보낸다",
        w.ok,
        w.ok ? "4개 배선 확인" : `누락 ${w.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
