/**
 * 회귀: **압축은 시작을 냈으면 끝도 낸다** (2026-09-15 정태님 신고로 생겼다).
 *
 * ★증상: *"요약턴 진행중인데 끝나기 전에 메시지가 오는 건 뭐야?"* — 요약이 **안 끝난 게
 *  아니라 실패**했고, 폴백(oldest-drop)으로 턴이 그대로 진행돼 답이 먼저 온 것이다.
 *  화면의 «압축 중 ⏳» 은 끝 신호를 못 받아 **유령으로 남았다.**
 *
 * ★기제: 시작 신호는 «접을 게 있다» 로 나가고 끝 신호는 «**성공했다**» 로만 나갔다.
 *  조건이 다르니 실패·건너뜀에선 짝이 안 맞는다. 실측(돌쇠 DB): `llm.compacting` 15건 중
 *  **5건이 짝 없음** — 프루닝이 아니다(더 오래된 성공 기록이 남아 있다). 그중 하나는
 *  로그가 사유까지 말한다: `요약 건너뜀 — 'codex' 쿨다운 3744분 남음`.
 *
 * ★claude 는 더 나빴다: `PreCompact` 만 달려 있어 **성공해도 매번** 유령이었다
 *  (발행 실측 compacting 1 · compacted 0). `PostCompact` 훅이 SDK 에 **있는데** 안 달았다.
 *
 * ★`compaction_stuck` 이 이 자리를 못 메운다 — **임계에서 정확히 1회만** 나므로 1·2회째와
 *  4회째 이후는 여전히 조용하다. 그건 «고착 경보» 고 이건 «끝났다» 다. 둘을 섞으면 둘 다 죽는다.
 */
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { getEventBus } from "../../core/eventbus.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const readRel = (rel: string): Promise<string> =>
  readFile(new URL(rel, import.meta.url), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export const check: RegressionCheck = {
  name: "compaction-always-ends",
  guards:
    "압축이 실패·건너뜀으로 끝나면 끝 신호가 없어 화면의 «압축 중 ⏳» 이 영영 안 걷히던 것 + claude 는 성공해도 끝 신호가 없던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 실패하면 **끝 신호가 나간다** — 진짜 함수를 부른다 ─────────────────────
    const { noteCompactionOutcome } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth-history.js"
    );
    const seen: { type: string; payload: Record<string, unknown> }[] = [];
    const unsub = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
      if (e.type.startsWith("llm.compact")) {
        seen.push({ type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> });
      }
    });
    try {
      const TK = "regr:always-ends";
      noteCompactionOutcome(TK, false, "요약 호출 실패: 400 unsupported_value", 12_345);
      noteCompactionOutcome(TK, false, "쿨다운", 999);
    } finally {
      unsub();
    }
    const ended = seen.filter((e) => e.type === "llm.compact_failed");
    out.push(
      assert(
        "★실패는 **매번** 끝 신호를 낸다 — 임계를 기다리지 않는다(1·2회째가 조용하면 ⏳ 가 그동안 돈다)",
        ended.length === 2,
        `끝 신호 ${ended.length}회 / 실패 2회 · 본 이벤트: ${seen.map((e) => e.type).join("·")}`,
      ),
      assert(
        "그 신호가 **사유**를 싣는다 — 화면이 «왜 잘렸는지» 를 말할 수 있어야 한다",
        ended.length > 0 &&
          String(ended[0]!.payload.reason).includes("400") &&
          ended[0]!.payload.threadKey === "regr:always-ends",
        `첫 신호: ${JSON.stringify(ended[0]?.payload ?? null)}`,
      ),
      assert(
        "★건너뜀(쿨다운)도 끝이다 — «시작했는데 아무 일도 안 일어남» 이 화면에 남지 않는다",
        ended.length === 2 && String(ended[1]!.payload.reason) === "쿨다운",
        `둘째 신호 사유: ${String(ended[1]?.payload.reason)}`,
      ),
      assert(
        "성공은 이 신호를 내지 않는다(성공은 `llm.compacted` 가 말한다 — 둘을 섞으면 «압축했습니다» 가 거짓이 된다)",
        (() => {
          const before = seen.length;
          const u = getEventBus().subscribe((e: { type: string }) => {
            if (e.type === "llm.compact_failed") seen.push({ type: e.type, payload: {} });
          });
          noteCompactionOutcome("regr:always-ends-ok", true, "", 1);
          u();
          return seen.length === before;
        })(),
        `성공 호출 뒤 추가 신호 ${seen.length - ended.length - 0}건`,
      ),
    );

    // ── ② claude 도 **짝이 있다** ────────────────────────────────────────────────
    const claude = stripComments(
      await readRel("../../core/llm-runtime/adapters/claude-agent-sdk.ts"),
    );
    const postAt = claude.indexOf("PostCompact:");
    const postPayload = postAt < 0 ? "" : claude.slice(postAt, postAt + 1600);
    const pre = (claude.match(/"llm\.compacting"/g) ?? []).length;
    const post = (claude.match(/"llm\.compacted"/g) ?? []).length;
    out.push(
      assert(
        "★claude 가 시작과 끝을 **둘 다** 낸다 — 종전엔 시작만 내서 성공해도 ⏳ 가 남았다",
        pre >= 1 && post >= 1 && /PostCompact:\s*\[/.test(claude),
        `compacting ${pre}건 · compacted ${post}건 · PostCompact 훅 ${/PostCompact:\s*\[/.test(claude)}`,
      ),
      assert(
        "★모르는 수를 **지어내지 않는다** — SDK 는 접힌 턴 수·글자 수를 안 주므로 claude 는 그 필드를 안 싣는다",
        postAt >= 0 && !/foldedTurns|foldedChars/.test(postPayload),
        `PostCompact 페이로드 필드: ${(postPayload.match(/^\s*(\w+):/gm) ?? []).map((x) => x.trim()).join("·") || "(없음)"}`,
      ),
    );

    // ── ③ 화면이 **모든 끝**에서 표식을 걷는다 ──────────────────────────────────
    const bad: string[] = [];
    const rawSse = await readRel("../../../packages/dashboard/js/sse.js");
    const sse = stripComments(rawSse);
    const vt = stripComments(
      await readRel("../../../packages/dashboard/js/virtualization.js"),
    );
    const clearsOn = ["llm.compacted", "llm.compact_failed", "llm.compaction_stuck"].filter(
      (t) => {
        const at = sse.indexOf(`ev.type === "${t}"`);
        return at >= 0 && sse.slice(at, at + 420).includes("stopCompactingTick");
      },
    );
    out.push(
      assert(
        "★끝을 뜻하는 이벤트 **셋 전부**가 «압축 중» 표식을 걷는다(하나라도 빠지면 그 경로에서 유령이 남는다)",
        clearsOn.length === 3,
        `표식을 걷는 이벤트: ${clearsOn.join("·") || "없음"}`,
      ),
      assert(
        // ★종전 판은 «키에 ts 가 없다» 만 봤는데 **그것만으론 갱신이 아니다** — `renderLocalChat`
        //  이 키 뒤에 ts 를 붙여 중복을 판정하므로 매번 새 줄이 쌓였다(아스트라가 잡았다).
        //  그래서 «키 모양» 이 아니라 **«이미 있으면 고쳐 쓰는 경로가 있나»** 를 본다.
        "★실패 줄은 스레드당 **한 줄로 고쳐 쓴다** — 임계 넘은 뒤 매 턴 반복되므로 쌓이면 대화가 묻힌다",
        /const compactFailLines = new Map\(\)/.test(sse) &&
          /compactFailLines\.get\(/.test(sse) &&
          /compactFailLines\.set\(/.test(sse) &&
          // 있으면 **새로 그리지 않고 돌아간다**(그 return 이 없으면 고쳐 쓰고 또 쌓는다)
          /prevLine && vtOwns\(prevLine\)[\s\S]{0,400}?return;/.test(sse),
        `보관 ${/compactFailLines\.set\(/.test(sse)} · 재사용 ${/compactFailLines\.get\(/.test(sse)} · 재렌더 단락 ${/prevLine && vtOwns\(prevLine\)[\s\S]{0,400}?return;/.test(sse)}`,
      ),
      assert(
        // ★가상목록은 화면 밖 노드를 **DOM 에서 떼면서 논리 목록엔 유지**한다. 그래서
        //  `isConnected` 로 재사용을 판정하면 스크롤 위치에 따라 **같은 경고가 둘**이 된다
        //  (회사 아스트라 P2 재현). 소유를 아는 자리는 가상목록의 색인뿐이다.
        "★경고 재사용을 **DOM 부착이 아니라 목록 소유**로 판정한다(화면 밖으로 떼어져도 한 줄이다)",
        /vtOwns\(prevLine\)/.test(sse) &&
          !/prevLine\.isConnected/.test(sse) &&
          /const vtOwns = \(node\) =>[^\n]*vtIndex\.has\(node\)/.test(vt),
        `소유판정 ${/vtOwns\(prevLine\)/.test(sse)} · 부착판정 잔존 ${/prevLine\.isConnected/.test(sse)} · 색인 기반 ${/vtIndex\.has\(node\)/.test(vt)}`,
      ),
      assert(
        "★목록 초기화가 소유 색인도 비운다 — 폐기 노드를 되쓰지 않는다",
        /vtItems\.length = 0;\s*\n\s*vtIndex\.clear\(\);/.test(vt),
        `초기화가 색인도 비움 ${/vtItems\.length = 0;\s*\n\s*vtIndex\.clear\(\);/.test(vt)}`,
      ),
      assert(
        "★접힌 수를 모르면 **다른 문구를 고른다** — 0을 그리면 «0턴 0자를 접었다» 는 거짓이 된다",
        (() => {
          bad.length = 0;
          // ★**문구를 고르는 판정 자체를 실행한다.** 술어만 돌리던 판은 «술어는 그대로 두고
          //  호출부만 true 로» 바꾸는 변이를 두 번 통과시켰다(자기 변이에서 적발).
          const a = rawSse.indexOf("const hasFoldCounts = (p) =>");
          const b = rawSse.indexOf("// ── 압축 문구 판정 끝 ──");
          if (a < 0 || b < 0 || b <= a) { bad.push("판정 함수를 못 찾음"); return false; }
          const ctx: Record<string, unknown> = {};
          vm.createContext(ctx);
          vm.runInContext(
            `${rawSse.slice(a, b)}\nthis.__pick = compactDoneMessage;`,
            ctx,
          );
          const pick = ctx.__pick as (
            p: unknown,
            took: string,
          ) => { key: string; params: Record<string, unknown> };
          const codex = pick({ foldedTurns: 194, foldedChars: 119387, summaryChars: 10724 }, "");
          const claude = pick({ summaryChars: 4800 }, ""); // SDK 는 접힌 수를 안 준다
          const zeros = pick({ foldedTurns: 0, foldedChars: 0, summaryChars: 4800 }, "");
          // ★어긋난 축을 **이름으로** 남긴다 — 넷을 `&&` 로 묶으면 빨개졌을 때
          //  «무엇이» 깨졌는지 로그만 봐선 모른다(이 레포가 오늘만 두 번 데인 자리다).
          if (codex.key !== "sys.compact.done" || codex.params.turns !== 194)
            bad.push(`아는 경우 문구=${codex.key}/turns=${String(codex.params.turns)}`);
          if (claude.key !== "sys.compact.doneNoCounts")
            bad.push(`모르는 경우 문구=${claude.key}`);
          // ★모를 땐 그 숫자를 **인자로도 안 넘긴다** — 넘기면 문구만 바꾼 척이 된다.
          if ("turns" in claude.params || "from" in claude.params)
            bad.push(`모르는데 숫자를 넘김=${JSON.stringify(claude.params)}`);
          if (zeros.key !== "sys.compact.doneNoCounts") bad.push(`0턴 문구=${zeros.key}`);
          if (!/compactDoneMessage\(p, took\)/.test(sse))
            bad.push("렌더가 이 판정을 안 지남");
          return bad.length === 0;
        })(),
        bad.length === 0 ? "문구 선택 판정을 실행해 확인(아는/모르는/0턴)" : bad.join(" · "),
      ),
    );

    // ── ④ 문구가 실재한다(양문) ─────────────────────────────────────────────────
    const ko = JSON.parse(await readRel("../../../locales/ko.json")) as Record<string, string>;
    const en = JSON.parse(await readRel("../../../locales/en.json")) as Record<string, string>;
    const need = ["sys.compact.failed", "sys.compact.doneNoCounts"];
    const missing = need.flatMap((k) =>
      [
        ["ko", ko[k]],
        ["en", en[k]],
      ]
        .filter(([, v]) => typeof v !== "string" || v === "")
        .map(([l]) => `${String(l)}:${k}`),
    );
    out.push(
      assert(
        "새 문구가 양문에 다 있다(없으면 화면에 키가 그대로 뜬다)",
        missing.length === 0,
        missing.length === 0 ? `${need.length}개 양문 존재` : `빠짐: ${missing.join("·")}`,
      ),
    );

    return out;
  },
};
