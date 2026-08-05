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
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Meta {
  short: string;
  full: string;
}
interface Harness {
  meta: (ch: string | null) => Meta | null;
  fromKey: (tk: string) => string | null;
  load: () => Promise<void>;
  rendered: () => number;
}

/** channel-hints.js 의 배지 판정부를 떼어 vm 에서 실제로 돌린다. */
const harness = (serverChannels: string[] | null): Harness => {
  const src = readFileSync(path.join(REPO, "packages/dashboard/js/channel-hints.js"), "utf8");
  const block =
    /const CHANNEL_LABELS = [\s\S]*?const channelFromThreadKey = \(tk\) => \{[\s\S]*?\n {6}\};/.exec(
      src,
    );
  if (block === null) throw new Error("배지 판정부를 못 찾음");
  let renders = 0;
  const ctx: Record<string, unknown> = {
    console: { warn: () => {} },
    renderTabBar: () => {
      renders += 1;
    },
    fetch: () =>
      serverChannels === null
        ? Promise.reject(new Error("네트워크 실패"))
        : Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ channels: serverChannels.map((n) => ({ name: n })) }),
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
        tg?.short === "TG" && cli?.short === "CLI",
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
        slack?.short === "SLACK",
        slack === null ? "★새 채널이 배지를 못 받는다" : slack.short,
      ),
    );

    // ★④ 목록을 못 받았을 때(실패·빈 응답) **가짜 배지가 생기지 않는다.** 여기가 열리면
    //  네트워크가 나쁜 순간마다 옛 동작으로 되돌아간다.
    const hFail = harness(null);
    await hFail.load();
    out.push(
      assert(
        "★목록 로드 실패해도 가짜 배지 0(알려진 채널만)",
        hFail.meta("verify") === null && hFail.meta("telegram")?.short === "TG",
        "실패 시 보수적 동작 확인",
      ),
    );
    const hEmpty = harness([]);
    await hEmpty.load();
    out.push(
      assert(
        "빈 응답으로 알려진 채널을 잃지 않는다(빈 응답 ≠ 채널 없음)",
        hEmpty.meta("telegram")?.short === "TG" && hEmpty.meta("verify") === null,
        "빈 응답 방어 확인",
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
