/**
 * 회귀: 답장하면 **그 답이 나온 세션으로** 간다.
 *
 * 배경 (2026-08-10): egress("이 답도 함께 보낼 채널")로 한 텔레그램 대화에 **여러 세션의
 *  답이 섞여** 오게 됐다. 그러면 "어느 답에 대한 얘기인지" 를 가를 수단이 필요한데,
 *  답장이 그 자연스러운 UI 다. 그런데 `sendOutgoing` 이 `void` 라 텔레그램이 준
 *  `message_id` 를 **그냥 버렸고**, "이 메시지가 어느 세션 것" 을 알 방법이 아예 없었다.
 *
 * 지키는 것 — ①기록·조회가 왕복한다 ②없으면 null(=현재 세션 폴백, 조용히) ③상한이
 *  실제로 걸린다(무한 증가 금지) ④좌표가 다르면 안 섞인다(다른 대화방의 같은 id).
 *
 * ★상한은 직감이 아니라 실측이다: 이 인스턴스의 비서 발신은 하루 65건
 *  (`transcripts(role=assistant)`, 80일 창, 전 채널). 2,000행이면 한 달치를 훨씬 넘는다.
 */
import {
  recordOutboundMessage,
  findSessionForOutboundMessage,
  countOutboundMessageMappings,
  OUTBOUND_MESSAGE_MAP_MAX_ROWS,
} from "../../store/outbound-messages.js";
import { initStore } from "../../store/sessions.js";
import {
  assertIsolated,
  loadPluginModule,
  type Assertion,
  type RegressionCheck,
} from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated(); // 라이브 홈·DB 를 절대 안 만진다(러너가 임시 홈을 잡아준다).
  const out: Assertion[] = [];
  initStore();
  {

    // ── ① 기록 → 조회 왕복 ────────────────────────────────────────────────
    recordOutboundMessage("telegram", "chat-1", 1001, "dashboard:sessionA", 1);
    out.push({
      name: "기록한 메시지의 발원 세션을 되찾는다",
      ok: findSessionForOutboundMessage("telegram", "chat-1", 1001) === "dashboard:sessionA",
      got: `조회=${String(findSessionForOutboundMessage("telegram", "chat-1", 1001))} (기대 dashboard:sessionA)`,
    });

    // ── ② 없으면 null — 조용히 현재 세션으로 폴백하는 근거 ────────────────
    out.push({
      name: "모르는 메시지는 null(= 현재 세션 폴백, 에러 아님)",
      ok: findSessionForOutboundMessage("telegram", "chat-1", 999999) === null,
      got: `조회=${String(findSessionForOutboundMessage("telegram", "chat-1", 999999))} (기대 null)`,
    });

    // ── ③ 좌표가 다르면 안 섞인다 ─────────────────────────────────────────
    //  같은 message_id 라도 대화방이 다르면 남의 세션이다(텔레그램 id 는 chat 별 채번).
    recordOutboundMessage("telegram", "chat-2", 1001, "dashboard:sessionB", 2);
    out.push({
      name: "★다른 대화방의 같은 message_id 는 섞이지 않는다",
      ok:
        findSessionForOutboundMessage("telegram", "chat-1", 1001) === "dashboard:sessionA" &&
        findSessionForOutboundMessage("telegram", "chat-2", 1001) === "dashboard:sessionB",
      got: `chat-1=${String(findSessionForOutboundMessage("telegram", "chat-1", 1001))} chat-2=${String(findSessionForOutboundMessage("telegram", "chat-2", 1001))}`,
    });

    // ── ④ 같은 좌표·같은 id 재기록은 멱등(덮어쓰기) ───────────────────────
    recordOutboundMessage("telegram", "chat-1", 1001, "dashboard:sessionC", 3);
    out.push({
      name: "같은 메시지 재기록은 덮어쓴다(행 증식 없음)",
      ok: findSessionForOutboundMessage("telegram", "chat-1", 1001) === "dashboard:sessionC",
      got: `조회=${String(findSessionForOutboundMessage("telegram", "chat-1", 1001))} (기대 sessionC)`,
    });

    // ── ⑤ 상한 — 무한히 쌓이지 않는다 ─────────────────────────────────────
    //  상한 + 50 을 넣고 초과분이 실제로 잘리는지. 오래된 것부터 사라져야 한다.
    const over = OUTBOUND_MESSAGE_MAP_MAX_ROWS + 50;
    for (let i = 0; i < over; i++) {
      recordOutboundMessage("telegram", "chat-bulk", 5_000_000 + i, "s", 1000 + i);
    }
    const n = countOutboundMessageMappings();
    out.push({
      name: "★상한이 실제로 걸린다(무한 증가 금지)",
      ok: n <= OUTBOUND_MESSAGE_MAP_MAX_ROWS,
      got: `${over}건 기록 후 보관=${n}행 (상한 ${OUTBOUND_MESSAGE_MAP_MAX_ROWS})`,
    });
    out.push({
      name: "가장 최근 것은 상한 뒤에도 살아 있다",
      ok:
        findSessionForOutboundMessage("telegram", "chat-bulk", 5_000_000 + over - 1) === "s",
      got: `최신 조회=${String(findSessionForOutboundMessage("telegram", "chat-bulk", 5_000_000 + over - 1))} (기대 s)`,
    });
  }
  // ── ★egress 로 복사된 답에도 귀속이 실린다 (2026-08-11 실사고) ──────────
  //  사용자 신고: 대시보드 세션에서 나온 답이 텔레그램으로도 갔는데, 거기에 답장하니
  //  원래 세션이 아니라 **공통 세션**으로 들어갔다. 뿌리는 한 필드가 두 질문을 겸한 것 —
  //  `observeThreadKey` 는 *"어디에 표시할까"* 인데 답장 매핑은 *"누가 한 말인가"* 다.
  //  fan-out 은 표시 중복을 피하려 그 필드를 비웠고, 그 순간 **매핑까지 사라졌다.**
  //  그래서 `originThreadKey` 를 갈라놓았다. 여기선 그 분리를 **실행해서** 확인한다.
  {
    const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
    const { deliverOutbound } = await import("../../core/outbound.js");
    registerChannelOutbound("regr-egress", {
      deliver: async () => ({ messageIds: [777_001] }),
      defaultOutboundTarget: async () => "chat-egress",
    });
    // 표시용 키는 **주지 않고** 귀속만 준다 = fan-out 이 하는 그대로.
    await deliverOutbound({
      channel: "regr-egress",
      target: "chat-egress",
      text: "egress 복사본",
      originThreadKey: "dashboard:origin-session",
    });
    out.push({
      name: "★표시 키 없이 귀속만 실어도 답장 매핑이 남는다(egress 경로)",
      ok:
        findSessionForOutboundMessage("regr-egress", "chat-egress", 777_001) ===
        "dashboard:origin-session",
      got: `조회=${String(findSessionForOutboundMessage("regr-egress", "chat-egress", 777_001))} (기대 dashboard:origin-session)`,
    });

    // 폴백 — 기존 호출부(observeThreadKey 만 주는 곳)는 그대로 동작해야 한다.
    await deliverOutbound({
      channel: "regr-egress",
      target: "chat-egress",
      text: "기존 경로",
      observeThreadKey: "dashboard:legacy",
    });
    out.push({
      name: "기존 호출부(표시 키만)는 그대로 귀속된다(회귀 0)",
      ok:
        findSessionForOutboundMessage("regr-egress", "chat-egress", 777_001) ===
        "dashboard:legacy",
      got: `조회=${String(findSessionForOutboundMessage("regr-egress", "chat-egress", 777_001))} (기대 dashboard:legacy)`,
    });
  }

  // ── 배선 — fan-out 이 실제로 그 값을 넘기는가 ────────────────────────────
  {
    const { sourceHas } = await import("./_wiring.js");
    const has = await sourceHas("../../index.ts", [
      /fanOutEgress = async \(\s*\n?\s*targets[\s\S]{0,220}?originThreadKey\?: string,/,
      /fanOutEgress\(egressTargets, replyText, bus, msg\.threadKey\)/,
    ]);
    out.push({
      name: "★egress fan-out 이 발원 세션을 싣는다(안 실으면 공통 세션으로 떨어진다)",
      ok: has.ok,
      got: has.ok ? "fan-out 배선 확인" : `누락: ${has.missing.join(" / ")}`,
    });
  }

  // ── ★★인입 응답도 기록된다 (2026-09-04) — **여기가 통째로 비어 있었다** ───
  //  위 ①~⑤ 는 전부 `recordOutboundMessage` 를 **검사가 직접 불러** 왕복을 쟀다. 그래서
  //  «제품 경로가 그걸 부르는가» 는 아무도 안 봤고, 실제로 **인입 응답 세 경로가 다 안
  //  불렀다.** 실측: `답장 → 발원 세션으로 라우팅` 로그가 06-11~09-04 전 기간 0건 —
  //  08-10 에 만든 답장 라우팅이 한 번도 걸린 적이 없었다(egress 사본에만 매핑이 쌓였다).
  //  ★그래서 여기선 **제품 함수를 실행**한다(스텁 send). 기록 루프를 지우면 빨간불이다.
  {
    //  ★리터럴 지정자로 부르면 `npm run build` 가 TS6059 로 죽는다 — `loadPluginModule`
    //   (URL 계산)이 그래서 있다([[src-stays-inside-src]] 가 이걸 잡아줬다).
    const { replyAndRecord } = await loadPluginModule<{
      replyAndRecord: (
        send: (chunk: string, extra: unknown) => Promise<unknown>,
        sessionId: string,
        chatId: string,
        out: string,
        opts?: { repliedSession?: string | null; replyToMessageId?: number },
      ) => Promise<void>;
    }>("../../../plugins/telegram-channel/index.ts");
    // 텔레그램이 청크마다 message_id 를 준다 — 사용자는 **어느 청크에든** 답장할 수 있다.
    let sent = 0;
    const chunks: string[] = [];
    const stubSend = async (chunk: string): Promise<unknown> => {
      chunks.push(chunk);
      return { message_id: 990_100 + sent++ };
    };
    await replyAndRecord(stubSend, "dashboard:inbound-session", "chat-inbound", "답");
    out.push({
      name: "★★인입 응답이 답장 매핑에 기록된다 — 이게 없으면 텔레그램에서 받은 답에 답글을 달아도 영영 공통 세션으로 떨어진다",
      ok:
        findSessionForOutboundMessage("telegram", "chat-inbound", 990_100) ===
        "dashboard:inbound-session",
      got: `조회=${String(findSessionForOutboundMessage("telegram", "chat-inbound", 990_100))} (기대 dashboard:inbound-session)`,
    });

    // ── ★라벨이 **실제로 붙어 나간다** (2026-09-04) ─────────────────────────
    //  ★이 검사가 없을 때 «라벨을 계산해놓고 안 붙이는» 변이가 2,810건을 전부 초록으로
    //   통과했다. 그래서 합성을 `replyAndRecord` 안으로 옮기고 **나간 문자열**을 잰다.
    const { setThreadName } = await import("../../store/sessions.js");
    setThreadName("dashboard:replied-session", "핫딜알리미");
    chunks.length = 0;
    await replyAndRecord(stubSend, "dashboard:replied-session", "chat-inbound", "답이다", {
      repliedSession: "dashboard:replied-session",
    });
    out.push({
      name: "★★답장으로 세션이 갈리면 **나가는 본문에 그 세션 이름이 붙는다** — 정태님 신고(답글로 보냈을 때 세션 이름이 안 붙더라)의 본체",
      ok: chunks.length > 0 && chunks[0]!.startsWith("[핫딜알리미] "),
      got: `첫 청크="${(chunks[0] ?? "").slice(0, 40)}"`,
    });

    // 반대 방향 — 평소 대화(답장 아님)는 **글자 하나 안 바뀐다**.
    chunks.length = 0;
    await replyAndRecord(stubSend, "dashboard:replied-session", "chat-inbound", "평소 답");
    out.push({
      name: "★답장이 아니면 라벨이 안 붙는다(평소 대화 무변화) — 매번 붙으면 배경 소음이 되고 진짜일 때 아무도 안 본다",
      ok: chunks[0] === "평소 답",
      got: `첫 청크="${String(chunks[0])}" (기대 "평소 답")`,
    });
  }

  // ── 배선 — 인입 응답 **세 경로 전부**가 그 이음매를 지난다 ────────────────
  //  ★한 곳만 고치면 "어떤 답엔 답장이 걸리고 어떤 답엔 안 걸린다" 는 지금 결함의 모양이
  //   그대로 남는다. 그래서 «reply 클로저가 sendFormatted 를 직접 부르지 않는다» 를 센다.
  {
    const { readFileSync } = await import("node:fs");
    const path = (await import("node:path")).default;
    const { fileURLToPath } = await import("node:url");
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const tg = readFileSync(
      path.join(repo, "plugins/telegram-channel/index.ts"),
      "utf8",
    );
    // ★블록 경계로 세지 않는다 — 들여쓰기가 자리마다 달라 «못 찾음» 이 «없음» 으로 읽힌다
    //  (첫 시도가 3개 중 2개만 봤다). 대신 **인입 송신 람다 자체**를 세고, 그 람다를 받는
    //  함수 이름을 앞에서 읽는다. 자리가 몇 줄짜리든·어디로 옮기든 같은 값을 준다.
    const sendLambda = /([A-Za-z_$][\w$]*)\(\s*\n?\s*\(chunk, extra\) => ctx\.reply\(chunk, extra\)/g;
    const callees = [...tg.matchAll(sendLambda)].map((m) => m[1]);
    const notRecorded = callees.filter((c) => c !== "replyAndRecord");
    out.push({
      name: "★★인입 응답 경로 **전부**가 `replyAndRecord` 를 지난다 — 한 자리라도 `sendFormatted` 를 직접 부르면 그 경로의 답만 기록이 빠져 «어떤 답엔 답장이 걸리고 어떤 답엔 안 걸린다» 가 된다",
      ok: callees.length === 3 && notRecorded.length === 0,
      got: `인입 송신 자리 ${callees.length}개(기대 3) · 받는 함수=[${callees.join(", ")}]`,
    });

    // ★**입구**도 본다 (2026-09-04). 위 검사와 라벨 동작 검사가 둘 다 초록인데, 핸들러가
    //  신호를 **안 넘기는** 변이(`repliedSession` → `null`)가 2,812건을 통과했다 —
    //  이음매를 하나로 모으면 «그 이음매에 값이 들어오는가» 가 새 사각이 된다.
    //  (3R 에서 카드 헤더 클릭이 같은 이유로 새 나갔다: 이음매는 모았는데 입구를 안 봤다.)
    //  ★2026-09-05 개정: 종전엔 `repliedSession,` 이라는 **문장 모양**을 봤다. 그래서
    //   ①호출부가 값을 좁히지 않고 원값을 넘기는 진짜 결함은 못 보고(적대 검토 P2)
    //   ②판정을 순수 함수로 꺼내는 정당한 리팩터에는 빨간불을 냈다. 검사가 이름을 보면
    //   이름만 지킨다. 지금은 «무엇이든 **좁혀진 값**이 넘어가는가» 를 본다.
    //  ★주석에 걸리지 않게 **코드만** 본다 — 첫 판은 `{` 다음에 바로 `repliedSession:` 이
    //   오는 모양을 봐서, 그 사이에 설명 주석을 한 줄 넣자 «미전달» 로 오판했다.
    //   («검사 대상은 마크업이지 그걸 설명하는 글이 아니다» — 같은 부류를 또 저질렀다.)
    const tgCode = tg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const signal = /replyAndRecord\([\s\S]{0,360}?repliedSession:\s*([A-Za-z_$][\w$]*)/
      .exec(tgCode);
    const passedName = signal?.[1] ?? "";
    // 원값(`repliedSession`)을 그대로 넘기면 «매핑이 있다» 가 이유가 된다 — 그게 P2 였다.
    const narrowed = passedName !== "" && passedName !== "repliedSession";
    out.push({
      name: "★★답장 신호가 송신 이음매까지 **넘어가되, 좁혀진 값**으로 간다 — 안 넘기면 라벨이 영영 안 뜨고, 원값을 넘기면 갈리지도 않았는데 매번 뜬다",
      ok: narrowed,
      got:
        passedName === ""
          ? "★신호 미전달(라벨이 죽는다)"
          : passedName === "repliedSession"
            ? "★원값 전달 — 바인딩만 있으면 답글마다 라벨이 붙는다"
            : `좁혀진 값 전달: repliedSession: ${passedName}`,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "reply-routes-to-origin-session",
  guards:
    "답장이 발원 세션으로 못 가던 것(발신 message_id 를 버려 매핑 자체가 없었다 / egress 복사본은 표시 키를 안 실어 귀속까지 같이 사라졌다) + 매핑 테이블이 무한히 쌓이는 것 + 다른 대화방의 같은 message_id 가 섞이는 것",
  run,
};
