/**
 * **«내 ID 찾기»** — 봇에게 말을 건 사람을 소유자 후보로 보여준다 (2026-10-16, 정태님 «텔레그램 채널 플러그인에서 쉽게 연결»).
 *
 * ★종전엔 소유자 ID 를 사용자가 직접 알아내야 했다(비서는 외부 봇 @userinfobot 을 권했다). 설치 마법사는 «봇에게 한 번 말 걸면
 *  인식» 을 이미 했는데, 설치 뒤엔 그 길이 없었다. 이 플러그인의 설정 화면 «찾기» 가 이 데이터 라우트를 부른다(`settings[].suggest`).
 * ★**자동으로 소유자로 받지 않는다** — 후보를 보여줄 뿐이고 사용자가 고른다. 봇 이름이 알려지면 남이 먼저 말을 걸 수 있다.
 *
 * 폴링 중일 때만 — 소유자 게이트가 막은 사람을 기억해 둔 것(아래 `recordBlockedSender`). `getUpdates` 는 부르지 않는다(아래 라우트 주석).
 *
 * grammy 를 import 하지 않는다 — 회귀가 판정을 직접 돌린다.
 */
import type { PluginDataRoutes } from "../../src/core/plugins/data-routes.js";

interface Sender {
  readonly id: string;
  readonly name: string;
  readonly username?: string;
  readonly at: number;
}

type TelegramFrom = { id?: unknown; is_bot?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown } | undefined;

const SENDER_CAP = 10;
const blocked = new Map<string, Sender>();

const toSender = (from: TelegramFrom, at: number): Sender | undefined => {
  if (from === undefined || from.is_bot === true) return undefined;
  if (typeof from.id !== "number" && typeof from.id !== "string") return undefined;
  const name = [from.first_name, from.last_name].filter((x) => typeof x === "string" && x !== "").join(" ");
  return { id: String(from.id), name: name || String(from.id), ...(typeof from.username === "string" && from.username !== "" ? { username: from.username } : {}), at };
};

/** 소유자 게이트가 막은 보낸 사람을 기억한다(최근 10명). 미들웨어가 부른다. */
export const recordBlockedSender = (from: TelegramFrom, now: number = Date.now()): void => {
  const s = toSender(from, now);
  if (s === undefined) return;
  blocked.delete(s.id);
  blocked.set(s.id, s);
  while (blocked.size > SENDER_CAP) blocked.delete(blocked.keys().next().value as string);
};

/** `getUpdates` 모양의 응답에서 보낸 사람(봇 제외, 최근 순, 중복 없음) — 판정 재료로만 남긴다(라우트는 getUpdates 를 부르지 않는다). */
export const sendersFromUpdates = (json: unknown): Sender[] => {
  const result = (json as { result?: unknown })?.result;
  if (!Array.isArray(result)) return [];
  const byId = new Map<string, Sender>();
  for (const u of result as Array<Record<string, { from?: TelegramFrom; date?: unknown } | undefined>>) {
    const m = u.message ?? u.edited_message ?? u.callback_query;
    const at = typeof m?.date === "number" ? m.date * 1000 : 0;
    const s = toSender(m?.from, at);
    if (s !== undefined) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
};

/** 화면에 내는 모양 — `settings[].suggest` 의 계약(`{ items: [{ value, label }], note? }`). */
export const toItems = (senders: readonly Sender[]): Array<{ value: string; label: string }> =>
  senders.map((s) => ({ value: s.id, label: `${s.name}${s.username !== undefined ? ` (@${s.username})` : ""} · ${s.id}` }));

/**
 * 데이터 라우트 — `polling` 은 이 인스턴스가 지금 폴링 중인가.
 * ★`getUpdates` 를 부르지 않는다 (2026-10-16 적대 검토 P2) — 같은 토큰으로 다른 인스턴스(다른 기기·같은 기계의 다른 홈)가 폴링 중이면
 *  먼저 걸려 있던 쪽이 409 로 끊겨 재시작 전까지 메시지를 못 받는다. 대신 이 인스턴스가 폴링하면서 **소유자 게이트가 막은 사람**을
 *  기억해 둔 것만 보여준다. 소유자 목록은 메시지마다 다시 읽히므로, 토큰 저장 → 재시작 한 번 → 봇에게 말 걸기 → 찾아서 고르기로 끝난다.
 * ★토큰은 응답에 싣지 않는다. 빈 목록과 «아직 볼 수 없다» 는 다르다 — `note` 로 말한다.
 */
export const ownerCandidateRoutes = (polling: () => boolean): PluginDataRoutes => ({
  "owner-candidates": {
    ttlMs: 0,
    handler: async (_query, host) => {
      if (!polling()) {
        const token = host.settings.botToken;
        return { items: [], note: typeof token === "string" && token.trim() !== "" ? "restart-first" : "token-missing" };
      }
      const items = toItems([...blocked.values()].sort((a, b) => b.at - a.at));
      return { items, note: items.length === 0 ? "no-messages-yet" : undefined };
    },
  },
});
