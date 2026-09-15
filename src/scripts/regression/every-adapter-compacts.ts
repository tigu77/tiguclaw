/**
 * 회귀: **오래된 대화는 어느 어댑터에서도 «요약» 으로 남는다 — 그냥 버려지지 않는다**
 * (2026-09-15 정태님 지적: *"이거 완전 티구클로 근본에서 벗어난 행동인데"*).
 *
 * ★사고: openai 어댑터가 `loadThreadHistory` 기본값(40턴/200,000자)으로 오래된 턴을
 *  **요약 없이 버렸다.** 이벤트도 화면 표시도 0이라 사용자는 잃는 줄도 몰랐다. codex 는
 *  우리가 요약하고 claude 는 SDK 가 요약하는데 **openai 만 정상 동작이 곧 망각**이었다.
 *
 * ★3개월 산 이유: 2026-06-16 결정이 *"claude=SDK 자체 압축 / openai=SDK"* 라고 **나란히**
 *  적었다. claude 는 참이고 openai 는 확인 안 한 채 옆에 붙인 것이다(헌법 §1 — 한쪽만 보고
 *  반대쪽을 미루어 말하지 마라). 그 한 줄이 «안 만들어도 되는 이유» 가 됐고, 문서라서
 *  아무도 다시 안 봤다. **그래서 이 검사는 문서가 아니라 코드를 잰다.**
 *
 * ★등급: 배선 게이트. 세 어댑터를 **나란히** 재는 자리가 없었던 것이 진짜 구멍이라,
 *  «각자 잘 하나» 가 아니라 «셋이 같은가» 를 묻는다([[feedback_every_feature_llm_agnostic]]).
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const readRel = (rel: string): Promise<string> =>
  readFile(new URL(rel, import.meta.url), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export const check: RegressionCheck = {
  name: "every-adapter-compacts",
  guards:
    "openai 어댑터가 오래된 대화를 요약 없이 버리고 사용자에게 알리지도 않던 것 — 같은 기능이 어댑터마다 갈려 있던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = {
      codex: stripComments(
        await readRel("../../core/llm-runtime/adapters/openai-codex-oauth-history.ts"),
      ),
      openai: stripComments(
        await readRel("../../core/llm-runtime/adapters/openai-agents-sdk.ts"),
      ),
      claude: stripComments(
        await readRel("../../core/llm-runtime/adapters/claude-agent-sdk.ts"),
      ),
    };

    // ── ① 우리가 히스토리를 주입하는 어댑터는 **전부** 압축을 지난다 ────────────
    //  claude 는 SDK 가 압축하므로 대상이 아니다 — 그 판정도 코드로 확인한다(문서 말고).
    const weInject = (s: string): boolean => /loadThreadHistory|compactThreadHistory/.test(s);
    const compacts = (s: string): boolean => /compactThreadHistory\(/.test(s);
    const rows = [
      ["codex", src.codex],
      ["openai", src.openai],
    ] as const;
    const missing = rows.filter(([, s]) => weInject(s) && !compacts(s)).map(([n]) => n);
    out.push(
      assert(
        "★히스토리를 우리가 주입하는 어댑터는 **전부** 압축 드라이버를 지난다(한쪽만 지나면 같은 대화가 어댑터에 따라 사라진다)",
        missing.length === 0,
        missing.length === 0
          ? `주입 어댑터 ${rows.filter(([, s]) => weInject(s)).map(([n]) => n).join("·")} 전부 압축`
          : `압축 안 함: ${missing.join("·")}`,
      ),
      assert(
        // ★처음 쓴 판은 «claude 는 loadThreadHistory 를 안 부른다» 였는데 **틀렸다**(이 검사
        //  자신이 잡았다). claude 도 부르지만 **자기 히스토리용이 아니다** — 다른 어댑터에서
        //  온 델타(cross-adapter)에만 쓰고, 자기 대화는 SDK resume 이 나르고 SDK 가 압축한다.
        //  ★그래서 claude 의 그 델타 블록은 아직 요약을 안 지난다(캡에 걸리면 조용히 잘린다).
        //   좁은 경로라 이번 범위 밖으로 두고 로드맵에 적었다 — 여기선 **자리만** 못 박는다.
        "★claude 가 히스토리를 부르는 자리는 **cross-adapter 델타뿐**이고 자기 대화는 SDK 가 압축한다",
        (() => {
          const at = src.claude.indexOf("loadThreadHistory(");
          if (at < 0) return false;
          const around = src.claude.slice(Math.max(0, at - 400), at + 600);
          return (
            /computeForeignDelta/.test(around) &&
            (src.claude.match(/loadThreadHistory\(/g) ?? []).length === 1 &&
            /PostCompact:\s*\[/.test(src.claude)
          );
        })(),
        `호출 ${(src.claude.match(/loadThreadHistory\(/g) ?? []).length}회 · 델타 문맥 ${/computeForeignDelta/.test(src.claude)} · SDK 압축 훅 ${/PostCompact:\s*\[/.test(src.claude)}`,
      ),
    );

    // ── ② 판정은 **한 곳**이다 — 어댑터가 자기 임계·자기 자르기를 갖지 않는다 ────
    const ownPolicy = rows
      .filter(([, s]) => /planHistoryCompaction\(|upsertThreadSummary\(/.test(s) && !/^$/.test(s))
      .map(([n]) => n)
      .filter((n) => n !== "codex"); // codex 파일이 드라이버의 집이다
    out.push(
      assert(
        "★어댑터가 압축 판정을 **자기 것으로** 갖지 않는다(같은 판단이 두 곳이면 한쪽만 고쳐져 갈린다)",
        ownPolicy.length === 0,
        ownPolicy.length === 0 ? "자체 판정 0곳" : `자체 판정 보유: ${ownPolicy.join("·")}`,
      ),
      assert(
        "★남길 턴 고르기도 한 곳이다 — 어댑터가 자기 꼬리 자르기를 다시 적지 않는다",
        /recentTurnsAfter\(/.test(src.openai) && /recentTurnsAfter\(/.test(src.codex),
        `openai ${/recentTurnsAfter\(/.test(src.openai)} · codex ${/recentTurnsAfter\(/.test(src.codex)}`,
      ),
    );

    // ── ③ 드라이버를 **실행**해 어댑터 무관임을 본다 ────────────────────────────
    const {
      compactThreadHistory,
      recentTurnsAfter,
      CODEX_HISTORY_COMPACT_TRIGGER_CHARS: TRIGGER,
    } = (await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js")) as {
      compactThreadHistory: (a: {
        channel: string;
        threadKey: string;
        provider?: string;
        adapter: string;
        summarize: (text: string, targetChars: number) => Promise<string>;
      }) => Promise<{
        allTurns: { id: number; role: string; content: string }[];
        summary: string;
        watermark: number;
      }>;
      recentTurnsAfter: (
        t: { id: number; role: string; content: string }[],
        w: number,
        o: { budgetUsedChars: number },
      ) => { role: string; content: string }[];
      CODEX_HISTORY_COMPACT_TRIGGER_CHARS: number;
    };
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn, loadThreadHistoryWithIds } = await import(
      "../../store/memory.js"
    );
    const { clearThreadSummary } = await import("../../store/thread-summaries.js");

    initStore();
    const TK = "regr:every-adapter-compacts";
    clearThreadSummary("http-bridge", TK);
    indexCodexTurn({ channel: "http-bridge", threadKey: TK, claudeSessionId: "regr-eac-sid" });
    const turnCount = 200;
    const per = Math.ceil((TRIGGER * 1.4) / turnCount);
    const have = loadThreadHistoryWithIds("http-bridge", TK);
    if (have.length < turnCount) {
      let ts = 1_700_000_000_000;
      for (let i = have.length; i < turnCount; i++) {
        appendTranscript({
          claudeSessionId: "regr-eac-sid",
          role: i % 2 === 0 ? "user" : "assistant",
          content: `턴${i}:` + "가".repeat(Math.max(1, per - 8)),
          ts: (ts += 60_000),
        });
      }
    }

    const seenAdapters: string[] = [];
    let failAdapters: string[] = [];
    const { getEventBus } = await import("../../core/eventbus.js");
    const unsub = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
      if (e.type === "llm.compacting" || e.type === "llm.compacted") {
        seenAdapters.push(
          `${e.type}:${String((e.payload as { adapter?: unknown })?.adapter ?? "?")}`,
        );
      }
    });
    let r: Awaited<ReturnType<typeof compactThreadHistory>>;
    try {
      r = await compactThreadHistory({
        channel: "http-bridge",
        threadKey: TK,
        adapter: "openai", // ★codex 가 아닌 이름으로 돌린다
        summarize: async (_t: string, target: number) =>
          "요약:" + "약".repeat(Math.max(0, target - 3)),
      });
    } finally {
      unsub();
    }

    out.push(
      assert(
        "★드라이버가 **openai 이름으로도** 접는다(codex 전용 분기가 없다)",
        r.watermark > 0 && r.summary.length > 0,
        `워터마크 ${r.watermark} · 요약 ${r.summary.length}자 · 전체 ${r.allTurns.length}턴`,
      ),
      assert(
        // ★**성공만 보면 모자란다** (2026-09-15, 실호출이 잡았다). 하드코딩된 `"codex"` 를
        //  뺄 때 실패 경로에 진짜 값을 안 넘겨 `adapter=undefined` 가 나갔는데, 검사가
        //  성공 경로만 세고 있어서 초록이었다. **실패도 같은 이름을 실어야** 화면이
        //  «누가 실패했는지» 를 말한다.
        "★관측 이벤트가 **성공·실패 모두** 그 어댑터 이름을 싣는다 — 화면이 누가 접었는지 말할 수 있어야 한다",
        seenAdapters.length > 0 && seenAdapters.every((x) => x.endsWith(":openai")),
        `발행: ${seenAdapters.join(" · ") || "(없음)"}`,
      ),
      assert(
        "★요약이 **실패**했을 때도 끝 신호가 그 어댑터 이름을 싣는다",
        await (async () => {
          const got: string[] = [];
          const u = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
            if (e.type === "llm.compact_failed") {
              got.push(String((e.payload as { adapter?: unknown })?.adapter ?? "undefined"));
            }
          });
          try {
            clearThreadSummary("http-bridge", TK);
            await compactThreadHistory({
              channel: "http-bridge",
              threadKey: TK,
              adapter: "openai",
              summarize: async () => {
                throw new Error("일부러 실패");
              },
            });
          } finally {
            u();
          }
          failAdapters = got;
          return got.length > 0 && got.every((a) => a === "openai");
        })(),
        `실패 신호의 adapter: ${failAdapters.join("·") || "(없음)"}`,
      ),
      assert(
        "★접힌 구간은 **원문에서 빠지고** 요약으로 남는다(버린 게 아니라 접힌 것)",
        (() => {
          const recent = recentTurnsAfter(r.allTurns, r.watermark, { budgetUsedChars: 0 });
          const foldedGone = recent.every((t) => !t.content.startsWith("턴0:"));
          return foldedGone && recent.length > 0 && recent.length < r.allTurns.length;
        })(),
        `전체 ${r.allTurns.length}턴 → 남긴 ${recentTurnsAfter(r.allTurns, r.watermark, { budgetUsedChars: 0 }).length}턴 + 요약 ${r.summary.length}자`,
      ),
    );

    // ── ④ 요약 호출이 **본 턴과 같은 조립·취소**를 지난다 (2026-09-15 아스트라 지적) ──
    //  첫 판은 요약기를 `new Agent({...})` 로 직접 만들어 `modelSettings` 를 통째로 생략했다.
    //  그러면 추론 강도도, 벤더 기본값 보존도 잃는다 — **같은 날 codex 에서 고친 그 부류**를
    //  openai 에 새로 심은 것이다. 그리고 `maxTurns` 는 시간 제한이 아니라서, 부모 턴을
    //  끊어도 요약 호출은 계속 돌았다.
    const sumAt = src.openai.indexOf("summarize: async (");
    const sumBlock = sumAt < 0 ? "" : src.openai.slice(sumAt, sumAt + 1400);
    out.push(
      assert(
        "★요약기를 **직접 조립하지 않는다** — 본 턴과 같은 팩토리를 지나야 강도·벤더 기본값이 산다",
        sumAt >= 0 &&
          /createOpenAiAgent\(/.test(sumBlock) &&
          !/new Agent\(/.test(sumBlock) &&
          /reasoningEffort,/.test(sumBlock),
        sumAt < 0
          ? "요약 블록을 못 찾음"
          : `팩토리 ${/createOpenAiAgent\(/.test(sumBlock)} · 직접생성 ${/new Agent\(/.test(sumBlock)} · 강도전달 ${/reasoningEffort,/.test(sumBlock)}`,
      ),
      assert(
        "★요약기는 **도구를 안 받는다**(요약이 도구를 쓰면 안 된다)",
        /mcpServers: \[\]/.test(sumBlock) && /externalTools: \[\]/.test(sumBlock),
        `mcp ${/mcpServers: \[\]/.test(sumBlock)} · 외부도구 ${/externalTools: \[\]/.test(sumBlock)}`,
      ),
      assert(
        // ★저빈도 실패(«요약 0자»)가 났을 때 **원인을 좁힐 수치**가 로그에 남아야 한다.
        //  실측 6패스 중 2회 발생했는데 로그엔 그 문구뿐이라 재료가 0이었고, 계측판으로는
        //  8/8 성공해 재현이 안 됐다. 추측으로 재시도를 넣으면 원인이 다를 때 비용만 두 배다.
        "★요약이 **빈 결과**면 판정 수치를 남긴다(델타 수·이벤트 종류·입력 크기·경과) — 재현 안 되는 것은 로그로 잡는다",
        /요약이 빈 결과/.test(src.openai) &&
          /델타 \$\{deltas\}개/.test(src.openai) &&
          /이벤트=\$\{JSON\.stringify\(Object\.fromEntries\(evKinds\)\)\}/.test(src.openai) &&
          /thread=\$\{input\.threadKey\}/.test(src.openai),
        `빈결과 경고 ${/요약이 빈 결과/.test(src.openai)} · 델타수 ${/델타 \$\{deltas\}개/.test(src.openai)} · 이벤트종류 ${/evKinds/.test(src.openai)} · 스레드 ${/thread=\$\{input\.threadKey\}/.test(src.openai)}`,
      ),
      assert(
        "★**취소와 시간 예산이 요약까지 온다** — `maxTurns` 는 시간 제한이 아니다",
        /signal:/.test(sumBlock) &&
          /input\.abortSignal/.test(sumBlock) &&
          /createIdleTimer\(/.test(sumBlock),
        `signal ${/signal:/.test(sumBlock)} · 부모취소 ${/input\.abortSignal/.test(sumBlock)} · 시간예산 ${/createIdleTimer\(/.test(sumBlock)}`,
      ),
      assert(
        "★claude 는 **턴이 끝날 때** 남은 압축 상태를 닫는다(중단·오류로 끝나면 어느 훅도 안 온다)",
        (() => {
          const at = src.claude.lastIndexOf("} finally {");
          const tail = at < 0 ? "" : src.claude.slice(at, at + 1200);
          return (
            /compactStartedAt !== null/.test(tail) &&
            /"llm\.compact_failed"/.test(tail) &&
            /compactStartedAt = null/.test(tail)
          );
        })(),
        (() => {
          const at = src.claude.lastIndexOf("} finally {");
          const tail = at < 0 ? "" : src.claude.slice(at, at + 1200);
          return `잔여판정 ${/compactStartedAt !== null/.test(tail)} · 끝신호 ${/"llm\.compact_failed"/.test(tail)} · 상태해제 ${/compactStartedAt = null/.test(tail)}`;
        })(),
      ),
    );

    return out;
  },
};
