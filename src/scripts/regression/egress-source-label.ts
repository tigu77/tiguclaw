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
 *  ① 기본 세션엔 **안 붙는다** — 평소 사용이 글자 하나도 안 바뀐다(라벨이 배경 소음이 되면
 *     진짜 이상할 때 아무도 안 본다).
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
import { egressSourcePrefix } from "../../core/egress-targets.js";
import { DEFAULT_SESSION_ID } from "../../core/threadkey.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "egress-source-label",
  guards:
    "임의 세션의 답이 egress 로 사용자 텔레그램에 맥락 없이 도착해 '누가 보낸 건지' 알 수 없던 것(실사고 2026-08-28) + 그걸 고치면서 평소 대화까지 라벨로 시끄러워지는 것 + 라벨이 대화 내용을 다른 채널로 흘리는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    out.push(
      assert(
        "★★기본 세션엔 라벨이 **안 붙는다** — 평소 사용은 글자 하나 안 바뀐다(매번 붙으면 배경 소음이 되고, 그러면 진짜일 때 아무도 안 본다)",
        egressSourcePrefix(DEFAULT_SESSION_ID, null) === "" &&
          egressSourcePrefix(DEFAULT_SESSION_ID, "공통") === "",
        `기본(무명)="${egressSourcePrefix(DEFAULT_SESSION_ID, null)}" · 기본(유명)="${egressSourcePrefix(DEFAULT_SESSION_ID, "공통")}"`,
      ),
    );
    out.push(
      assert(
        "★이름이 있으면 그 이름으로 — 여러 세션이 한 대화방에 섞여 와도 어느 것인지 안다",
        egressSourcePrefix("dashboard:abc", "핫딜알리미") === "[핫딜알리미] ",
        JSON.stringify(egressSourcePrefix("dashboard:abc", "핫딜알리미")),
      ),
    );
    out.push(
      assert(
        "★★이름이 없으면 **세션 키**를 쓴다 — `unknown` 은 아는 것을 버리는 말이었다(어느 프로브인지 알 길이 없었다)",
        egressSourcePrefix("dashboard:bundle-probe", null) === "[dashboard:bundle-probe] " &&
          egressSourcePrefix("dashboard:bundle-probe", "  ") === "[dashboard:bundle-probe] " &&
          !egressSourcePrefix("dashboard:bundle-probe", null).includes("unknown"),
        JSON.stringify(egressSourcePrefix("dashboard:bundle-probe", null)),
      ),
    );
    out.push(
      assert(
        "★UUID 는 앞 8자만 — 폰 알림 한 줄에 36자를 넣으면 본문이 안 보인다(줄여도 찾을 수 있다)",
        egressSourcePrefix("worker:3f74a2f5-d5a9-4ee8-a77e-8fb24ac765ae", null) ===
          "[worker:3f74a2f5] " &&
          egressSourcePrefix("scheduler:21", null) === "[scheduler:21] ",
        JSON.stringify(egressSourcePrefix("worker:3f74a2f5-d5a9-4ee8-a77e-8fb24ac765ae", null)),
      ),
    );
    out.push(
      assert(
        "★★라벨이 **대화 내용에서 파생되지 않는다** — 파생하면 첫 발화가 다른 채널의 라벨로 새어 나간다(표시명 파생과 일부러 다르게 둔다)",
        !egressSourcePrefix("dashboard:x", null).includes("안녕") &&
          // 키만 쓴다 — 키는 사람·코드가 고른 **식별자**지 대화 내용이 아니다.
          egressSourcePrefix("dashboard:x", null) === "[dashboard:x] ",
        egressSourcePrefix("dashboard:x", null),
      ),
    );
    out.push(
      assert(
        "좌표를 모르면 아무 말도 안 한다(모르는 것을 아는 것처럼 말하지 않는다)",
        egressSourcePrefix(undefined, null) === "" && egressSourcePrefix("", null) === "",
        `undefined="${egressSourcePrefix(undefined, null)}" · 빈문자="${egressSourcePrefix("", null)}"`,
      ),
    );

    // ── ④ 배선 — egress 사본에만 붙는다 ───────────────────────────────────
    const idx = readFileSync(path.join(REPO, "src/index.ts"), "utf8");
    const fan = /const fanOutEgress = async \([\s\S]{0,1600}?\n\};/.exec(idx);
    out.push(
      assert(
        "★라벨을 붙이는 자리가 **egress fan-out 한 곳**이다 — 성공·실패 경로가 둘 다 이 함수를 지나므로 한 곳이면 둘 다 덮인다",
        fan !== null &&
          /egressSourcePrefix\(/.test(fan[0]) &&
          /text: prefix \+ text/.test(fan[0]),
        fan === null ? "fanOutEgress 를 못 찾음" : "fanOutEgress 안에서 붙임",
      ),
    );
    const outsideFan = idx
      .split("const fanOutEgress")
      .filter((_, i) => i !== 1)
      .join("");
    out.push(
      assert(
        "★`src/index.ts` 안에서는 fan-out **밖에서 안 부른다**(인입 응답엔 이미 문맥이 있다)",
        !/egressSourcePrefix\(/.test(outsideFan),
        /egressSourcePrefix\(/.test(outsideFan) ? "★fan-out 밖에서도 붙인다" : "fan-out 전용",
      ),
    );

    // ── ⑤ 호출 자리 **전수** — 파일 하나만 보면 게이트가 조용히 눈이 먼다 ─────
    // ★종전 ④는 index.ts 만 봤다. 라벨을 채널 플러그인에서 부르면 초록인 채로 통과했다.
    //  그래서 «어디서 부르든» 을 소스 전수로 세고, 허용된 자리만 남긴다.
    const callers = listPrefixCallers();
    out.push(
      assert(
        "★★라벨을 부르는 자리는 **egress fan-out 과 텔레그램 인입 응답 둘 뿐**이다 — 새 자리가 생기면 계약(기본 세션 제외·신호가 무엇인가)을 다시 봐야 한다",
        callers.length === 2 &&
          callers.includes("src/index.ts") &&
          callers.includes("plugins/telegram-channel/index.ts"),
        callers.join(", ") || "(호출 자리 없음)",
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
    const prefixDecl = /egressSourcePrefix\(\s*([A-Za-z_$][\w$]*)/.exec(tg);
    out.push(
      assert(
        "★★인입 응답 라벨의 신호는 **답장이 바꾼 세션**이다 — `sessionId` 를 넘기면 채널↔세션 바인딩이 생기는 순간 모든 답에 라벨이 붙는다",
        prefixDecl !== null && /^replied/.test(prefixDecl[1] ?? ""),
        prefixDecl === null ? "라벨 호출을 못 찾음" : `인자=${prefixDecl[1]}`,
      ),
    );

    return out;
  },
};

/**
 * `egressSourcePrefix` 를 **부르는 파일 전수** — 이름을 손으로 적지 않는다
 * ([[feedback_hand_maintained_lists]]). 정의 파일과 이 검사 자신은 뺀다.
 */
const listPrefixCallers = (): string[] => {
  const roots = ["src", "plugins", "packages"];
  const hits: string[] = [];
  const skip = new Set(["node_modules", "dist", ".git"]);
  const walk = (dir: string): void => {
    for (const e of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) {
        if (rel.endsWith("core/egress-targets.ts")) continue;
        if (rel.includes("scripts/regression/")) continue;
        if (/egressSourcePrefix\(/.test(readFileSync(path.join(REPO, rel), "utf8"))) {
          hits.push(rel);
        }
      }
    }
  };
  for (const r of roots) walk(r);
  return hits.sort();
};
