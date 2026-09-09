/**
 * 회귀: **채널 배지는 실재하는 채널에만 붙는다** (2026-08-03 사용자 제보).
 *
 * 사용자가 세션탭의 `VERIFY` 배지를 보고 *"세션탭에 배지도 보일 수 있어? 어떻게
 * 설정하는거지?"* 라고 물었다. 설정 항목은 없었고 — **없는 채널을 지어내고 있었다.**
 *
 * `channelFromThreadKey` 는 `"xxx:"` 형태면 무엇이든 채널명으로 잘라 냈고
 * (`tk.slice(0, tk.indexOf(":"))`), `channelMeta` 는 아는 이름이 아니면 **앞 6글자를
 * 대문자로** 만들어 배지를 지었다. 그래서 검증 스크립트가 남긴 `verify:…` 스레드가
 * 탭에 **VERIFY** 배지를 달고, 툴팁까지 `verify 세션` 이라고 **단언**했다.
 * 그런 채널은 존재한 적이 없다.
 *
 * ★오늘 하루 계속 나온 그 부류다 — 문서·주석·UI 가 코드가 보장하지 않는 것을 말한다.
 *  고침은 라벨을 하나 더 넣는 게 아니라 **정본을 보게 한 것**: 서버 `/api/channels`
 *  (살아 있는 채널 presence)에 있는 이름만 배지 대상. 손으로 유지하는 목록이 아니라
 *  실제 목록이므로 새 채널이 붙으면 저절로 배지가 생기고, 가짜는 영영 안 생긴다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Meta {
  short: string;
  full: string;
  /** 플러그인이 아이콘을 선언했을 때 화면이 시도할 URL. 제공 플러그인을 모르면 null. */
  iconUrl: string | null;
}
interface Harness {
  meta: (ch: string | null) => Meta | null;
  fromKey: (tk: string) => string | null;
  load: () => Promise<void>;
  rendered: () => number;
}

/** channel-hints.js 의 배지 판정부를 떼어 vm 에서 실제로 돌린다. */
const harness = (
  serverChannels: string[] | null,
  seed?: Record<string, string>,
): Harness => {
  const src = readFileSync(path.join(REPO, "packages/dashboard/js/channel-hints.js"), "utf8");
  const block =
    /const channelInfo = new Map\(\);[\s\S]*?const channelFromThreadKey = \(tk\) => \{[\s\S]*?\n {6}\};/.exec(
      src,
    );
  if (block === null) throw new Error("배지 판정부를 못 찾음");
  let renders = 0;
  const ctx: Record<string, unknown> = {
    // 화면 문구 함수 — 브라우저 전역이라 여기선 원문을 그대로 돌려준다(판정만 본다).
    i18n: i18nForContext,
    console: { warn: () => {} },
    // ★브라우저 전역 — 검사마다 **빈 저장소**로 시작한다(직전 검사의 씨앗이 새지 않게).
    //  «지난번에 본 채널» 을 재현하려면 아래 `seed` 로 명시적으로 넣는다.
    localStorage: ((): Record<string, unknown> => {
      const m = new Map<string, string>();
      for (const [k, v] of Object.entries(seed ?? {})) m.set(k, v);
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => {
          m.set(k, v);
        },
      };
    })(),
    renderTabBar: () => {
      renders += 1;
    },
    fetch: () =>
      serverChannels === null
        ? Promise.reject(new Error("네트워크 실패"))
        : Promise.resolve({
            ok: true,
            json: () =>
              // ★presence 는 이제 «채널이 선언한 것» 을 실어 온다(short·plugin). 검사도 실물
              //  모양으로 준다 — 이름만 주는 채널(선언 없음)이 섞이는 것도 그대로 재현한다.
              Promise.resolve({
                channels: serverChannels.map((n) =>
                  n === "telegram"
                    ? { name: n, plugin: "telegram-channel" }
                    : n === "cli"
                      ? { name: n, plugin: "cli-channel" }
                      : { name: n },
                ),
              }),
          }),
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${block[0]}
     this.__meta = channelMeta;
     this.__fromKey = channelFromThreadKey;
     this.__load = loadKnownChannels;`,
    ctx,
  );
  return {
    meta: ctx.__meta as Harness["meta"],
    fromKey: ctx.__fromKey as Harness["fromKey"],
    load: ctx.__load as Harness["load"],
    rendered: () => renders,
  };
};

export const check: RegressionCheck = {
  name: "channel-badge-real-only",
  guards:
    "키 접두를 채널로 착각해 없는 채널 배지(VERIFY 등)를 만들어 붙이던 것 — 툴팁까지 '~ 세션' 이라 단언했다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 사용자가 실제로 본 형상 — 서버 목록을 받은 뒤 `verify:` 는 배지가 없어야 한다.
    const h = harness(["telegram", "cli", "http-bridge"]);
    await h.load();
    const fake = h.meta(h.fromKey("verify:1784-abc"));
    out.push(
      assert(
        "★실재하지 않는 채널(키 접두)에는 배지가 없다",
        fake === null,
        fake === null ? "배지 없음" : `★${fake.short} 배지가 생겼다 — 없는 사실을 표시한다`,
      ),
    );
    // 접두 파싱 자체는 그대로 — 배지를 거는 판정만 바뀐 것임을 못 박는다(과잉 수정 0).
    out.push(
      assert(
        "접두 파싱은 그대로 동작한다(판정만 바뀜)",
        h.fromKey("verify:1784-abc") === "verify" && h.fromKey("tg:123") === "telegram",
        `${h.fromKey("verify:1784-abc")} · ${h.fromKey("tg:123")}`,
      ),
    );

    // ★② 진짜 채널은 계속 배지가 붙는다(기능 상실 0).
    const tg = h.meta("telegram");
    const cli = h.meta("cli");
    out.push(
      assert(
        "★진짜 채널은 그대로 배지가 붙는다(TG·CLI)",
        tg?.short === i18nForContext("common.channel.telegram") &&
          cli?.short === i18nForContext("common.channel.cli"),
        `${tg?.short} · ${cli?.short}`,
      ),
    );
    // 자기 채널은 배지 없음 — 대시보드에서 보고 있으니 자명(기존 규칙 유지).
    out.push(
      assert(
        "자기 채널(dashboard·http-bridge)은 배지 없음",
        h.meta("dashboard") === null && h.meta("http-bridge") === null,
        "자명 채널 제외 확인",
      ),
    );

    // ★③ 라벨 없는 **진짜** 새 채널은 저절로 배지가 생긴다 — 손목록이 아니라 실목록이므로.
    const h2 = harness(["telegram", "slack"]);
    await h2.load();
    const slack = h2.meta("slack");
    out.push(
      assert(
        "★새 채널이 붙으면 저절로 배지 대상이 된다(하드코딩 목록 아님)",
        slack?.short === i18nForContext("common.channel.slack"),
        slack === null ? "★새 채널이 배지를 못 받는다" : slack.short,
      ),
    );

    // ★④ 목록을 못 받았을 때(실패·빈 응답) **가짜 배지가 생기지 않는다.** 여기가 열리면
    //  네트워크가 나쁜 순간마다 옛 동작으로 되돌아간다.
    // ★«알려진 채널» 의 뜻이 바뀌었다 (2026-09-08): 종전엔 **대시보드가 하드코딩한 둘**이
    //  씨앗이었는데, 이제 **지난번에 서버에서 실제로 본 것**이 씨앗이다(localStorage).
    //  지키려는 성질은 그대로다 — «네트워크가 나빠도 진짜 채널 배지는 살고, 가짜는 안 생긴다».
    //  ★그래서 여기서 씨앗을 명시적으로 준다. 안 주면 «한 번도 본 적 없는 브라우저» 이고,
    //   그때 배지가 없는 건 결함이 아니라 **올바른 보수적 동작**이다(아래 ④-b 가 그걸 본다).
    const lastSeen = {
      "tigu.channels.last": JSON.stringify(["telegram", "cli"]),
      "tigu.channels.last.info": JSON.stringify({
        telegram: { plugin: "telegram-channel" },
        cli: { plugin: "cli-channel" },
      }),
    };
    const hFail = harness(null, lastSeen);
    await hFail.load();
    out.push(
      assert(
        "★목록 로드 실패해도 가짜 배지 0(알려진 채널만)",
        hFail.meta("verify") === null &&
          hFail.meta("telegram")?.short === i18nForContext("common.channel.telegram"),
        "실패 시 보수적 동작 확인",
      ),
    );
    const hEmpty = harness([], lastSeen);
    await hEmpty.load();
    out.push(
      assert(
        "빈 응답으로 알려진 채널을 잃지 않는다(빈 응답 ≠ 채널 없음)",
        hEmpty.meta("telegram")?.short === i18nForContext("common.channel.telegram") &&
          hEmpty.meta("verify") === null,
        "빈 응답 방어 확인",
      ),
    );

    // ★④-b **처음 여는 브라우저**는 배지가 없다 — 아직 아무 채널도 «본» 적이 없기 때문이다.
    //  종전 하드코딩은 이걸 «telegram 은 늘 진짜» 로 가정했다. 그 가정이 곧 대시보드가
    //  채널을 아는 것이었고, 이 변경이 없앤 것이다. 없는 걸 지어내지 않는 쪽이 맞다.
    const hCold = harness(null);
    await hCold.load();
    out.push(
      assert(
        "★한 번도 채널을 못 본 브라우저는 배지를 지어내지 않는다(하드코딩 씨앗 제거의 값)",
        hCold.meta("telegram") === null && hCold.meta("verify") === null,
        `telegram=${JSON.stringify(hCold.meta("telegram"))} verify=${JSON.stringify(hCold.meta("verify"))}`,
      ),
    );

    // ★④-c **대시보드는 어떤 채널도 특별대우하지 않는다** (2026-09-08) ─────────────
    //  종전엔 `{ telegram: "TG", cli: "CLI" }` 가 이 파일에 박혀 있었다 — 한 플러그인이
    //  다른 플러그인의 이름을 아는 것이고, 새 채널이 붙으면 여기를 고쳐야 했다.
    //  ★이름 목록으로 «없는지» 를 세지 않는다(그건 또 다른 손 목록이다). 대신 **행동**으로
    //   본다: 서버가 똑같이 알려준 두 채널은 **똑같은 모양**으로 나와야 한다. 하나라도
    //   특별분기가 있으면 그 채널만 달라진다.
    const hFair = harness(["telegram", "zzz-made-up"]);
    await hFair.load();
    const mKnown = hFair.meta("telegram");
    const mNew = hFair.meta("zzz-made-up");
    const sameShape =
      mKnown !== null &&
      mNew !== null &&
      Object.keys(mKnown).sort().join(",") === Object.keys(mNew).sort().join(",") &&
      // 표시 이름은 **카탈로그가 있으면** 다르다(그건 언어지 특별대우가 아니다).
      // 특별대우의 증거는 «카탈로그에도 없는데 다르게 나오는 것» 이다.
      mNew.short === "zzz-made-up";
    out.push(
      assert(
        "★★대시보드가 특정 채널을 특별대우하지 않는다 — 서버가 같은 모양으로 준 둘은 같은 모양으로 나온다",
        sameShape,
        `telegram=${JSON.stringify(mKnown)} · 새 채널=${JSON.stringify(mNew)}`,
      ),
    );

    // ★④-d **아이콘 자리가 살아 있다** (2026-09-08) ──────────────────────────────
    //  변이로 확인: `iconUrl` 을 `null` 로 고정해도 스위트가 초록이었다 — 방금 판 자리를
    //  지키는 게 없었다. 자리는 «있다» 가 아니라 «도는가» 로 재야 한다.
    //  ★아이콘 파일은 **아무것도 안 싣는다**(서드파티 로고 재배포는 소유자 판단). 그래서
    //   여기서 보는 건 파일이 아니라 **URL 이 만들어지는가** 다 — 404 면 화면이 이름으로
    //   떨어지는 건 `view-plugins` 의 아이콘 관용구와 동형이다.
    const hIcon = harness(["telegram"]);
    await hIcon.load();
    const mi = hIcon.meta("telegram");
    const iconOk =
      typeof mi?.iconUrl === "string" && mi.iconUrl.includes("telegram-channel");
    out.push(
      assert(
        "★채널이 제공 플러그인을 알려주면 아이콘 URL 이 만들어진다(자리가 도는가)",
        iconOk,
        `iconUrl=${JSON.stringify(mi?.iconUrl)}`,
      ),
    );
    // 제공 플러그인을 모르면 URL 도 없다 — 지어내지 않는다(«-channel 붙이기» 금지).
    const hNoPlugin = harness(["zzz-made-up"]);
    await hNoPlugin.load();
    out.push(
      assert(
        "제공 플러그인을 모르면 아이콘 URL 을 지어내지 않는다",
        hNoPlugin.meta("zzz-made-up")?.iconUrl === null,
        `iconUrl=${JSON.stringify(hNoPlugin.meta("zzz-made-up")?.iconUrl)}`,
      ),
    );

    // ★⑤ 목록이 달라지면 이미 그린 배지를 다시 판정한다 — 안 하면 늦게 온 진짜 채널이
    //  다음 렌더까지 배지 없이 남는다.
    out.push(
      assert(
        "목록이 바뀌면 탭바를 다시 그린다(늦게 온 채널 반영)",
        h2.rendered() === 1 && hEmpty.rendered() === 0,
        `변경 시 ${h2.rendered()}회 · 무변경 시 ${hEmpty.rendered()}회`,
      ),
    );
    return out;
  },
};
