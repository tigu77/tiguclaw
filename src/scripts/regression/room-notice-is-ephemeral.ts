/**
 * 회귀: **대화방 바인딩 안내는 휘발성이다** — 보낸 채널에 한 번 보이고 안 남는다 (2026-08-23 사용자 지적).
 *
 * 사용자: *"'이 대화방을 TE 세션에 묶었습니다 …' 이 메시지는 텔레그램에서만 보여도 될 것
 *  같은데."* — 대화방↔세션 바인딩은 **그 방의 설정**이다. 세션 기록에 남으면 대시보드엔
 *  자기가 하지도 않은 조작이 대화처럼 끼어들고, 이력·검색에도 남는다.
 *
 * ★이 검사는 **동작을 돌린다**(2026-08-23 2라운드 D7 승격). 종전엔 `index.ts` 소스에
 *  특정 문장이 있는지 grep 했는데, 그 방식은 첫날에 이미 대가를 치렀다 — 발행을 통째로
 *  끄는 잘못된 구현을 문자열로 박제해 초록을 줬다. 여기선 실제 `event-persist` 를 붙이고
 *  이벤트를 흘려 `chat_log` 를 읽는다.
 *
 * ★지키는 불변식 셋:
 *   ① 휘발성 표식이 붙은 in/out 은 `chat_log` 에 **안 남는다**
 *   ② 표식이 없으면 **남는다**(휘발이 새어 일반 대화를 먹지 않는다)
 *   ③ 판정(`isEphemeralCommandText`)이 **핸들러와 같은 파서**다 — 공백 2개·탭·대문자로
 *      갈리면 명령만 남고 답이 사라지거나(또는 그 반대) 반쪽만 휘발한다
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEphemeralCommandText } from "../../core/entry/command-registry.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ③ 판정이 핸들러와 같은 파서인가 (순수 함수 — 격리 불필요) ────────────────
  {
    const cases: Array<[string, boolean]> = [
      ["/sessions use abc", true],
      ["/sessions  use abc", true], // 공백 2개 — 핸들러는 `split(/\s+/)` 라 use 로 받는다
      ["/sessions\tuse abc", true], // 탭
      ["/sessions USE abc", true], // 핸들러가 toLowerCase 한다
      ["/sessions use abc", true], // NBSP
      ["/sessions new 이름", true],
      // ★조회는 휘발, 변경은 기록 (2026-08-23 4라운드). 선택지로 답하는 호출은 어느
      //  채널에서도 응답이 기록되지 않아(`presentOptions` 는 버스를 안 탄다) 명령만
      //  남으면 **답 없는 명령 버블**이 된다 — 짝을 맞춰 둘 다 안 남긴다.
      ["/sessions", true], // 목록 = 조회 UI
      ["/sessions archive", true], // 인자 없음 = 선택지 UI
      ["/sessions unarchive", true],
      ["/sessions archive dashboard:abc", false], // ★상태 변경 = 기록
      ["/sessions unarchive dashboard:abc", false],
      // ★대문자 축 — 핸들러는 `cmd === "/sessions"` 로 **구분** 비교한다. 판정만 관대하면
      //  명령이 휘발하고 LLM 이 답해 질문 없는 답 버블이 된다(3R 3점). 여기가 그 그물이다 —
      //  종전엔 20초짜리 데몬 게이트 하나가 지켰는데, 그건 환경 문제로 자주 빨간불이 된다.
      // ★하위명령 소문자화의 **판별력**을 지키는 케이스 (2026-08-24 6라운드). 판정을
      //  뒤집으면서 옛 `/SESSIONS use` 케이스가 값을 구분 못 하게 됐다 — `.toLowerCase()`
      //  를 지워도 `true` 라 같은 답이다. 대문자 하위명령 + id 조합이라야 갈린다:
      //  소문자화가 없으면 `sub="ARCHIVE"` 라 "상태 변경" 으로 안 보여 **휘발**해 버리고,
      //  라이브에선 보관 대신 세션 선택 목록이 뜬다(능력 조용히 상실).
      ["/sessions ARCHIVE dashboard:abc", false],
      ["/sessions UnArchive dashboard:abc", false],
      ["/SESSIONS use abc", false],
      ["/SESSIONS", false],
      ["/Sessions new 이름", false],
      // ★미지 하위명령은 **휘발**이다 (2026-08-24 5라운드). 핸들러의 기본 분기가
      //  곧 선택지 분기라(`presentOptions` 는 버스를 안 탄다) 기록으로 두면
      //  **답 없는 명령 버블**이 된다 — 실측 `user:/sessions foo` 만 남았다.
      //  기록되는 것은 **id 를 동반한 상태 변경**뿐이다.
      ["/sessions usefully abc", true],
      ["/sessions foo", true],
      ["/sessions rename x y", true],
      ["/status", false],
    ];
    const bad = cases.filter(([i, e]) => isEphemeralCommandText(i) !== e);
    out.push(
      assert(
        "★휘발성 판정이 핸들러와 같은 파서다(공백·탭·대소문자·NBSP)",
        bad.length === 0,
        bad.length === 0
          ? `${cases.length}종 전부 기대대로`
          : `★불일치 ${bad.length}건: ${bad.map(([i]) => JSON.stringify(i)).join(", ")} — 반쪽만 휘발한다`,
      ),
    );
  }

  // ── ①② 적재 계층을 **실제로 돌린다** ──────────────────────────────────────────
  // ── ★세션 이름은 **키로** 읽는다 — 목록 창 밖으로 밀리면 안 된다 (6라운드) ──────
  //  5라운드에 `includeArchived: true` 로 고쳤는데 그게 `listThreads` 의 기본 상한 100 과
  //  만나 같은 결함을 되살렸다(실측: 활성 120·보관 5 → 이름 5/5 유실). 목록 API 로 단건을
  //  묻는 한 상한을 얼마로 키우든 그 상한에서 같은 일이 난다 — 그래서 **동작으로** 본다.
  {
    const home2 = await mkdtemp(join(tmpdir(), "tiguclaw-name-"));
    const prev2 = process.env.TIGUCLAW_HOME;
    process.env.TIGUCLAW_HOME = home2;
    try {
      const { initStore, setThreadName, setThreadArchived, getThreadName } = await import(
        "../../store/sessions.js"
      );
      initStore();
      setThreadName("dashboard:target", "보관된세션A");
      setThreadArchived("dashboard:target", Date.now());
      for (let i = 0; i < 120; i += 1) setThreadName(`dashboard:filler-${i}`, `채움${i}`);
      const got = getThreadName("dashboard:target");
      out.push(
        assert(
          "★활성 세션이 상한을 넘겨도 보관 세션의 이름을 읽는다(목록 창에 안 갇힌다)",
          got === "보관된세션A",
          got === "보관된세션A"
            ? "키 조회 확인(활성 120 + 보관 1)"
            : `★이름을 못 읽었다(${String(got)}) — 복원 목록이 첫 발화 파생 라벨로 떨어진다`,
        ),
      );
    } finally {
      if (prev2 === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = prev2;
      await rm(home2, { recursive: true, force: true });
    }
  }

  const home = await mkdtemp(join(tmpdir(), "tiguclaw-eph-"));
  const prevHome = process.env.TIGUCLAW_HOME;
  process.env.TIGUCLAW_HOME = home;
  try {
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { createEventBus } = await import("../../core/eventbus.js");
    const { startEventPersistence } = await import("../../core/event-persist.js");
    const { getRecentChatLog } = await import("../../store/chat-log.js");

    const bus = createEventBus();
    startEventPersistence(bus);
    const threadKey = "dashboard:eph-test";
    const base = { channel: "http-bridge", threadKey };
    const now = Date.now();
    bus.publish({
      type: "channel.message.in",
      ts: now,
      payload: { ...base, text: "/sessions use abc", ephemeral: true },
    });
    bus.publish({
      type: "channel.message.out",
      ts: now + 1,
      payload: { ...base, text: "이 대화방을 묶었습니다.", ephemeral: true },
    });
    bus.publish({
      type: "channel.message.in",
      ts: now + 2,
      payload: { ...base, text: "평범한 대화입니다" },
    });
    await new Promise((r) => setTimeout(r, 150)); // 적재는 비동기 구독자.

    const rows = getRecentChatLog({ threadKey, limit: 50 });
    const texts = rows.map((r: { text: string }) => r.text);
    const leaked = texts.filter(
      (t) => t.includes("/sessions use") || t.includes("묶었습니다"),
    );
    out.push(
      assert(
        "★휘발성 표식이 붙으면 chat_log 에 안 남는다(명령·응답 둘 다)",
        leaked.length === 0,
        leaked.length === 0
          ? "적재 0건 확인"
          : `★${leaked.length}건이 남았다: ${JSON.stringify(leaked)}`,
      ),
    );
    out.push(
      assert(
        "표식 없는 대화는 그대로 남는다(휘발이 새지 않는다)",
        texts.includes("평범한 대화입니다"),
        texts.includes("평범한 대화입니다")
          ? "일반 대화 적재 확인"
          : `★일반 대화까지 사라졌다 — 적재된 것: ${JSON.stringify(texts)}`,
      ),
    );
  } finally {
    if (prevHome === undefined) delete process.env.TIGUCLAW_HOME;
    else process.env.TIGUCLAW_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
  return out;
};

export const check: RegressionCheck = {
  name: "room-notice-is-ephemeral",
  guards:
    "대화방 바인딩 안내가 세션 기록에 남아 대시보드·검색에 자기가 하지도 않은 조작이 대화로 끼어들던 것 + 그 뒤 발행을 통째로 꺼서 명령 버블이 '대기 중'으로 굳고 반쪽만 휘발하던 것",
  run,
};
export default check;
