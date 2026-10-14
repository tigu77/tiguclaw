/**
 * **핸들러를 우회하는 턴**(스케줄·파일감시)을 같은 스레드의 줄에 세우고, 진행 중으로 등록한다 — 한 곳에서 (2026-10-14).
 *
 * ★사고(돌쇠 10-14 아침 뉴스 두 번): 스케줄 턴은 스레드 줄(`enqueueThreadTurn`)을 거치지 않고 돌았다. 그 턴이 띄운 매니저가
 *  끝나 완료 재주입(메인 핸들러 → 줄)이 왔을 때 줄이 비어 보여 **즉시 시작**했고, 아직 돌던 스케줄 턴과 같은 스레드에서
 *  **동시에** 돌았다(08:11:30~08:12:00 — 둘 다 웹을 다시 읽고 위키 저장소에 git 을 돌리고 각자 뉴스를 보냈다).
 *  «한 스레드엔 한 번에 한 턴» 은 사용자 메시지·완료 재주입에만 지켜지고 있었다 — 입구가 둘이었다.
 * ★줄에 먼저 서고, **실제로 돌 때만** 진행 중으로 등록한다(`withExternalTurn`) — 기다리는 동안은 진행 중이 아니다.
 * ★`withExternalTurn` 안에 넣지 않은 이유: `inflight-turns` ↔ `worker-jobs` import 순환. 이 모듈이 둘을 잇는다.
 */
import { withExternalTurn, type InterruptedTurn } from "./inflight-turns.js";
import { enqueueThreadTurn } from "./worker-jobs.js";

export const runExternalTurn = <T>(threadKey: string, turn: InterruptedTurn, fn: () => Promise<T>): Promise<T> =>
  enqueueThreadTurn(threadKey, () => withExternalTurn(threadKey, turn, fn));
