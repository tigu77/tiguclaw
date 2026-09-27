/**
 * **합성 턴도 그 스레드의 사용자 턴과 같은 도구 목록을 받는다** — 파일 전송·선택지 자리의 모양을 맞춘다 (2026-09-27).
 *
 * ★사고(윈도우 돌쇠 로그): 세 어댑터 모두 `send_file`·`prompt_options` 를 **콜백이 있을 때만** 등록한다. 매니저 완료·점검
 *  재주입 턴은 `reply` 만 다시 만들어, 같은 세션에서 사용자 턴(67개)과 재주입 턴(65·66개)이 번갈아 오면 도구 목록이
 *  흔들렸다. 도구 정의는 이력보다 앞이라 그때마다 **이력 전체가 캐시를 못 탔다**(턴당 2만~6.7만 토큰).
 * ★첫 수정은 재주입 턴에 두 자리를 **항상** 채웠다 — 아스트라 검토: CLI 사용자 턴엔 선택지만 있고 파일 전송은 없어,
 *  CLI 에선 재주입 턴에만 `send_file` 이 생긴다(불일치가 반대로 남고 미지원 도구를 더 노출). 그래서 기준을 바꾼다:
 *  **이 스레드의 사용자 턴이 실제로 받은 모양**을 기록하고, 합성 턴은 **빠진 자리만** 그 모양대로 «이 턴에선 불가» 로
 *  채운다. 채널 이름을 모른다(판단은 실제 인입에서 파생). 진짜 콜백(egress 선택지 등)은 덮지 않는다.
 *
 * 한계: 재시작 직후 사용자 턴이 오기 전의 합성 턴은 모양을 몰라 **그대로** 둔다(종전 동작). 모양이 사용자 턴마다
 *  바뀌는 세션(CLI ↔ 대시보드를 오가는 세션)은 사용자 턴끼리도 원래 갈린다 — 가장 최근 사용자 턴을 따른다.
 */
import type { IncomingMessage } from "../channels/types.js";

type TurnActions = Pick<IncomingMessage, "sendAttachment" | "presentOptions">;
interface Shape { send: boolean; options: boolean }

/** 스레드 수만큼 자란다 — 오래 안 쓴 것부터 버린다(핫 경로 바운드, 기록이 아니라 캐시 정렬 힌트다). */
const SHAPE_CAP = 1_000;
const shapes = new Map<string, Shape>();

export const REINJECTED_TURN_UNAVAILABLE = "자동 보고 턴이라 채널로 직접 보낼 통로가 없습니다";
const unavailableSend: NonNullable<IncomingMessage["sendAttachment"]> = async () =>
  ({ ok: false, error: REINJECTED_TURN_UNAVAILABLE, unavailable: true });
const unavailableOptions: NonNullable<IncomingMessage["presentOptions"]> = async () =>
  ({ ok: false, error: REINJECTED_TURN_UNAVAILABLE, unavailable: true });

/**
 * 이 턴이 어댑터로 넘길 파일 전송·선택지 자리. 사용자 턴이면 모양을 기록하고 그대로, 합성 턴이면 빠진 자리를
 * 기록된 모양대로 채운다. `threadKey` = 라우터가 정규화한 세션 id(사용자 턴과 재주입 턴이 같은 키를 쓴다).
 */
export const turnActionsFor = (
  threadKey: string,
  turn: { synthetic: boolean } & TurnActions,
): TurnActions => {
  const out: TurnActions = {
    ...(turn.sendAttachment !== undefined ? { sendAttachment: turn.sendAttachment } : {}),
    ...(turn.presentOptions !== undefined ? { presentOptions: turn.presentOptions } : {}),
  };
  if (!turn.synthetic) {
    shapes.delete(threadKey);
    shapes.set(threadKey, { send: turn.sendAttachment !== undefined, options: turn.presentOptions !== undefined });
    if (shapes.size > SHAPE_CAP) shapes.delete(shapes.keys().next().value as string);
    return out;
  }
  const s = shapes.get(threadKey);
  if (s === undefined) return out;
  return {
    ...out,
    ...(out.sendAttachment === undefined && s.send ? { sendAttachment: unavailableSend } : {}),
    ...(out.presentOptions === undefined && s.options ? { presentOptions: unavailableOptions } : {}),
  };
};

export const __resetTurnActionShapesForTest = (): void => shapes.clear();
