/**
 * 회귀: **플러그인이 턴 밖에서 행동한다 — 선언한 만큼만** (2026-08-29).
 *
 * ★왜 생겼나 — **실측이 근거다.** 상시 정책("플러그인이 이걸 할 수 있나? 못 한다면 무엇이
 *  막나")으로 재보니 이렇게 갈렸다:
 *
 *  ```
 *  running-work (보여주기만)  → 코어 import  0개
 *  file-watch   (행동)        → claude · outbound · eventbus · threadkey
 *  scheduler    (행동)        → 위 넷 + worker-jobs · settings
 *  ```
 *
 *  **보여주는 길은 열려 있었고 행동하는 길은 잠겨 있었다.** `PluginHost` 는 `postCard` 를
 *  줬지만 그건 *"지금 하는 답에 카드를 붙인다"* 라 **턴이 있어야** 한다 — 스케줄러엔 턴이
 *  없다. 그래서 서드파티는 스케줄러·파일감시를 **원리적으로 못 만들었다.**
 *
 * 지키는 것 여섯:
 *  ① **미선언이면 못 한다** — 세 능력 전부. 조용히 되면 선언은 장식이다.
 *  ② ★**`ask` 에 `model`·`provider` 가 없다** — 코어 실행 입력엔 있다. 그걸 열면 플러그인이
 *     특정 어댑터를 박고 *"모든 기능 LLM 무관"* 이 플러그인 층에서 깨진다.
 *  ③ ★**도구는 기본 0개**(정태님 결정). 반대로 두면 위젯 만든 사람이 파일 조작 도구를 쥔
 *     모델을 무심코 돌린다.
 *  ④ ★**`say` 는 `deliverOutbound` 를 지난다** — 우회하면 대시보드에 안 보인다(2026-06-30
 *     실사고). 그리고 **미배달을 성공으로 읽지 않는다**(스케줄러가 그래서 매일 아침
 *     리포트를 만들고 아무 데도 안 보내고 DB 엔 ok 를 남겼다).
 *  ⑤ **좌표는 인자가 아니라 정체성에서** — 플러그인이 남의 대화에 못 닿는다.
 *  ⑥ ★**권한이 사람 눈에 보인다** — 격리가 0인 지금 이 선언의 값은 **오직 보이는 데** 있다.
 *     안 보이면 적을 이유도 없다.
 *
 * 등급: ①③⑤⑥은 **동작**(순수 함수·호스트 실행), ②는 표면 대조(런타임엔 이미 없으므로
 * 소스로만 확인 가능), ④는 실제 발송 경로를 채널 등록으로 세워 **실행**한다.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import {
  createPluginHost,
  describeNeeds,
  eventAllowed,
  pluginThreadKey,
  readNeeds,
  toolPolicyFor,
} from "../../core/plugins/host.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "plugin-acts-outside-turn",
  guards:
    "행동하는 플러그인(스케줄러류)이 안정된 공개 면 없이 코어를 상대경로로 짚어야 했던 것(★능력이 막힌 게 아니다 — 격리가 0이라 늘 가능했고, 없던 건 계약이다) + 그 면을 여는 순간 생기는 넷: 선언 없이 되는 것 · 플러그인이 어댑터를 박아 LLM 무관이 깨지는 것 · 모델이 기본으로 도구 전권을 쥐는 것 · 자기 말이 대시보드를 우회하거나 미배달을 성공으로 읽는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 미선언이면 못 한다 (동작) ────────────────────────────────────────
    const bare = createPluginHost("regr-bare", {});
    const sayBare = await bare.say({ channel: "x", target: null, text: "hi" });
    const askBare = await bare.ask({ prompt: "hi" });
    out.push(
      assert(
        "★★**대가가 있는 것**은 선언해야 된다(발화·모델) — 폰에 메시지가 가고 돈이 나가는 일이라, 안 적고 되면 플러그인 메뉴의 권한 표시가 거짓말이 된다",
        !sayBare.ok && !askBare.ok,
        `say.ok=${String(sayBare.ok)} · ask.ok=${String(askBare.ok)}`,
      ),
    );
    out.push(
      assert(
        "거부 사유가 **무엇을 적어야 하는지** 말한다 — `false` 만 받으면 만든 사람은 자기 코드를 뒤진다",
        sayBare.error?.includes("needs.outbound") === true &&
          (askBare as { error?: string }).error?.includes("needs.llm") === true,
        `${String(sayBare.error).slice(0, 40)}… / ${String((askBare as { error?: string }).error).slice(0, 40)}…`,
      ),
    );

    let ungated = "";
    {
      let n = 0;
      try {
        const stop = bare.on("worker.started", () => {
          n += 1;
        });
        getEventBus().publish({ type: "worker.started", ts: 0, payload: {} });
        const during = n;
        stop();
        getEventBus().publish({ type: "worker.started", ts: 0, payload: {} });
        ungated = `구독 ${String(during)}건 · 해지 후 ${String(n)}건`;
      } catch (e) {
        ungated = `★던짐: ${e instanceof Error ? e.message.slice(0, 40) : String(e)}`;
      }
    }
    out.push(
      assert(
        "★★**이벤트 구독엔 게이트가 없다**(정태님 2026-08-29) — 읽는 건 사용자에게 대가가 없고, 매니페스트 한 줄이 빠졌다고 서드파티 플러그인이 부팅에서 죽는 건 과하다. 게이트를 되살리면 여기가 잡는다",
        ungated === "구독 1건 · 해지 후 1건",
        ungated,
      ),
    );

    // ── ① 선언하면 된다 + 접두사·해지 (동작) ────────────────────────────────
    const full = createPluginHost("regr-acts", { outbound: true, llm: true });
    let got = 0;
    const off = full.on("worker.", () => {
      got += 1;
    });
    const bus = getEventBus();
    bus.publish({ type: "worker.started", ts: 1, payload: {} });
    bus.publish({ type: "schedule.fired", ts: 2, payload: {} });
    const afterPublish = got;
    off();
    bus.publish({ type: "worker.done", ts: 3, payload: {} });
    out.push(
      assert(
        "★★선언한 접두사만 받고, **해지하면 멈춘다** — 안 멈추면 꺼진 플러그인이 계속 깨어난다(로더가 dispose 시점을 주는데 그게 무의미해진다)",
        afterPublish === 1 && got === 1,
        `구독 중 ${String(afterPublish)}건(worker.started 만) · 해지 후 ${String(got)}건`,
      ),
    );
    out.push(
      assert(
        "★접두사 판정이 **부분 문자열이 아니다** — `worker` 선언이 `worker.started` 를 먹으면 선언보다 넓게 받는다",
        !eventAllowed(["worker"], "worker.started") &&
          eventAllowed(["worker."], "worker.started") &&
          !eventAllowed(["worker."], "workers.x"),
        `worker→${String(eventAllowed(["worker"], "worker.started"))} · worker.→${String(eventAllowed(["worker."], "worker.started"))}`,
      ),
    );
    out.push(
      assert(
        "★`events` 는 **권한 키가 아니다** — 모르는 키로 거부돼야 한다(집행 없는 선언 금지: 집행을 걷어냈으면 키도 걷어낸다)",
        readNeeds({ events: ["worker."] }).problems.length === 1,
        readNeeds({ events: ["worker."] }).problems[0]?.slice(0, 60) ?? "★키가 살아 있다",
      ),
    );

    // ── ② `ask` 표면에 어댑터 선택이 없다 (소스 대조) ────────────────────────
    // ★등급을 정직하게: 런타임엔 타입이 이미 없으므로 소스로만 볼 수 있다. 대신 **코어에는
    //  있다는 것**까지 같이 확인해 이 검사가 공짜로 통과하지 않게 한다.
    const hostSrc = readFileSync(path.join(REPO, "src/core/plugins/host.ts"), "utf8");
    const askSig = /ask\(input: \{[^}]*\}\)/.exec(hostSrc)?.[0] ?? "";
    const coreSrc = readFileSync(path.join(REPO, "src/core/llm-runtime/types.ts"), "utf8");
    const coreHasThem = /^\s+model\?: string;/m.test(coreSrc) && /^\s+provider\?: string;/m.test(coreSrc);
    out.push(
      assert(
        "★★`ask` 의 입력에 `model`·`provider` 가 **없다** — 코어 실행 입력엔 있고(확인함), 그걸 그대로 열면 플러그인이 특정 어댑터를 박아 *모든 기능 LLM 무관* 이 플러그인 층에서 깨진다",
        coreHasThem && !/model|provider|reasoning/.test(askSig),
        `코어에 있음=${String(coreHasThem)} · ask 서명=${askSig || "(못 찾음)"}`,
      ),
    );
    // ★배포 레포엔 `packages/plugin` 이 **없다**(2026-08-29 manifest 제외 — 타입 패키지를
    //  안 내보낸다). 없으면 대상 없음으로 세되 **조용히 통과하지 않는다**(증거란에 적는다).
    const countOf = (rel: string): number => {
      const f = path.join(REPO, rel);
      return existsSync(f) ? readFileSync(f, "utf8").split("runClaude").length - 1 : -1;
    };
    const surfaceRunClaude = countOf("packages/plugin/index.ts");
    const hostRunClaude = hostSrc.split("runClaude").length - 1;
    const facadeRunClaude = countOf("src/core/claude.ts");
    out.push(
      assert(
        '★공개 면이 `runClaude` 라는 **이름**을 내지 않는다 — 그건 LLM 무관 라우터의 옛 별칭인데, 그 이름이 계약이 되면 서드파티가 "Claude 를 부르는 함수" 로 읽는다',
        surfaceRunClaude <= 0 && hostRunClaude === 0,
        `공개 면 ${surfaceRunClaude === -1 ? "대상 없음(배포 레포엔 packages/plugin 이 없다)" : `${String(surfaceRunClaude)}건`} · 호스트 ${String(hostRunClaude)}건 (코어 파사드엔 ${facadeRunClaude === -1 ? "—" : String(facadeRunClaude)}건 있다 — 이 검사가 공짜로 통과하지 않는다는 뜻)`,
      ),
    );

    // ── ③ 도구는 기본 0개 (동작) ────────────────────────────────────────────
    out.push(
      assert(
        "★★모델을 부를 수 있어도 **도구는 언제나 0개** — 한때 `needs.tools` 로 좁힐 수 있게 했다가 되돌렸다(적대 검토 A): `{mode:\"allow\"}` 의 names 를 읽는 코드가 **0곳**이라 어댑터가 전체 도구로 degrade 했고, **좁히려고 적은 사람이 가장 넓게 열렸다**",
        toolPolicyFor({ llm: true }).mode === "none" && toolPolicyFor({}).mode === "none",
        `llm만=${JSON.stringify(toolPolicyFor({ llm: true }))} · 빈선언=${JSON.stringify(toolPolicyFor({}))}`,
      ),
    );

    // ── ④ say 는 실제 배달 경로를 지나고, 미배달을 성공으로 안 읽는다 ─────────
    const seen: Array<{ text: string }> = [];
    registerChannelOutbound("regr-acts-ch", {
      deliver: async (_target: string | null, text: string) => {
        seen.push({ text });
      },
    } as never);
    const sent = await full.say({ channel: "regr-acts-ch", target: "t", text: "안녕" });
    const missing = await full.say({ channel: "regr-acts-없는채널", target: "t", text: "안녕" });
    unregisterChannelOutbound("regr-acts-ch");
    out.push(
      assert(
        "★★`say` 가 **실제 채널 발송 경로를 지난다** — 우회하면 물리적으로는 가는데 대시보드엔 안 보인다(2026-06-30 실사고: 스케줄 발화가 그렇게 사라졌다)",
        sent.ok && seen.length === 1 && seen[0]?.text.includes("안녕") === true,
        `배달 ${String(seen.length)}건 · 본문="${seen[0]?.text ?? ""}"`,
      ),
    );
    out.push(
      assert(
        "★★**미배달을 성공으로 읽지 않는다** — 미등록 채널이 조용한 성공이 되면, 매일 아침 LLM 을 태워 리포트를 만들고 아무 데도 안 보내고 DB 엔 ok 가 남는다(실제로 그랬다)",
        !missing.ok && (missing.error ?? "") !== "",
        `ok=${String(missing.ok)} · 사유="${String(missing.error).slice(0, 50)}"`,
      ),
    );

    // ── ⑤ 좌표는 정체성에서 파생 (동작) ─────────────────────────────────────
    out.push(
      assert(
        "★★대화 좌표가 **인자가 아니라 플러그인 이름에서** 나온다 — 인자로 받으면 플러그인이 `dashboard:default`(사용자의 실제 대화)에 끼어들 수 있다",
        pluginThreadKey("weather") === "plugin:weather:default" &&
          pluginThreadKey("weather", "seoul") === "plugin:weather:seoul" &&
          pluginThreadKey("dashboard") === "plugin:dashboard:default",
        `${pluginThreadKey("weather")} · ${pluginThreadKey("weather", "seoul")} · ★이름이 dashboard 여도→${pluginThreadKey("dashboard")}`,
      ),
    );

    // ── ⑥ 권한이 사람 눈에 보인다 (동작) ────────────────────────────────────
    const shown = describeNeeds(
      readNeeds({ outbound: true, llm: true }).needs,
    );
    out.push(
      assert(
        "★★새 권한이 **사람이 읽는 한 줄에 나온다** — 격리가 0인 지금 이 선언은 강제가 아니라 의도 표명이고, 그 값은 오직 보이는 데 있다(안 보이면 적을 이유도 없다)",
        shown.includes("스스로 말함") &&
          shown.includes("모델 호출(도구 없음)"),
        shown,
      ),
    );
    out.push(
      assert(
        "도구를 안 적으면 **그렇다고 말한다** — `모델 호출` 만 있으면 사람은 도구 전권을 상상한다",
        describeNeeds(readNeeds({ llm: true }).needs).includes("모델 호출(도구 없음)"),
        describeNeeds(readNeeds({ llm: true }).needs),
      ),
    );

    return out;
  },
};
