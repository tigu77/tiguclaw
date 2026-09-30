/**
 * **실행기가 아직 시작하지 않은 우리 입력** — 이게 남아 있으면 어댑터가 입력(stdin)을 닫지 않는다 (2026-09-30).
 *
 * 사고(회사돌쇠 09-29·09-30 3건): 매니저 완료 보고를 쓰는 중에 사진이 들어와 실행기 큐에 섰다. 첫 result 에서
 *  어댑터가 stdin 을 닫았고(완료 데드락 수정), 실행기가 줄 선 턴을 돌리며 `Read` 를 부르자 **5~9ms 만에**
 *  `toolDenialKind=cancelled` — «The user doesn't want to take this action right now. STOP …». 모델은 그 말대로
 *  «멈췄습니다, 스샷은 열어 보지 않았습니다» 라고 답했다(사용자에겐 «도구가 다 실패하고 못 했다고 한다»).
 * ★뿌리: 우리 훅(PreToolUse)과 내장 MCP 는 **stdin/stdout 제어 통로**로 답한다. 닫힌 뒤엔 답이 못 가서 실행기가
 *  도구를 취소한다. 가짜 모델 서버로 재현했다 — 훅 있음+닫음 = 취소 / 훅 없음·열어 둠·이 판정 적용 = 정상.
 * ★판정은 실행기가 주는 `command_lifecycle`(command_uuid · queued→started→completed|cancelled|dropped)로만 한다 —
 *  `queued` 가 아닌 상태를 받으면 실행기가 그 입력을 집었다. 시간·개수 추측 없음. 실행 중인 도구 결과에 섞여
 *  들어간 입력은 result 전에 `started` 가 와서(실측) 종전처럼 바로 닫힌다.
 */
export interface SteerQueue {
  /** 실행기에 넘긴 입력(우리가 단 uuid). 실행기가 집을 때까지 «줄 선» 상태다. */
  sent(uuid: string): void;
  /** SDK 메시지를 본다 — `command_lifecycle` 만 의미가 있다. */
  observe(msg: unknown): void;
  /** 아직 시작 전인 입력 수 — 0 이어야 입력을 닫아도 된다. */
  size(): number;
  clear(): void;
}

export const createSteerQueue = (): SteerQueue => {
  const queued = new Set<string>();
  return {
    sent: (uuid) => { queued.add(uuid); },
    observe: (msg) => {
      const m = msg as { type?: unknown; command_uuid?: unknown; state?: unknown } | null;
      if (m?.type !== "command_lifecycle" || typeof m.command_uuid !== "string") return;
      if (m.state !== "queued") queued.delete(m.command_uuid);
    },
    size: () => queued.size,
    clear: () => queued.clear(),
  };
};
