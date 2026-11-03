/**
 * **연달아 온 메시지를 한 턴으로** (2026-11-03).
 *
 * ★사고: 글(«아스트라 회신»)과 파일(16KB 문서)이 **2.3초** 간격으로 따로 왔다. 글만으로 턴이 시작됐고 그 턴은 도구를 한 번도
 *  안 불러 끝났다 — 끼어든 메시지는 도구 경계에서만 전달되므로, 파일이 이미 와 있었는데도 못 보고 «첨부 못 받았다» 고 틀리게 답했다.
 *  텔레그램은 글+파일, 사진 여러 장을 **각각 다른 update** 로 보낸다(앱이 한 번에 보낸 것처럼 보여도).
 *
 * 그래서 같은 대화의 사용자 메시지는 조용한 창(`quietMs`) 동안 모은다 — 더 오면 창을 다시 연다(슬라이딩), 첫 메시지에서
 *  `maxMs` 가 지나면 바로 보낸다. 명령(슬래시)·버튼 답은 기다리지 않되, **쌓인 묶음을 먼저** 보낸다(순서 보존).
 *
 * ★순서는 대화별 줄 하나가 지킨다 — 묶음·즉시 메시지 모두 그 줄을 타서, 첨부 다운로드가 늦어도 앞 메시지가 뒤에 오지 않는다.
 */
import type { IncomingMessage } from "../../src/channels/types.js";

/** 기본값은 여기 한 곳 — 2026-11-03 정태님 확정(«2.5초로 해»). 실측 간격 2.3초를 덮는 값이다(1초면 그 사고를 못 막는다). */
export const DEFAULT_QUIET_MS = 2500;
export const DEFAULT_MAX_MS = 6000;

/** 설정(`.env` 의 `TELEGRAM_BATCH_QUIET_MS`·`TELEGRAM_BATCH_MAX_MS`)을 메시지마다 읽는다 — 화면에서 바꾸면 바로 먹는다. 0 = 끔. */
export const readBatchWindow = (): { quietMs: number; maxMs: number } => {
  const num = (raw: string | undefined, dflt: number): number => {
    if (raw === undefined || raw.trim() === "") return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    quietMs: num(process.env.TELEGRAM_BATCH_QUIET_MS, DEFAULT_QUIET_MS),
    maxMs: num(process.env.TELEGRAM_BATCH_MAX_MS, DEFAULT_MAX_MS),
  };
};

/** 메시지 하나 — 첨부는 다운로드가 끝나야 내용이 정해지므로 약속으로 받는다(null = 보낼 것 없음). */
export interface BatchPart {
  msg: Promise<IncomingMessage | null>;
  /** 이 메시지가 답글로 단 텔레그램 message_id — 묶음 안에서 대상이 갈리면 나눈다. */
  replyTo: number | undefined;
  /** 이 메시지가 켠 «입력 중…» 표시를 끈다. */
  stopTyping: () => void;
}

/**
 * 묶음을 한 메시지로. 바탕(세션·답 경로·선택지·답글 표시)은 **첫 메시지**의 것이다 — 같은 대화·같은 세션 묶음이라 갈리는 건 원문 id 뿐이다.
 * 글은 순서대로 줄바꿈으로 잇고, 첨부는 전부, 원문 id 도 전부 싣는다(어느 메시지에 단 답글이든 대화 기록 행을 짚게).
 */
export const mergeMessages = (msgs: readonly IncomingMessage[]): IncomingMessage => {
  const first = msgs[0]!;
  if (msgs.length === 1) return first;
  const quoted = msgs.find((m) => m.replyToText !== undefined || m.replyToRef !== undefined);
  const attachments = msgs.flatMap((m) => m.attachments ?? []);
  const ids = msgs.flatMap((m) => m.channelMessageRef?.messageIds ?? []);
  const { replyToText: _t, replyToRef: _r, attachments: _a, ...base } = first;
  return {
    ...base,
    text: msgs.map((m) => m.text).filter((t) => t !== "").join("\n"),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(quoted?.replyToText !== undefined ? { replyToText: quoted.replyToText } : {}),
    ...(quoted?.replyToRef !== undefined ? { replyToRef: quoted.replyToRef } : {}),
    ...(first.channelMessageRef !== undefined ? { channelMessageRef: { ...first.channelMessageRef, messageIds: ids } } : {}),
  };
};

interface Pending {
  chatId: string;
  parts: BatchPart[];
  firstAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export const createInboundBatcher = (fire: (msg: IncomingMessage) => Promise<void>) => {
  const pending = new Map<string, Pending>();
  const chatTail = new Map<string, Promise<void>>();
  /** 발사한 핸들러 중 아직 안 끝난 것 — 종료 때 답이 나갈 틈을 주는 데만 쓴다. */
  const fired = new Set<Promise<void>>();
  /**
   * 종료가 시작됐나 — 그 뒤에 온 메시지는 모으지 않고 바로 넘긴다(창 0 과 같은 길). ★`flushAll` 이 기다리는 동안에도 폴러는 돈다 —
   *  그때 온 글을 새 묶음에 담으면 타이머가 울리기 전에 프로세스가 끝나고, `bot.stop()` 이 오프셋을 확정해 텔레그램도 다시 안 보낸다(조용한 유실).
   */
  let closing = false;

  /** 대화 줄에 묶음 하나를 세운다 — 앞 묶음의 다운로드·발사가 끝난 뒤에 이것을 낸다. */
  const dispatch = (chatId: string, parts: BatchPart[]): void => {
    const tail = (chatTail.get(chatId) ?? Promise.resolve())
      .then(async () => {
        const msgs = (await Promise.all(parts.map((p) => p.msg.catch(() => null)))).filter(
          (m): m is IncomingMessage => m !== null,
        );
        if (msgs.length === 0) {
          for (const p of parts) p.stopTyping();
          return;
        }
        if (msgs.length > 1) console.log(`telegram: 연달아 온 메시지 ${msgs.length}건을 한 턴으로 묶음`);
        // 발사만 하고 기다리지 않는다(폴러·다음 묶음을 막지 않게) — «입력 중» 은 턴이 끝날 때 끈다.
        const run = fire(mergeMessages(msgs))
          .catch(() => {})
          .finally(() => {
            for (const p of parts) p.stopTyping();
            fired.delete(run);
          });
        fired.add(run);
      })
      .catch(() => {})
      .finally(() => {
        if (chatTail.get(chatId) === tail) chatTail.delete(chatId);
      });
    chatTail.set(chatId, tail);
  };

  const flushKey = (key: string): void => {
    const p = pending.get(key);
    if (p === undefined) return;
    pending.delete(key);
    clearTimeout(p.timer);
    dispatch(p.chatId, p.parts);
  };

  /** 이 대화에 쌓인 묶음을 전부 지금 보낸다. */
  const flushChat = (chatId: string): void => {
    for (const [key, p] of [...pending]) if (p.chatId === chatId) flushKey(key);
  };

  return {
    /** 사용자 메시지 — 창이 켜져 있으면 모은다. `key` = 대화 + 세션(답글로 다른 세션에 간 메시지는 따로 묶인다). */
    add(chatId: string, key: string, part: BatchPart): void {
      const { quietMs, maxMs } = readBatchWindow();
      if (closing || quietMs <= 0) {
        flushChat(chatId); // 창을 막 끈 경우의 잔여분 — 순서대로.
        dispatch(chatId, [part]);
        return;
      }
      let p = pending.get(key);
      // 서로 다른 메시지에 단 답글은 한 턴에 섞지 않는다 — 인용이 하나만 실리므로 하나를 잃는다.
      if (p !== undefined && part.replyTo !== undefined) {
        const prev = p.parts.find((x) => x.replyTo !== undefined)?.replyTo;
        if (prev !== undefined && prev !== part.replyTo) {
          flushKey(key);
          p = undefined;
        }
      }
      const now = Date.now();
      if (p === undefined) {
        p = { chatId, parts: [], firstAt: now, timer: undefined };
        pending.set(key, p);
      } else {
        part.stopTyping(); // «입력 중» 은 첫 메시지 것 하나로 족하다.
      }
      p.parts.push(part);
      clearTimeout(p.timer);
      const wait = Math.min(quietMs, p.firstAt + maxMs - now);
      if (wait <= 0) {
        flushKey(key);
        return;
      }
      p.timer = setTimeout(() => flushKey(key), wait);
    },
    /** 명령·버튼 답 — 기다리지 않는다. 이 대화에 쌓인 묶음을 먼저 보내 순서를 지킨다. */
    now(chatId: string, part: BatchPart): void {
      flushChat(chatId);
      dispatch(chatId, [part]);
    },
    /**
     * 종료 — 쌓인 것을 버리지 않고 핸들러에 넘긴다(종료 중이면 코어가 «다시 보내 달라» 고 답한다 — `refuseWhileClosing`).
     * 그 답이 나갈 틈을 `waitMs` 까지 준다. 이 뒤로 오는 메시지는 모으지 않는다(`closing`).
     */
    async flushAll(waitMs: number): Promise<void> {
      closing = true;
      for (const key of [...pending.keys()]) flushKey(key);
      if (chatTail.size === 0 && fired.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...chatTail.values()]).then(() => Promise.allSettled([...fired])),
        new Promise<void>((r) => {
          timer = setTimeout(r, waitMs);
        }),
      ]);
      clearTimeout(timer);
    },
  };
};
