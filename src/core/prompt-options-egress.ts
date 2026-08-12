/**
 * 턴 **중간의 질문(선택지)** 도 "이 답도 함께 보낼 채널"(egress)을 탄다.
 *
 * 사고 (2026-08-12, 사용자): 대시보드에서 시킨 작업 도중 비서가 선택지를 띄웠는데
 *  **텔레그램으로 안 왔다.** 답변 텍스트는 `fanOutEgress` 로 가는데, 선택지는 인입 채널이
 *  준 클로저 하나(`IncomingMessage.presentOptions`)뿐이라 대시보드에만 렌더됐다.
 *  자리를 비웠을 때 질문이 도착해야 할 이유가 가장 큰데, 정확히 그때 안 갔다 —
 *  2026-08-10 "워커 완료 알림이 안 왔다" 와 **같은 부류**(발화 종류마다 배달 규칙이 갈림).
 *
 * 한 줄: 답이 가는 곳이면 질문도 간다. 배달 규칙은 발화 종류가 아니라 턴이 정한다.
 *
 * ★별 모듈인 이유: `index.ts` 안에 두면 검사할 수 없다(그 파일은 import 만으로 데몬이 뜬다).
 *  좌표·배달을 주입받는 순수 조합 함수면 그대로 동작 검사가 된다 — egress-targets.ts 동형.
 *
 * ★채널 이름 하드코딩 0: 버튼을 그릴 수 있는 채널인지는 `presentOptionsTo` **존재**로만
 *  판정하고, 없으면 텍스트(번호 목록)로 폴백한다. 새 채널은 인터페이스만 구현하면 붙는다.
 */
import type { ChannelOutbound } from "./channel-outbound.js";
import type { IncomingMessage } from "../channels/types.js";

export interface PromptOptionsEgressTarget {
  channel: string;
  /** 해석된 배달 좌표(`egress-targets.ts` 가 턴 시작에 푼 값). null = 못 찾음. */
  target: string | null;
  outbound: ChannelOutbound;
}

export interface PromptOptionsEgressDeps {
  /** 선택지 UI 가 없는 채널용 텍스트 배달 — 답 fan-out 과 **같은 통로**를 주입받는다. */
  deliverText: (t: PromptOptionsEgressTarget, text: string) => Promise<void>;
  /**
   * 이 질문을 던진 세션 — 채널이 선택값을 돌려보낼 자리(`replyToSession`).
   * ★질문이 도착해도 답이 일하던 세션으로 못 돌아오면 반쪽이다. 인입 채널 렌더에는
   *  안 넘긴다(그 채널은 이미 그 세션에서 물었다 — 넘기면 같은 값을 두 겹으로 나른다).
   */
  originThreadKey: string;
}

/**
 * 선택지의 텍스트 판(版) — 버튼을 못 그리는 채널에 보낸다. 값이 아니라 **번호와 라벨**을
 * 보여주고 답장을 유도한다(사용자가 그 값을 그냥 타이핑해도 동치로 흐른다).
 */
export const formatPromptOptionsText = (
  question: string,
  options: { label: string; value: string }[],
  note?: string,
): string => {
  const lines = [question, ""];
  options.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`));
  if (note !== undefined && note.trim() !== "") lines.push("", note.trim());
  lines.push("", "원하는 보기의 번호나 내용을 답장으로 보내주세요.");
  return lines.join("\n");
};

const describe = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * 인입 채널 렌더 + egress fan-out 을 **하나의 `presentOptions`** 로 합친다.
 *
 * 반환 계약(호출자 = prompt_options MCP 도구):
 *  - `{ok:true}` = **한 곳 이상** 렌더 성공. 도구는 이걸로 per-turn dedup 을 기록한다 —
 *    즉 일부 채널이 실패해도 재호출로 성공한 채널에 **중복 렌더되진 않는다**(그 대신
 *    실패한 채널엔 그 턴에 안 간다. 그 비대칭은 로그로 남긴다 — 조용한 유실 금지).
 *  - `{ok:false}` = 전부 실패. 도구가 재시도하거나 텍스트로 제시한다(현행 graceful 경로).
 *
 * ★`targets` 가 비면 인입 클로저를 **그대로** 돌려준다(래핑 0 = 회귀 0).
 * ★인입이 `undefined` 여도 targets 가 있으면 클로저를 만든다 — 그래야 스케줄·워커 완료처럼
 *  **채널 없이 서버가 만든 턴**도 사용자에게 물어볼 수 있다(어댑터는 이 값의 유무로
 *  prompt_options 도구 등록을 정한다).
 */
export const withEgressPromptOptions = (
  inbound: IncomingMessage["presentOptions"],
  targets: PromptOptionsEgressTarget[],
  deps: PromptOptionsEgressDeps,
): IncomingMessage["presentOptions"] => {
  if (targets.length === 0) return inbound;
  return async (question, options, opts) => {
    const errors: string[] = [];
    let rendered = 0;
    if (inbound !== undefined) {
      try {
        const r = await inbound(question, options, opts);
        if (r.ok) rendered++;
        else errors.push(`인입: ${r.error}`);
      } catch (e) {
        errors.push(`인입: ${describe(e)}`);
      }
    }
    for (const t of targets) {
      try {
        if (t.outbound.presentOptionsTo !== undefined) {
          const r = await t.outbound.presentOptionsTo(t.target, question, options, {
            ...(opts?.note !== undefined ? { note: opts.note } : {}),
            replyToSession: deps.originThreadKey,
          });
          if (r.ok) rendered++;
          else errors.push(`${t.channel}: ${r.error}`);
          continue;
        }
        // 선택지 UI 미지원 채널 — 질문이 아예 안 가는 것보단 텍스트가 낫다.
        await deps.deliverText(
          t,
          formatPromptOptionsText(question, options, opts?.note),
        );
        rendered++;
      } catch (e) {
        errors.push(`${t.channel}: ${describe(e)}`);
      }
    }
    if (errors.length > 0) {
      // ★판정 수치와 함께 — 몇 곳 중 몇 곳에 갔는지가 "안 왔다" 진단의 재료다.
      console.error(
        `선택지 렌더 부분 실패 — ${rendered}/${(inbound === undefined ? 0 : 1) + targets.length}곳 성공. ` +
          `실패: ${errors.join(" / ")}`,
      );
    }
    return rendered > 0
      ? { ok: true as const }
      : {
          ok: false as const,
          error: errors.length > 0 ? errors.join(" / ") : "렌더 대상이 없습니다",
        };
  };
};
