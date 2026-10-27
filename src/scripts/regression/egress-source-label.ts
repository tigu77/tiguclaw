/**
 * 회귀: **egress 사본은 어디서 왔는지 말한다** (2026-08-28).
 *
 * 사고: 번들 플러그인을 검증하려고 임의 세션(`dashboard:bundle-probe`)에 말을 걸었더니,
 * 그 답이 `egress: {channels:["telegram"]}` 를 타고 사용자 텔레그램에 **맥락 없는
 * `echo:안녕` 한 줄**로 도착했다. 세션 귀속은 `recordOutboundMessage` 가 이미 들고
 * 있었지만 그건 **답장 라우팅용**이지 사람에게 보여주는 게 아니었다. 사용자는 폰만 보고는
 * 그게 뭔지 알 수 없어 물어봐야 했다.
 *
 * ★**막지 않고 말해준다.** 첫 제안은 *"등록된 세션만 밖으로"* 라는 게이트였는데 접었다
 *  (사용자 지적: 임의 세션은 개발 중에만 생긴다). 게이트는 새 서버 개념 + 마이그레이션 +
 *  **조용한 실패**(등록을 놓치면 영영 안 감)를 끌고 온다. 라벨은 아무것도 막지 않으므로
 *  조용한 실패가 없다.
 *
 * 지키는 것 넷:
 *  ① ★2026-10-26 개정(정태님 확정 기준 `docs/decisions/2026-10-26-telegram-session-label-policy.md`): 종전 «기본 세션엔
 *     안 붙는다» 를 걷었다 — 기준은 기본 세션인지가 아니라 **그 대화방의 직접 대화인가**다(사본·자동 알림·그 밖의 선택지는
 *     기본 세션도 표시). 직접 대화 생략은 호출부 신호(⑥⑦ «갈렸나», 출처 세션 명시)가 지키고, 이 함수는 무엇을 붙이나만 정한다.
 *  ② 이름 있는 세션은 그 이름으로, 없으면 **세션 키**로(2026-09-02 개정 — `unknown` 은
 *     아는 것을 버리는 말이었다. 실측: `[unknown]` 21건 중 18건이 개발 프로브인데 어느
 *     것인지 알 길이 없었다).
 *  ③ ★**첫 발화에서 파생하지 않는다** — 그건 대화 내용을 다른 채널의 라벨로 흘리는 짓이다.
 *  ④ 라벨을 붙이는 **자리 전수**가 계약을 지킨다 — egress fan-out 과, 답장으로 세션이
 *     갈린 인입 응답 **둘 뿐**이고, 후자는 반드시 `repliedSession`(«답장이 세션을 바꿨다»)
 *     을 신호로 쓴다.
 *     ★2026-09-04 개정: 종전 문구는 *"인입 응답엔 안 붙는다 — 그 채널엔 이미 문맥이
 *      있다"* 였다. 그 근거는 평소엔 맞지만 **답장으로 다른 세션에 물었을 때 깨진다** —
 *      그때 화면의 문맥은 «내가 방금 친 말»이지 «답이 나온 세션»이 아니다(사용자 신고).
 *      게이트가 틀린 게 아니라 **조건이 덜 적혀** 있었다.
 *     ★그리고 종전 검사는 `src/index.ts` **한 파일만** 봤다 — 라벨을 채널에서 부르면
 *      초록인 채로 의미를 잃었다. 그래서 호출 자리를 파일이 아니라 **전수 스캔**으로 센다.
 *
 * 등급: ①②③은 **동작**(순수 함수 실행), ④는 배선 대조.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionLabelPrefix, withSessionLabel } from "../../core/egress-targets.js";
import { DEFAULT_SESSION_ID } from "../../core/threadkey.js";
import {
  assert,
  assertIsolated,
  loadPluginModule,
  type Assertion,
  type RegressionCheck,
} from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "egress-source-label",
  guards:
    "임의 세션의 답이 egress 로 사용자 텔레그램에 맥락 없이 도착해 '누가 보낸 건지' 알 수 없던 것(실사고 2026-08-28) + 그걸 고치면서 평소 대화까지 라벨로 시끄러워지는 것 + 라벨이 대화 내용을 다른 채널로 흘리는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated(); // ⑦ 에서 store 를 쓴다 — 라이브 홈·DB 를 절대 안 만진다.
    const out: Assertion[] = [];

    out.push(
      assert(
        "★★기본 세션도 라벨 **대상**이다 — 붙일지는 호출부가 정하고(2026-10-26 확정 기준: 사본·자동 알림·그 밖의 선택지는 기본 세션 포함), 이 함수는 무엇을 붙이나만 정한다",
        sessionLabelPrefix(DEFAULT_SESSION_ID, "공통") === "[공통] " &&
          sessionLabelPrefix(DEFAULT_SESSION_ID, null) === `[${DEFAULT_SESSION_ID}] `,
        `기본(유명)="${sessionLabelPrefix(DEFAULT_SESSION_ID, "공통")}" · 기본(무명)="${sessionLabelPrefix(DEFAULT_SESSION_ID, null)}"`,
      ),
    );
    out.push(
      assert(
        "★이름이 있으면 그 이름으로 — 여러 세션이 한 대화방에 섞여 와도 어느 것인지 안다",
        sessionLabelPrefix("dashboard:abc", "핫딜알리미") === "[핫딜알리미] ",
        JSON.stringify(sessionLabelPrefix("dashboard:abc", "핫딜알리미")),
      ),
    );
    out.push(
      assert(
        "★★이름이 없으면 **세션 키**를 쓴다 — `unknown` 은 아는 것을 버리는 말이었다(어느 프로브인지 알 길이 없었다)",
        sessionLabelPrefix("dashboard:bundle-probe", null) === "[dashboard:bundle-probe] " &&
          sessionLabelPrefix("dashboard:bundle-probe", "  ") === "[dashboard:bundle-probe] " &&
          !sessionLabelPrefix("dashboard:bundle-probe", null).includes("unknown"),
        JSON.stringify(sessionLabelPrefix("dashboard:bundle-probe", null)),
      ),
    );
    out.push(
      assert(
        "★UUID 는 앞 8자만 — 폰 알림 한 줄에 36자를 넣으면 본문이 안 보인다(줄여도 찾을 수 있다)",
        sessionLabelPrefix("worker:3f74a2f5-d5a9-4ee8-a77e-8fb24ac765ae", null) ===
          "[worker:3f74a2f5] " &&
          sessionLabelPrefix("scheduler:21", null) === "[scheduler:21] ",
        JSON.stringify(sessionLabelPrefix("worker:3f74a2f5-d5a9-4ee8-a77e-8fb24ac765ae", null)),
      ),
    );
    out.push(
      assert(
        "★★라벨이 **대화 내용에서 파생되지 않는다** — 파생하면 첫 발화가 다른 채널의 라벨로 새어 나간다(표시명 파생과 일부러 다르게 둔다)",
        !sessionLabelPrefix("dashboard:x", null).includes("안녕") &&
          sessionLabelPrefix("dashboard:x", null) === "[dashboard:x] ",
        sessionLabelPrefix("dashboard:x", null),
      ),
    );
    out.push(
      assert(
        "좌표를 모르면 아무 말도 안 한다(모르는 것을 아는 것처럼 말하지 않는다)",
        sessionLabelPrefix(undefined, null) === "" && sessionLabelPrefix("", null) === "",
        `undefined="${sessionLabelPrefix(undefined, null)}" · 빈문자="${sessionLabelPrefix("", null)}"`,
      ),
    );
    out.push(
      assert(
        "★한 메시지에 **중복 표시 금지** — 이미 그 라벨로 시작하면 다시 안 붙이고, 라벨이 비면 글 그대로",
        withSessionLabel("[A] ", "[A] 본문") === "[A] 본문" &&
          withSessionLabel("[A] ", "본문") === "[A] 본문" &&
          withSessionLabel("", "본문") === "본문",
        [withSessionLabel("[A] ", "[A] 본문"), withSessionLabel("[A] ", "본문"), withSessionLabel("", "본문")].join(" | "),
      ),
    );

    // ── ④⑤ 호출 자리 **전수** — 이름 규칙은 `outboundSessionLabel` 한 함수, 부르는 파일은 셋뿐 ─────
    // ★종전엔 `egressSourcePrefix` 를 세 곳이 직접 불렀다(이름 조회·실패 삼킴까지 각자). 2026-10-26 이름 규칙을 코어 한 함수로
    //  모았다 — 새 자리가 생기면 «언제 붙이나» 계약(현재 세션 직접 대화는 생략 · 출처 없는 알림엔 안 지어냄)을 다시 봐야 한다.
    const callers = listLabelCallers();
    out.push(
      assert(
        "★★라벨을 짓는 자리는 **텔레그램 채널 · 텔레그램 파일 캡션** 둘뿐이다(타 채널 글 불변)",
        callers.length === 2 &&
          callers.includes("plugins/telegram-channel/index.ts") &&
          callers.includes("plugins/telegram-channel/send-document.ts"),
        callers.join(", ") || "(호출 자리 없음)",
      ),
    );
    const idx = readFileSync(path.join(REPO, "src/index.ts"), "utf8");
    const fan = /const fanOutEgress = async \([\s\S]{0,2400}?\n\};/.exec(idx);
    out.push(
      assert(
        "★대시보드 사본은 새 라벨 세션 메타를 넘기되 타 채널의 기존 사본 접두어는 보존한다",
        fan !== null && /labelSession: originThreadKey/.test(fan[0]) && /text: prefix \+ text/.test(fan[0]),
        fan === null ? "fanOutEgress 를 못 찾음" : "labelSession 으로 넘김",
      ),
    );

    // ── ⑥ 인입 응답의 신호는 `repliedSession` 이다 (2026-09-04) ────────────────
    // ★`sessionId` 를 넘기면 «채널↔세션 바인딩이 생기는 순간 모든 답에 라벨» 이 된다.
    //  바인딩은 `/sessions use` 로 언제든 생기므로 이건 가정이 아니라 대기 중인 결함이다.
    //  이 변이(repliedSession → sessionId)가 반드시 빨간불이어야 한다.
    const tg = readFileSync(
      path.join(REPO, "plugins/telegram-channel/index.ts"),
      "utf8",
    );
    const prefixDecl = /outboundSessionLabel\(\s*([A-Za-z_$][\w$]*)/.exec(tg);
    out.push(
      assert(
        "★★인입 응답 라벨의 신호는 **답장이 바꾼 세션**이다 — `sessionId` 를 넘기면 채널↔세션 바인딩이 생기는 순간 모든 답에 라벨이 붙는다",
        prefixDecl !== null && /^replied/.test(prefixDecl[1] ?? ""),
        prefixDecl === null ? "라벨 호출을 못 찾음" : `인자=${prefixDecl[1]}`,
      ),
    );

    // ── ⑦ ★그 «신호» 를 **누가 만드나** — 이름이 아니라 동작으로 (2026-09-05) ─────
    //  ⑥은 `replyAndRecord` **안**에서 라벨에 넘기는 인자의 *이름*만 봤다. 그런데 그건
    //  파라미터 이름이라 늘 `replied…` 였고, **호출부가 원값을 넘기는 것**은 못 봤다.
    //  실제로 그래서 새어 나갔다: 로그는 «갈렸을 때만» 으로 좁혀놓고 라벨은 안 좁혀
    //  ①비기본 세션에 묶인 대화는 답글마다 상시 라벨 ②정작 갈린 순간엔 침묵 — 양방향.
    //  ★이름을 보는 검사는 이름만 지킨다. 판정을 순수 함수로 꺼냈으니 **돌려서** 본다.
    const { routedReplySession } = await import("../../core/threadkey.js");
    const table: Array<[string, string | null, string, string | null]> = [
      ["묶인 세션과 같다(=안 갈렸다)", "dashboard:proj", "dashboard:proj", null],
      ["갈렸다 — 그 세션을 낸다", "dashboard:proj", "dashboard:default", "dashboard:proj"],
      ["기본으로 갈린 것도 «갈림»이다", "dashboard:default", "dashboard:proj", "dashboard:default"],
      ["매핑 없음", null, "dashboard:proj", null],
    ];
    const bad = table.filter(([, r, b, want]) => routedReplySession(r, b) !== want);
    out.push(
      assert(
        "★★라벨 신호가 «매핑이 있다» 가 아니라 «세션이 갈렸다» 로 만들어진다(진리표)",
        bad.length === 0,
        bad.length === 0
          ? table.map(([n, r, b]) => `${n}→${routedReplySession(r, b) ?? "null"}`).join(" · ")
          : `★틀린 것: ${bad.map(([n, r, b, w]) => `${n} 기대=${w ?? "null"} 실제=${routedReplySession(r, b) ?? "null"}`).join(" · ")}`,
      ),
    );
    // 그리고 제품 경로가 **그 판정을 지난다**(인라인으로 되돌아가면 위 진리표가 무의미해진다).
    //  ★2026-09-22: 판정이 `reply-routing.ts` 로 나오면서 **돌려서** 잴 수 있게 됐다.
    //   종전엔 `routedReplySession\(` 를 텔레그램 index 에서 grep 했는데, 그건 «그 이름이
    //   파일에 있나» 이지 «그 값이 만들어지나» 가 아니다. 이제 실제로 부른다.
    const { resolveReplyRouting } = await loadPluginModule<{
      resolveReplyRouting: (
        chatId: string,
        repliedMsgId: number | undefined,
        boundSession: string,
        kind: "text" | "attachment",
      ) => { repliedSession: string | null; sessionId: string; routedSession: string | null };
    }>("../../../plugins/telegram-channel/reply-routing.ts");
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { recordOutboundMessage } = await import("../../store/outbound-messages.js");
    recordOutboundMessage("telegram", "chat-label", 861_001, "dashboard:proj", Date.now());
    // 갈렸다 → 신호가 있다 / 안 갈렸다 → 신호가 없다. 둘 **다** 본다(한쪽만 재면 절반이다).
    const split = resolveReplyRouting("chat-label", 861_001, "dashboard:default", "text");
    const same = resolveReplyRouting("chat-label", 861_001, "dashboard:proj", "text");
    const signalCorrect = split.routedSession === "dashboard:proj" && same.routedSession === null;
    out.push(
      assert(
        "★제품 경로가 그 판정을 **실제로 만든다** — 갈렸을 때만 신호가 나온다(양방향)",
        signalCorrect,
        `갈림=${String(split.routedSession)} (기대 dashboard:proj) · 안갈림=${String(same.routedSession)} (기대 null)`,
      ),
    );
    // 호출부가 그 **좁혀진 값**을 라벨로 넘긴다 — 여기만 소스 확인이다(grammy 컨텍스트 필요).
    const usesFn = /repliedSession:\s*routedSession/.test(tg);
    out.push(
      assert(
        "호출부가 «갈림» 신호를 라벨에 넘긴다 — 원값을 넘기면 안 갈린 답글도 라벨을 받는다",
        usesFn,
        usesFn ? "repliedSession: routedSession" : "★좁혀진 값을 안 넘긴다",
      ),
    );

    return out;
  },
};

/**
 * `outboundSessionLabel` 를 **부르는(또는 정의하는) 파일 전수** — 이름을 손으로 적지 않는다
 * ([[feedback_hand_maintained_lists]]). 검사 파일은 뺀다.
 */
const listLabelCallers = (): string[] => {
  const roots = ["src", "plugins", "packages"];
  const hits: string[] = [];
  const skip = new Set(["node_modules", "dist", ".git"]);
  const walk = (dir: string): void => {
    for (const e of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) {
        if (rel.includes("scripts/regression/")) continue;
        if (/outboundSessionLabel\(/.test(readFileSync(path.join(REPO, rel), "utf8"))) {
          hits.push(rel);
        }
      }
    }
  };
  for (const r of roots) walk(r);
  return hits.sort();
};
