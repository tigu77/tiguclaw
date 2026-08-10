/**
 * 회귀: egress 좌표는 **기본 좌표까지 풀린 뒤** 소비자에게 간다.
 *
 * 사고 (2026-08-10, 라이브): 대시보드에서 "텔레그램에도 보내기"를 켜고 보냈는데
 *  텔레그램에 "입력 중"이 안 떴다. **메시지는 정상 도착했다** — 그게 진단을 늦춘다.
 *
 *  뿌리: 좌표 체인이 세션 `last_channel_target` 에서 멈췄다. 대시보드 세션은
 *  `last_channel = "http-bridge"` 라 `lastChannel === "telegram"` 가드에 걸려 `null` 이
 *  됐고, 배달은 `deliverOutbound` 가 내부에서 `defaultOutboundTarget()` 으로 **한 번 더**
 *  풀어서 성공했지만, 좌표가 필요한 다른 소비자(활동 표시)는 `null` 을 받아 조용히
 *  아무것도 안 했다. **좌표를 아는 곳이 둘이면 하나는 뒤처진다.**
 *
 * ★이 검사가 있어야 하는 진짜 이유: 이 판정이 `index.ts` 안에 있어서 동작 검사가
 *  불가능했고(그 파일은 import 만으로 데몬이 뜬다), 그래서 refcount 모듈만 검사한 채
 *  배포했다. 검사 못 하는 자리에 있던 것이 정확히 깨졌다 — 모듈로 뽑은 뒤 이 검사가 생겼다.
 */
import { resolveEgressTargets } from "../../core/egress-targets.js";
import type { ChannelOutbound } from "../../core/channel-outbound.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

const telegramLike = (): ChannelOutbound => ({
  deliver: async () => {},
  defaultOutboundTarget: () => "owner-chat-1",
  signalActivity: async () => {},
});

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const deps = (
    meta: { lastChannel: string; lastChannelTarget: string | null } | null,
    outbound: ChannelOutbound | undefined = telegramLike(),
  ) => ({
    getOutbound: (n: string) => (n === "telegram" ? outbound : undefined),
    getSessionMeta: () => meta,
  });
  const msg = {
    channel: "http-bridge",
    threadKey: "dashboard:abc",
    egressChannels: ["telegram"],
  };

  // ── ① 사고 그대로 — 세션의 last_channel 이 다른 채널이면 기본 좌표로 폴백 ──────
  {
    const r = await resolveEgressTargets(
      msg,
      deps({ lastChannel: "http-bridge", lastChannelTarget: "dashboard:abc" }),
    );
    out.push({
      name: "★타 채널 세션이어도 기본 좌표까지 풀린다(사고 재현 지점)",
      ok: r.length === 1 && r[0]?.target === "owner-chat-1",
      got: `target=${String(r[0]?.target)} (기대 owner-chat-1 — 폴백 없으면 null)`,
    });
  }

  // ── ② 같은 채널 세션이면 그 좌표를 쓴다(타 채널 좌표 오용 방지 가드 유지) ──────
  {
    const r = await resolveEgressTargets(
      msg,
      deps({ lastChannel: "telegram", lastChannelTarget: "chat-77" }),
    );
    out.push({
      name: "같은 채널 세션이면 세션 좌표 우선",
      ok: r[0]?.target === "chat-77",
      got: `target=${String(r[0]?.target)} (기대 chat-77)`,
    });
  }

  // ── ③ 기본 좌표가 async 여도 풀린다(계약이 sync|async 둘 다 허용) ─────────────
  {
    const asyncOut: ChannelOutbound = {
      deliver: async () => {},
      defaultOutboundTarget: async () => "async-chat",
    };
    const r = await resolveEgressTargets(msg, deps(null, asyncOut));
    out.push({
      name: "defaultOutboundTarget 이 async 여도 해석된다",
      ok: r[0]?.target === "async-chat",
      got: `target=${String(r[0]?.target)} (기대 async-chat)`,
    });
  }

  // ── ④ 인입 채널 자신은 제외 · outbound 불가 채널은 제외 ──────────────────────
  {
    const self = await resolveEgressTargets(
      { ...msg, egressChannels: ["http-bridge"] },
      deps(null),
    );
    const observerOnly = await resolveEgressTargets(msg, deps(null, {
      deliver: async () => {},
    }));
    out.push({
      name: "인입 채널 자신은 egress 대상이 아니다",
      ok: self.length === 0,
      got: `대상=${self.length}개 (기대 0)`,
    });
    out.push({
      name: "defaultOutboundTarget 없는 채널(관측 전용)은 제외",
      ok: observerOnly.length === 0,
      got: `대상=${observerOnly.length}개 (기대 0)`,
    });
  }

  // ── ⑤ 좌표 해석 실패는 null 로 내려온다(표시는 건너뛰고 배달만 재시도) ────────
  {
    const throwing: ChannelOutbound = {
      deliver: async () => {},
      defaultOutboundTarget: () => {
        throw new Error("좌표 없음");
      },
    };
    const r = await resolveEgressTargets(msg, deps(null, throwing));
    out.push({
      name: "기본 좌표 해석이 던져도 턴을 죽이지 않고 null 로 내려온다",
      ok: r.length === 1 && r[0]?.target === null,
      got: `대상=${r.length}개 target=${String(r[0]?.target)} (기대 1 / null)`,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "egress-target-resolution",
  guards:
    "egress 좌표가 세션 메타에서 멈춰 기본 좌표까지 안 풀리던 것 — 배달은 deliverOutbound 내부 폴백으로 성공하는데 활동 표시는 좌표를 못 받아 조용히 안 뜨던 것",
  run,
};
