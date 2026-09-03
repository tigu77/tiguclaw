/**
 * 회귀: **플러그인 선언이 사용자의 언어로 보인다** (2026-08-30 구조 검토).
 *
 * 사고: `describeNeeds` 가 **한국어 문장**을 만들어 그대로 API 에 실렸고, 대시보드가 그걸
 * `textContent` 로 박았다. 감싸는 문구(`plugins.installed`)만 카탈로그를 타고 **안쪽
 * 문자열은 안 탔다** — 그래서 영어 로케일 사용자는 플러그인 목록에서 한국어를 봤다.
 *
 * ★하필 그 면이다. `docs/security.ko.md §2` 가 *"설치 전에 여기서 무엇을 요구하는지
 *  읽으세요"* 라고 **가리키는 자리**다. 못 읽으면 그 안내가 통째로 무효다. 표시 흠으로
 *  보이지만 실제로는 **사용자가 신뢰 판단을 하는 근거**가 안 닿는 것이다.
 *
 * 고침: 판단은 코어 한 곳(`needsFacts` = 데이터), 표현은 가장자리(화면이 카탈로그로 조립).
 * 로그용 한국어 문장도 **같은 데이터에서 파생**시켜 두 벌이 갈리지 않게 했다.
 *
 * 지키는 것 넷:
 *  ① `describeNeeds` 가 `needsFacts` 에서 **파생**된다 — 따로 조립하면 화면과 로그가 갈린다.
 *  ② 화면 렌더가 **양쪽 카탈로그로 실제로 돌아** 각 언어의 문장을 낸다(문자열 검사 아님).
 *  ③ ★**옛 데몬 폴백** — 업데이트 도중 새 화면 + 옛 데몬이면 `needsFacts` 가 없다.
 *     빈 칸이 아니라 옛 문장을 보여줘야 한다(빈 칸은 "요구 없음" 으로 읽힌다).
 *  ④ ★**모르는 kind 를 감추지 않는다** — 코어가 선언 종류를 늘렸는데 화면이 옛 것이면,
 *     그 항목을 조용히 빼는 대신 kind 이름이라도 보여준다(빠지면 권한이 축소돼 보인다).
 *
 * 등급: ①은 실행(코어 함수), ②③④는 **화면 코드를 실제로 실행**해 문장을 만든다.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsFacts, describeNeeds } from "../../core/plugins/host.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 화면의 `needsText` 를 **파일에서 뽑아 실행**한다 — 사본을 만들면 그게 두 번째 진실이다. */
const loadNeedsText = (catalog: Record<string, string>): ((p: unknown) => string) => {
  const src = readFileSync(path.join(REPO, "packages/dashboard/js/view-plugins.js"), "utf8");
  const from = src.indexOf("const needsText =");
  const to = src.indexOf("const pluginAction");
  if (from < 0 || to <= from) throw new Error("needsText 를 못 찾음");
  const i18n = (key: string, params?: Record<string, unknown>): string => {
    const hit = catalog[key];
    const raw = typeof hit === "string" && hit !== "" ? hit : key;
    return params === undefined
      ? raw
      : raw.replace(/\{(\w+)\}/g, (w, n: string) =>
          params[n] === undefined ? w : String(params[n]),
        );
  };
  return new Function("i18n", `${src.slice(from, to)}; return needsText;`)(i18n) as (
    p: unknown,
  ) => string;
};

const cat = (name: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(REPO, `locales/${name}.json`), "utf8")) as Record<
    string,
    string
  >;

export const check: RegressionCheck = {
  name: "plugin-needs-speak-my-language",
  guards:
    "플러그인이 요구하는 권한이 **한국어 문장**으로 API 에 실려, 영어 로케일 사용자가 목록에서 못 읽던 것 — 하필 docs/security.ko.md §2 가 '설치 전에 여기서 읽으세요' 라고 가리키는 면이라, 표시 흠이 아니라 신뢰 판단 근거가 안 닿는 것이었다 + 그걸 고치다 화면과 로그가 각자 문장을 조립해 갈리는 것 + 업데이트 도중(새 화면·옛 데몬) 요구사항이 빈 칸으로 보여 '요구 없음' 으로 읽히는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const sample = { network: ["api.open-meteo.com"], ui: ["chat-widget"] as "chat-widget"[], outbound: true, llm: true };

    // ── ① 로그 문장이 데이터에서 파생된다 ────────────────────────────────────
    const facts = needsFacts(sample);
    const ko = describeNeeds(sample);
    const kinds = facts.map((f) => f.kind);
    out.push(
      assert(
        "★★로그 문장이 `needsFacts` 와 **같은 항목·같은 순서**를 낸다 — 따로 조립하면 화면과 로그가 다른 말을 한다",
        ko.split(" · ").length === facts.length && kinds.join(",") === "network,ui,outbound,llm",
        `facts=[${kinds.join(", ")}] · 문장="${ko}"`,
      ),
    );

    // ── ② 두 언어가 각자 자기 문장을 낸다 ────────────────────────────────────
    const shown = (locale: string, p: unknown): string => loadNeedsText(cat(locale))(p);
    const koLine = shown("ko", { needsFacts: facts });
    const enLine = shown("en", { needsFacts: facts });
    out.push(
      assert(
        "한국어 화면은 종전과 같은 문장을 낸다(고치면서 한국어 사용자 경험을 바꾸지 않았다)",
        koLine === ko,
        `화면="${koLine}"`,
      ),
    );
    out.push(
      assert(
        "★★영어 화면에 **한글이 없다** — 이게 이 사고의 본체다(카탈로그를 안 타면 여기서 한글이 그대로 나온다)",
        !/[가-힣]/.test(enLine) && enLine !== koLine && enLine.includes("api.open-meteo.com"),
        `화면="${enLine}"`,
      ),
    );
    out.push(
      assert(
        "선언이 없어도 **모른다고 말한다**(빈 칸은 '요구 없음' 으로 읽힌다)",
        shown("en", { needsFacts: needsFacts({}) }).trim() !== "" &&
          !/[가-힣]/.test(shown("en", { needsFacts: needsFacts({}) })),
        `"${shown("en", { needsFacts: needsFacts({}) })}"`,
      ),
    );

    // ── ③ 옛 데몬 폴백 ──────────────────────────────────────────────────────
    out.push(
      assert(
        "★업데이트 도중(새 화면 + 옛 데몬 = `needsFacts` 없음) **옛 문장이라도 보여준다** — 빈 칸보다 낫다",
        shown("en", { needs: ko }) === ko,
        `"${shown("en", { needs: ko })}"`,
      ),
    );

    // ── ④ 모르는 kind 를 감추지 않는다 ──────────────────────────────────────
    out.push(
      assert(
        "★코어가 선언 종류를 늘렸는데 화면이 옛 것이면 **이름이라도 보여준다** — 조용히 빼면 권한이 실제보다 좁아 보인다",
        shown("en", { needsFacts: [{ kind: "someFutureNeed" }] }).includes("someFutureNeed"),
        `"${shown("en", { needsFacts: [{ kind: "someFutureNeed" }] })}"`,
      ),
    );

    // ── 거부 사유도 화면 언어로 ─────────────────────────────────────────────
    // ★사고(2026-08-30, 적대 검토 C조 C3): 매니저가 내는 거부 사유가 **한국어 고정 문장**
    //  이었고 화면이 그걸 그대로 토스트에 띄웠다. 영어 사용자는 한국어를 만난다 — 이
    //  릴리스가 "화면 언어대로 나옵니다" 라고 고친 바로 그 기능의 형제 경로다.
    //
    // ★기존 그물이 왜 못 봤나: *"서버는 화면 문구를 만들지 않는다"* 축이 생산자를 **모양**
    //  으로 고른다(`{key:"a.b"}`·`views:`·`actions:`). `{ ok:false, reason:"한국어" }` 는
    //  그 어느 모양도 아니라 대상에서 빠졌다. 손 목록을 모양 규칙으로 바꿨는데 새 모양이
    //  또 밖으로 나간 것이다. 그래서 여기선 **그 파일의 사유 자리를 전수로** 센다.
    // ★**주석을 지우고 짝을 지어서** 본다 (2026-08-30, 적대 검토 E조 F2). 종전엔 개수만
    //  비교해서 두 갈래로 뚫렸다: ①`reason:"…"`(콜론 뒤 공백 없음)를 안 셌고 — 이 레포엔
    //  prettier·lint 가 없어 공백을 강제하는 게 **아무것도 없다** — ②주석에 `reasonKey:` 를
    //  한 줄 남기면 개수가 맞아 초록이었다. 세는 법이 곧 판정이면 세는 법을 뚫으면 된다.
    // ★**토스트에 닿는 파일을 전부 본다** (2026-08-30, 3라운드 D-4). 종전엔 `manager.ts`
    //  한 파일이었다 — 그런데 같은 토스트에 닿는 형제가 하나 더 있었다: 설정 한 칸 쓰기가
    //  실패하면 `writePluginSetting` 의 한국어 문장이 브리지를 지나 그대로 떴다. 헤더는
    //  *"모든 거부 사유"* 라고 적었는데 세는 것은 한 파일뿐이었다(부품은 검사되는데
    //  이음매가 빈 그 모양이다).
    // ★사유 필드 이름이 파일마다 다르다(`reason` / `error`) — **키 이름도 짝을 맞춰** 본다.
    // ★**대상을 손으로 적지 않는다** (2026-08-31, 3라운드). 하루 전 이 자리는 파일 두 개를
    //  배열에 적고 있었고, 그건 이 레포가 이미 네 번 당한 모양이다 — 셋째가 조용히 빠진다
    //  ([[feedback_hand_maintained_lists]]). 규칙으로 바꾼다:
    //
    //    **어떤 파일이 어떤 필드에 키를 한 번이라도 달았으면, 그 파일의 그 필드는 전부 달아야 한다.**
    //
    //  키를 다는 순간 그 파일은 *"이 사유는 화면에 뜬다"* 고 선언한 것이다. 그래서 새 생산자가
    //  생겨도 저절로 들어오고, 애초에 이 게임 밖인 것(`host.ts` 처럼 플러그인 작성자에게 가는
    //  개발자 문장, 라우트의 HTTP `error` 본문)은 끌려 들어오지 않는다.
    const stripComments = (src: string): string =>
      src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    const CANDIDATE_DIRS = ["src/core/plugins", "plugins/http-bridge"];
    const TOAST_SOURCES: Array<{ rel: string; field: "reason" | "error" }> = [];
    for (const dir of CANDIDATE_DIRS) {
      for (const f of readdirSync(path.join(REPO, dir)).filter((n) => n.endsWith(".ts")).sort()) {
        const rel = `${dir}/${f}`;
        const src = stripComments(readFileSync(path.join(REPO, rel), "utf8"));
        for (const field of ["reason", "error"] as const) {
          if (new RegExp(`(?<![a-zA-Z])${field}Key:\\s`).test(src)) TOAST_SOURCES.push({ rel, field });
        }
      }
    }
    out.push(
      assert(
        "★★검사 대상이 **손 목록이 아니다** — 키를 다는 파일은 저절로 들어온다(어제 이 자리는 파일 두 개를 배열에 적고 있었고, 그게 셋째가 조용히 빠지는 그 모양이다)",
        TOAST_SOURCES.length >= 3,
        TOAST_SOURCES.map((t) => `${t.rel.split("/").pop() ?? ""}:${t.field}`).join(" · "),
      ),
    );
    // ★**같은 객체 리터럴 안**을 본다 — 근접 창(뒤 240자)으로 했다가 틀렸다: 바로 다음
    //  `return` 문의 키를 주워 와서, 키 없는 사유를 넣어도 초록이었다. "가까이 있다" 는
    //  "같은 것에 붙어 있다" 가 아니다.
    const enclosingObject = (src: string, at: number): string => {
      const i = src.lastIndexOf("{", at);
      if (i < 0) return "";
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
      }
      return src.slice(i);
    };
    const reasonKeys: string[] = [];
    for (const { rel, field } of TOAST_SOURCES) {
      const src = stripComments(readFileSync(path.join(REPO, rel), "utf8"));
      const keyField = `${field}Key`;
      const hasKey = new RegExp(`${keyField}:\\s*"`);
      const noKey = [...src.matchAll(new RegExp(`(?<![a-zA-Z])${field}:\\s*[\`"]`, "g"))].filter(
        (m) => !hasKey.test(enclosingObject(src, m.index ?? 0)),
      );
      const keys = [...src.matchAll(new RegExp(`${keyField}:\\s*"([a-z0-9.]+)"`, "gi"))];
      reasonKeys.push(...keys.map((m) => m[1] ?? ""));
      out.push(
        assert(
          `★★\`${rel.split("/").pop() ?? rel}\` 가 내는 **모든 거부 사유에 번역 키가 붙어 있다** — 문장만 실으면 그 언어가 곧 화면 언어가 된다(needsFacts 때 이미 겪은 부류다)`,
          keys.length > 0 && noKey.length === 0,
          noKey.length === 0
            ? `사유 ${String(keys.length)}자리 전부 키 있음`
            : `★키 없는 사유 ${String(noKey.length)}자리`,
        ),
      );
    }
    // ★**예외가 사용자 문장이 되는 경계**도 본다 (2026-08-30, E조 F3). 위 검사는 매니저의
    //  `reason:` 객체만 세는데, 같은 토스트에 닿는 길이 하나 더 있었다: 라우트의 `catch` 가
    //  `e.message` 를 그대로 사유로 실어 보내서 코어의 한국어 예외가 영어 사용자에게 갔다.
    //  헤더가 *"모든 거부 사유"* 라고 적었는데 세는 것은 한 파일의 한 모양뿐이었다.
    const inv = readFileSync(path.join(REPO, "plugins/http-bridge/routes-inventory.ts"), "utf8")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    const rawThrow = [...inv.matchAll(/reason:\s*e instanceof Error \? e\.message/g)].filter(
      (m) => !/reasonKey:\s*"/.test(inv.slice(m.index ?? 0, (m.index ?? 0) + 240)),
    );
    out.push(
      assert(
        "★★예외를 사용자에게 옮기는 자리도 **번역된 틀**을 붙인다 — 예외 문구 자체는 번역 대상이 아니지만, 무슨 일이 났는지는 화면 언어로 말해야 한다(부팅 중 버튼 한 번이면 닿는다)",
        rawThrow.length === 0,
        rawThrow.length === 0 ? "맨 예외 전달 0자리" : `★맨 예외 ${String(rawThrow.length)}자리`,
      ),
    );

    // ★**이음매**도 본다 (2026-08-30, 3라운드 D-4). 위 둘은 *부품*이다 — 코어가 키를 달아도
    //  브리지가 문장만 옮기면 화면엔 그대로 한국어가 뜬다. 실제로 그랬다: `writePluginSetting`
    //  의 판정을 `{ ok:false, reason: r.error }` 로만 옮기고 있었다.
    const forwards =
      /reasonKey:\s*r\.errorKey/.test(inv) && /reasonArgs:\s*r\.errorArgs/.test(inv);
    out.push(
      assert(
        "★★설정 쓰기 판정의 **키가 브리지를 건너간다** — 코어가 키를 달아도 옮기는 자리가 문장만 실으면 화면 언어는 여전히 서버의 언어다",
        forwards,
        forwards ? "reasonKey·reasonArgs 둘 다 전달" : "★키가 응답에 안 실림(문장만 감)",
      ),
    );

    const catalogs = ["locales/ko.json", "locales/en.json"].map(
      (f) => JSON.parse(readFileSync(path.join(REPO, f), "utf8")) as Record<string, string>,
    );
    // ★자리표시자↔인자 대조는 **여기 없다** — `i18n-placeholders-match-callsites` 가
    //  그 판정을 이미 갖고 있고, 이 shape(`reasonKey`/`reasonArgs`)을 거기 등록했다
    //  (2026-08-31, 3라운드). 여기에 또 파서를 두려다 되돌렸다: 첫 판이 템플릿 안의
    //  `${name}` 을 감싸는 객체로 오인해 **8건을 오탐**했는데, 저쪽 파서는 그 함정을
    //  이미 세 번 겪고 토크나이저로 넘어간 뒤였다. 같은 판단은 한 곳에 둔다.
    const orphan = [...new Set(reasonKeys)].filter((k) =>
      catalogs.some((c) => typeof c[k] !== "string" || c[k] === ""),
    );
    out.push(
      assert(
        "★★그 키들이 **양쪽 카탈로그에 다 있다** — 없으면 화면에 `plugins.reason.…` 라는 글자가 뜬다(한국어 문장보다 나쁘다)",
        orphan.length === 0,
        orphan.length === 0 ? `${String(reasonKeys.length)}개 전부 ko·en 에 있음` : `★빠짐: ${orphan.join(", ")}`,
      ),
    );

    return out;
  },
};
