/**
 * **가짜 텔레그램 하네스** — 실제 `TelegramChannel` 을 띄우되 Bot API 호출은 전부 grammy 의 api 변환기
 * (`bot.api.config.use`)에서 가로챈다. 네트워크는 한 번도 안 나간다(변환기가 `prev` 를 부르지 않는다).
 *
 * ★왜 진짜 채널인가: 소유자 게이트·선택지 만료·폴링 사망 감지는 전부 **배선**에 산다(미들웨어 순서,
 *  모듈 상태, `bot.start` 의 거절). 부품만 부르면 배선을 지워도 초록이다. 그래서 진짜 update 를
 *  `bot.handleUpdate` 로 흘리고, 나가는 호출을 기록해 잰다.
 * ★모듈을 **두 번** 로드할 수 있다(`?boot=a`) — 재시작 전후 두 프로세스를 흉내 낸다(모듈 상태가 따로 산다).
 */
import { loadPluginModule } from "./_framework.js";

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}
type ApiResponse = { ok: true; result: unknown } | { ok: false; error_code: number; description: string; parameters?: Record<string, unknown> };
type Responder = (method: string, payload: Record<string, unknown>) => ApiResponse | undefined | Promise<ApiResponse | undefined>;

interface IncomingLike {
  text: string;
  channelUserId: string;
}
type Handler = (msg: IncomingLike) => Promise<void>;

interface ChannelLike {
  status: string;
  start: (h: Handler) => Promise<void>;
  stop: () => Promise<void>;
  outbound?: {
    presentOptionsTo?: (t: string | null, q: string, o: { label: string; value: string }[]) => Promise<{ ok: boolean; error?: string }>;
  };
}
interface BotLike {
  api: { config: { use: (t: (prev: unknown, method: string, payload: Record<string, unknown>) => Promise<ApiResponse>) => void } };
  handleUpdate: (u: unknown) => Promise<void>;
}

export interface TelegramModule {
  default: new () => ChannelLike;
  isAllowedSender: (fromId: number | string | undefined, allowed: ReadonlySet<string>) => boolean;
  replyAndRecord: (
    send: (chunk: string, extra: Record<string, unknown>) => Promise<unknown>,
    sessionId: string,
    chatId: string,
    out: string,
  ) => Promise<void>;
}

/** `tag` 가 다르면 **다른 모듈 인스턴스**다(재시작 전후 두 프로세스). */
export const loadTelegram = (tag = ""): Promise<TelegramModule> =>
  loadPluginModule<TelegramModule>(`../../../plugins/telegram-channel/index.ts${tag === "" ? "" : `?boot=${tag}`}`);

const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: "regr",
  username: "regr_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

/**
 * 채널 하나 — 토큰은 생성자 동안만 env 에 둔다(러너가 비워 둔 값을 되돌린다).
 * `respond` 가 undefined 를 주면 기본 응답(getMe·getUpdates 대기·나머지 ok).
 */
export const fakeChannel = (
  mod: TelegramModule,
  respond: Responder = () => undefined,
): { channel: ChannelLike; bot: BotLike; calls: ApiCall[] } => {
  const saved = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "123456:regression-fake";
  const channel = new mod.default();
  if (saved === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = saved;
  const bot = (channel as unknown as { bot: BotLike }).bot;
  const calls: ApiCall[] = [];
  let msgId = 1000;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload ?? {} });
    const custom = await respond(method, payload ?? {});
    if (custom !== undefined) return custom;
    if (method === "getMe") return { ok: true, result: BOT_INFO };
    if (method === "getUpdates") {
      await new Promise((r) => setTimeout(r, 30)); // 롱폴링 흉내 — 바쁜 루프 방지
      return { ok: true, result: [] };
    }
    if (method === "sendMessage") return { ok: true, result: { message_id: msgId++, date: 0, chat: { id: 1, type: "private" } } };
    return { ok: true, result: true };
  });
  return { channel, bot, calls };
};

const user = (id: number) => ({ id, is_bot: false, first_name: `u${id}` });
const chat = (id: number) => ({ id, type: "private", first_name: `u${id}` });
let updateId = 1;

export const textUpdate = (fromId: number, text: string): unknown => ({
  update_id: updateId++,
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: chat(fromId), from: user(fromId), text },
});

/** 20MB 넘는 문서 — 게이트를 뚫어도 다운로드(네트워크) 없이 «너무 큼» 안내로 끝난다. */
export const bigDocumentUpdate = (fromId: number): unknown => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: chat(fromId),
    from: user(fromId),
    document: { file_id: "f", file_unique_id: "fu", file_name: "big.pdf", mime_type: "application/pdf", file_size: 30 * 1024 * 1024 },
  },
});

export const callbackUpdate = (fromId: number, data: string): unknown => ({
  update_id: updateId++,
  callback_query: {
    id: `cq${updateId}`,
    from: user(fromId),
    chat_instance: "ci",
    data,
    message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: chat(fromId), text: "q" },
  },
});

/** 시작한 채널이 들고 있는 env(소유자 목록)를 잠깐 바꿔 띄운다. */
export const startWithOwners = async (channel: ChannelLike, owners: string, handler: Handler): Promise<void> => {
  const saved = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_ALLOWED_USER_IDS = owners;
  try {
    await channel.start(handler);
  } finally {
    if (saved === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = saved;
  }
};

/** 비차단 발사(`void handler(msg)`)가 끝날 틈. */
export const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));
