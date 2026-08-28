/**
 * 회귀: **플러그인에 건 규칙이 말이 아니라 코드로 지켜진다** (2026-08-28, 위젯 플랫폼).
 *
 * ★설계에 규칙 둘을 적어놓고 **집행하는 코드를 0으로** 두고 있었다:
 *  ①위젯 payload 64KB 상한(쓸 때 거부) ②`needs.network` 선언.
 *  `weather` 가 둘 다 지킨 건 규칙 때문이 아니라 **우연**이었고, 두 번째 플러그인 작성자가
 *  500KB 를 싣거나 선언 안 한 호스트로 나가도 **아무 신호가 없었다.**
 *  이 레포가 여러 번 데인 자리다 — [[feedback_gate_must_actually_run]].
 *
 * ★그래서 이 검사는 **실행**한다. 판정을 순수 함수로 뽑아 뒀으니(`widget-attachment.ts`·
 *  `plugin-fetch.ts`) 경계를 실제로 넘겨볼 수 있다 — 소스에 상한 숫자가 적혀 있나 보는
 *  검사였다면 `if (false)` 하나로 뚫린다.
 *
 * ★**정직한 비대칭**: "선언했으면 맨 `fetch` 를 쓰지 마라" 는 지키지만, 그 역("맨 `fetch` 를
 *  쓰면 선언해라")은 **아직 안 건다**. `telegram-channel` 이 맨 `fetch` 를 쓰는데 그 플러그인의
 *  통신 대부분은 grammy 안에 있어서, 선언을 요구해도 **덮이지 않는 부분이 남는다** — 덮는
 *  범위를 넓혀 말하지 않는다. 라이브러리가 자기 소켓을 여는 경우까지 덮으려면 프로세스
 *  격리가 필요하고 그건 지금 0이다(설계 §H).
 *
 * 등급: **동작 검사** — 진리표·경계·배달을 전부 실제로 부른다. 소스 대조는 ④ 하나뿐이다.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerChannelOutbound } from "../../core/channel-outbound.js";
import { getEventBus } from "../../core/eventbus.js";
import { isDeclaredUrl } from "../../core/plugin-fetch.js";
import {
  WIDGET_PAYLOAD_MAX_BYTES,
  checkWidgetAttachments,
} from "../../core/widget-attachment.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 상한을 **실제로 넘는** payload — 경계를 말로 하지 않고 만든다. */
const big = { blob: "가".repeat(WIDGET_PAYLOAD_MAX_BYTES) };
const small = { tempC: 24 };

export const check: RegressionCheck = {
  name: "plugin-rules-are-enforced",
  guards:
    "위젯 payload 상한과 needs.network 선언이 설계 문서에만 있고 집행하는 코드가 0이던 것 — 두 번째 플러그인이 500KB 를 싣거나 선언 안 한 호스트로 나가도 아무 신호가 없었다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① payload 규칙 — 진리표를 실행 ──
    const CASES: Array<[string, unknown, boolean]> = [
      ["정상", { kind: "widget", widget: "weather/forecast", data: small }, true],
      ["상한 초과", { kind: "widget", widget: "weather/forecast", data: big }, false],
      ["딱 상한 안쪽", { kind: "widget", widget: "a/b", data: { s: "x".repeat(1000) } }, true],
      ["이름공간 없음", { kind: "widget", widget: "forecast", data: small }, false],
      ["id 가 문자열 아님", { kind: "widget", widget: 7, data: small }, false],
      ["위젯이 아닌 첨부는 그대로", { kind: "image", mime: "image/png" }, true],
      ["data 없음(허용)", { kind: "widget", widget: "a/b" }, true],
    ];
    const wrong = CASES.filter(([, a, want]) => {
      const v = checkWidgetAttachments([a]);
      return (v.kept.length === 1 && v.rejected.length === 0) !== want;
    });

    // 순환 참조 — 직렬화 불가. `chat_log` 에 못 들어가므로 여기서 잡는 게 맞다.
    const cyc: Record<string, unknown> = { kind: "widget", widget: "a/b" };
    cyc.data = cyc;
    const cycV = checkWidgetAttachments([cyc]);

    out.push(
      assert(
        "★★payload 규칙이 진리표대로다(**실제로 상한을 넘겨본다** — 소스에 숫자가 있나 보는 게 아니다)",
        wrong.length === 0,
        wrong.length === 0 ? `${CASES.length}케이스 통과` : `★틀림: ${wrong.map(([n]) => n).join(" / ")}`,
      ),
      assert(
        "★직렬화 못 하는 data 는 거부한다(`chat_log` 에 못 들어갈 것을 여기서 잡는다)",
        cycV.kept.length === 0 && cycV.rejected.length === 1,
        cycV.rejected.join(" / ") || "★통과시킴",
      ),
      assert(
        "★거부 사유가 **고칠 방법**을 말한다(막혔다는 말만 하면 개발자가 헤맨다)",
        checkWidgetAttachments([{ kind: "widget", widget: "a/b", data: big }]).rejected[0]?.includes(
          "데이터 라우트",
        ) === true,
        (checkWidgetAttachments([{ kind: "widget", widget: "a/b", data: big }]).rejected[0] ?? "").slice(0, 70),
      ),
    );

    // ── ② 배달이 그 판정을 **실제로** 쓴다 — 발행해서 받는다 ──
    registerChannelOutbound("regr-rules", { send: async (): Promise<void> => {} } as never);
    const bus = getEventBus();
    const got: Array<Record<string, unknown>> = [];
    const un = bus.subscribe((e) => {
      if (e.type === "channel.message.out") got.push(e.payload as Record<string, unknown>);
    });
    const { deliverOutbound } = await import("../../core/outbound.js");
    const res = await deliverOutbound({
      channel: "regr-rules",
      target: null,
      text: "본문은 살아야 한다",
      observeThreadKey: "dashboard:probe",
      attachments: [
        { kind: "widget", widget: "a/ok", data: small },
        { kind: "widget", widget: "a/toobig", data: big },
      ],
      bus,
    });
    un();
    const sent = got.find((p) => p.text === "본문은 살아야 한다");
    const kept = (sent?.attachments ?? []) as Array<{ widget?: string }>;

    const cleanRes = await deliverOutbound({
      channel: "regr-rules",
      target: null,
      text: "정상",
      attachments: [{ kind: "widget", widget: "a/ok", data: small }],
      bus,
    });

    out.push(
      assert(
        "★★넘친 위젯만 빠지고 **메시지는 산다**(카드가 크다고 답을 통째로 버리지 않는다)",
        sent !== undefined && kept.length === 1 && kept[0]?.widget === "a/ok",
        sent === undefined ? "★관측 미발행" : `실린 것: ${kept.map((k) => k.widget).join(",") || "없음"}`,
      ),
      assert(
        "★★**조용히 안 빠진다** — 호출자에게 사유를 돌려준다(플러그인 작성자가 즉시 안다)",
        (res.rejectedAttachments ?? []).length === 1 &&
          (res.rejectedAttachments ?? [])[0]?.includes("a/toobig") === true,
        JSON.stringify(res.rejectedAttachments),
      ),
      assert(
        "★규칙을 다 지키면 결과에 잡음이 없다(정상 경로에 필드를 안 붙인다)",
        cleanRes.rejectedAttachments === undefined,
        `키: ${Object.keys(cleanRes).join(",")}`,
      ),
    );

    // ── ③ egress 선언 — 진리표를 실행 ──
    const HOSTS = new Set(["api.open-meteo.com", "geocoding-api.open-meteo.com"]);
    const URLS: Array<[string, boolean]> = [
      ["https://api.open-meteo.com/v1/forecast?x=1", true],
      ["https://geocoding-api.open-meteo.com/v1/search", true],
      ["https://evil.example/x", false],
      ["http://api.open-meteo.com/v1/forecast", false], // 평문 금지
      ["https://sub.api.open-meteo.com/x", false], // 와일드카드 없음
      ["https://api.open-meteo.com.evil.example/x", false], // 접두사 속임수
      ["not a url", false],
      ["file:///etc/passwd", false],
    ];
    const badUrl = URLS.filter(([u, want]) => isDeclaredUrl(HOSTS, u) !== want);

    out.push(
      assert(
        "★★선언 대조가 진리표대로다(평문·와일드카드·접두사 속임수를 전부 막는다)",
        badUrl.length === 0,
        badUrl.length === 0 ? `${URLS.length}케이스 통과` : `★틀림: ${badUrl.map(([u]) => u).join(" / ")}`,
      ),
      assert(
        "★선언이 비면 **아무 데도 못 나간다**(모르면 막는 쪽이 기본)",
        URLS.every(([u]) => !isDeclaredUrl(new Set<string>(), u)),
        `빈 선언으로 통과한 것: ${URLS.filter(([u]) => isDeclaredUrl(new Set<string>(), u)).map(([u]) => u).join(",") || "0건"} (검사 ${URLS.length})`,
      ),
    );

    // ── ④ 배선(소스 대조 — 이 하나뿐이다) ──
    // ★**예제 플러그인은 배포본에 없다**(2026-08-29, 제공자 약관 때문에 제외). 이 배선
    //  단언은 dev 에서만 돈다 — **건너뛰는 사실을 증거란에 남긴다**(조용한 면제 금지).
    const wxFiles = ["src/open-meteo.ts", "src/index.ts"]
      .map((f) => path.join(REPO, "plugins/weather", f))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, "utf8"));
    const wxAbsent = wxFiles.length === 0;
    const strip = (t: string): string => t.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    const bareFetch = wxFiles.some((t) => /(^|[^.\w])fetch\(/.test(strip(t)));
    // ★런타임 import 는 격리의 전제다 — `import type` 은 컴파일 뒤 사라지므로 세지 않는다.
    const runtimeCoreImports = wxFiles.flatMap((t) =>
      [...strip(t).matchAll(/^import\s+(?!type\s)[^;]*from\s+"[^"]*src\/core\/[^"]+"/gm)].map(
        (m) => m[0].slice(0, 60),
      ),
    );
    out.push(
      assert(
        "★★선언한 플러그인은 **맨 `fetch` 를 안 쓴다**(호스트가 준 것만 — 선언이 거짓말이 될 수 없게)",
        wxAbsent || (!bareFetch && wxFiles.some((t) => /host\.fetch\(/.test(t))),
        wxAbsent
          ? "예제 플러그인 없음(배포본) — 대상 없음"
          : `맨 fetch=${bareFetch} · host.fetch=${wxFiles.some((t) => /host\.fetch\(/.test(t))}`,
      ),
      assert(
        "★★플러그인이 코어를 **런타임에 import 하지 않는다**(격리를 나중에 넣으려면 표면이 하나여야 한다 — `import type` 은 사라지므로 무관)",
        wxAbsent || runtimeCoreImports.length === 0,
        wxAbsent
          ? "예제 플러그인 없음(배포본) — 대상 없음"
          : runtimeCoreImports.length === 0
          ? "타입만 의존(실행 의존 0)"
          : `★런타임 의존 ${runtimeCoreImports.length}: ${runtimeCoreImports.join(" / ")}`,
      ),
    );

    return out;
  },
};
