/**
 * **이 턴이 꺼내 쓴 끼워넣기 장부** — 턴이 실패로 끝나면 채널에 되돌린다 (2026-10-09 전체 적대 검토 P3).
 *
 * ★사고의 모양: 끼워넣기 채널은 꺼내는 순간 지운다(codex·openai 는 `drain()`, claude 는 `stream()`). 그 뒤 턴이
 *  실패하면 메시지는 **실패한 요청 안에만** 있다가 사라졌다 — 코어의 «턴 끝에 남은 것을 새 턴으로»(`index.ts`
 *  finally)도 빈 채널만 본다. 검토 재현: 끼워넣기를 drain 한 뒤 400 → 남은 것 0, 메시지 증발.
 * ★되돌려 두면 이미 있는 길이 받는다: 풀에 다음 후보가 있으면 그 후보가 **이 턴 안에서** 먼저 꺼내고, 없으면
 *  코어가 새 턴으로 다시 태운다. `/stop` 이면 턴 출구가 버린다(`reinjectUnlessStopped`) — 멈추라고 한 것을 되살리지 않는다.
 * ★세 어댑터가 각자 적으면 언젠가 한쪽만 고쳐진다 — 규칙을 여기 한 곳에 둔다(어댑터는 «언제 꺼냈나» 만 알린다).
 */
import type { SteeringInput } from "../../steering.js";
import type { ReplayGuard } from "../replay-safety.js";

export interface SteeringLedger {
  /** 채널에서 꺼내고 장부에 적는다(codex·openai — 꺼내는 쪽이 어댑터다). */
  drain(): SteeringInput[];
  /** 이미 꺼내 **모델에 넘긴** 것을 적는다(claude — 꺼내는 쪽이 SDK 입력 스트림이다). */
  note(s: SteeringInput): void;
  /** 적힌 것을 채널에 되돌리고 장부를 비운다. 되돌린 건수. */
  giveBack(): number;
}

export const createSteeringLedger = (
  channel: { drain(): SteeringInput[]; restore(msgs: SteeringInput[]): number } | undefined,
  /** 이 논리 턴의 재실행 금지 상태 — 되돌릴 수 없는 도구가 이미 돌았으면 되돌리지 않는다(아래 giveBack). */
  replay?: ReplayGuard,
): SteeringLedger => {
  // 꺼낸 것 + 그때까지의 부작용 횟수 — 받은 **뒤에** 부작용이 없었던 것만 되돌린다(아래 giveBack).
  const taken: Array<{ s: SteeringInput; at: number }> = [];
  const unsafeNow = (): number => replay?.unsafeCount ?? 0;
  return {
    drain() {
      const d = channel?.drain() ?? [];
      const at = unsafeNow();
      taken.push(...d.map((s) => ({ s, at })));
      return d;
    },
    note(s) {
      taken.push({ s, at: unsafeNow() });
    },
    giveBack() {
      // ★되돌릴 수 없는 도구가 이미 돌았으면 되돌리지 않는다 (2026-10-09 수정분 재검토 P4). 되돌린 끼워넣기는 새 턴으로 다시
      //  타는데, 그 턴은 실패한 턴의 기록이 없어 **같은 일을 또 한다** — 턴 안 재실행은 replay 차단이 막는데 이 길만 비어 있었다
      //  (재현: «메모 남겨줘» → add_memory 실행 → 401 → 끼워넣기가 채널로 돌아가 새 턴이 다시 남김). 두 번 하느니 버리고 남긴다.
      // ★판정은 **메시지마다**다 (2026-10-10 재검토). 종전엔 턴에 부작용이 한 번이라도 있으면 전부 버려, 부작용이 끝난 **뒤에**
      //  받은 끼워넣기(«그리고 파일명도 알려줘»)까지 사라졌다 — 그건 아무 일도 일으키지 않았으니 다시 태워도 두 번 하지 않는다.
      //  받은 뒤에 부작용이 있었던 것만 버린다(그 부작용이 그 메시지 때문일 수 있다).
      const now = unsafeNow();
      const all = taken.splice(0);
      const dropped = all.filter((x) => x.at < now).length;
      if (dropped > 0) {
        console.warn(
          `[steer] 실패한 턴에서 '${replay?.firstTool ?? "도구"}' 등이 끼워넣기를 받은 뒤 실행돼, 그 끼워넣기 ${String(dropped)}건을 되돌리지 않습니다(다시 돌리면 두 번 실행된다) — 필요하면 다시 보내 주세요`,
        );
      }
      // 맨 앞에 되돌린다 — 아직 안 꺼낸 대기분보다 먼저 온 것들이다(도착 순서 유지, 2026-10-10 아스트라 검토).
      return channel?.restore(all.filter((x) => x.at === now).map((x) => x.s)) ?? 0;
    },
  };
};
