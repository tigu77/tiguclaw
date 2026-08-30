/**
 * **이력 도구 스텝 복원** — `chat-history` 가 메시지만 주면 새로고침에 도구 사용이 사라진다.
 *
 * 같은 ts 범위의 영속 `llm.activity`(매니저·서브·게이트웨이 제외)를 복원용으로 돌려주고,
 * 대시보드가 메시지와 시간순으로 인터리브해 그린다. best-effort — 실패하면 빈 배열이다.
 *
 * ★`index.ts` 에서 떼어냈다 (2026-08-30). 143줄에 import 는 `listEvents` 하나뿐이었다.
 */
import { listEvents } from "../../src/store/events.js";

interface HistoryActivity {
  ts: number;
  threadKey: string;
  adapter: string;
  seq: number;
  label: string;
  detail: string;
  diff?: unknown; // 리치 diff(ActivityDiff) — 있으면 그대로 통과(대시보드가 렌더). 2026-07-09.
  output?: unknown; // 리치 출력(ActivityOutput) — phase:"end" 에서 시작 스텝으로 병합. 2026-07-09.
  plan?: string; // ExitPlanMode 전체 계획(마크다운) — 있으면 통과(대시보드 전체 렌더). 2026-07-19.
  /**
   * "tool" | "text" (2026-07-13, additive). 미지정 시 프런트 기본 해석 = "tool"
   * (하위호환 — 옛 이력에 kind 필드가 아예 없던 시절과 동형 형상). "text" 면 `text`
   * 필드가 그 세그먼트 본문(마크다운). seq 는 tool 활동과 같은 카운터 공간 — seq 정렬
   * = 인터리브 렌더 순서(`docs/decisions/2026-07-13-dashboard-turn-interleave.md`).
   */
  kind?: "tool" | "text";
  /** kind==="text" 일 때만 — 그 세그먼트의 마크다운 원문. 2026-07-13. */
  text?: string;
}
export const historyActivities = (
  entries: Array<{ ts: number }>,
  scopeThreadKey?: string,
  /**
   * ★상한 적용 여부 (2026-07-30) — **최신 페이지에서는 상한을 걸면 안 된다.**
   *
   * 사고: 탭을 전환하면 그 세션에서 *진행 중인* 턴이 통째로 안 보였다. 원인은 아래
   * `newestTs` 컷이다 — `chat_log` 는 `channel.message.in`(사용자 발화, 인바운드 즉시)과
   * `channel.message.out`(비서 응답, **턴 완료 후**)로만 쌓이므로, 진행 중 턴에는
   * assistant 행이 아직 없어 `newestTs` = 사용자 발화 시각이다. 그 턴의 도구 스텝·텍스트
   * 세그먼트는 전부 그 이후라 **100% 버려졌다**. 그래서 `tabs.js` 의 "진행 중 턴 seamless
   * 재개"(activeTurns && activities.length > 0)가 **한 번도 발동하지 못했다** — 방어 코드는
   * 있는데 서버가 재료를 안 줬다.
   *
   * 상한의 원래 의도는 **역방향 페이지네이션**(옛 페이지를 볼 때 창 밖 활동 배제)이다.
   * 그래서 `beforeTs` 가 지정된 과거 페이지에서만 건다.
   */
  upperBounded = false,
): HistoryActivity[] => {
  if (entries.length === 0) return [];
  const sinceTs = entries[0].ts; // ASC — oldest.
  const newestTs = upperBounded
    ? entries[entries.length - 1].ts
    : Number.POSITIVE_INFINITY;
  try {
    const raw = listEvents({ types: ["llm.activity"], sinceTs, limit: 3000 });
    // 1차 파싱 — start 스텝은 out 으로, end 이벤트의 output 은 (threadKey|adapter|seq) 맵으로
    // 모아 뒤에 시작 스텝에 병합(라이브의 phase:end→스텝 주석과 동형). durationMs 는 이력 불필요.
    const out: HistoryActivity[] = [];
    const endOutputs = new Map<string, unknown>();
    const okey = (tk: string, adapter: string, seq: number) => tk + "|" + adapter + "|" + seq;
    for (const e of raw) {
      if (e.ts > newestTs) continue;
      let p: {
        threadKey?: unknown;
        adapter?: unknown;
        model?: unknown;
        seq?: unknown;
        label?: unknown;
        detail?: unknown;
        phase?: unknown;
        kind?: unknown;
        diff?: unknown;
        output?: unknown;
        text?: unknown;
        plan?: unknown;
      };
      try {
        p = JSON.parse(e.payload);
      } catch {
        continue;
      }
      // 2026-07-13 인터리브 — "tool" 외에 "text"(도구 경계 텍스트 세그먼트)도 이력에 admit.
      // "turn"(coarse floor) 은 여전히 제외 — 렌더 대상 아님(기존과 동일).
      if (p.kind !== "tool" && p.kind !== "text") continue;
      const tk = typeof p.threadKey === "string" ? p.threadKey : "";
      if (tk.startsWith("worker:") || tk.startsWith("agent:") || tk.startsWith("gateway:")) {
        continue; // 잡·게이트웨이 스텝은 채팅 이력 아님(text 세그먼트도 depth>0 은 애초 미발행).
      }
      // 멀티세션 탭(ADR 2026-07-15) — 요청 threadKey 로 스코프해 entries 와 동일 계약 유지
      //  (안 하면 타 스레드 도구 스텝이 세션 이력에 샘 = 크로스세션 누수). 미지정=현행(전 스레드).
      if (scopeThreadKey !== undefined && scopeThreadKey !== "" && tk !== scopeThreadKey) continue;
      const seq = typeof p.seq === "number" ? p.seq : 0;
      const adapter = typeof p.adapter === "string" ? p.adapter : "";
      // ★실제 응답 모델을 이력 투영에 포함 (2026-07-27). 종전엔 여기서 버려져, 라이브 SSE 에는
      //  모델이 보이는데 **새로고침하면 사라지고** 전체활동 뷰엔 아예 안 나왔다(같은 데이터인데
      //  경로에 따라 달라지는 것 = 관측을 믿을 수 없게 만든다). 없으면 키 자체를 생략(거짓값 금지).
      const model = typeof p.model === "string" && p.model !== "" ? p.model : undefined;
      if (p.kind === "text") {
        // 텍스트 세그먼트 — phase/output/diff 없음(발행측이 안 채움). 그대로 1건.
        out.push({
          ts: e.ts,
          threadKey: tk,
          adapter,
          ...(model !== undefined ? { model } : {}),
          seq,
          label: typeof p.label === "string" ? p.label : "text",
          detail: "",
          kind: "text",
          text: typeof p.text === "string" ? p.text : "",
        });
        continue;
      }
      if (p.phase === "end") {
        // 실행시간 주석 이벤트 — 스텝은 아니나 output 이 있으면 시작 스텝에 병합.
        if (p.output !== undefined && p.output !== null) endOutputs.set(okey(tk, adapter, seq), p.output);
        continue;
      }
      out.push({
        ts: e.ts,
        threadKey: tk,
        adapter,
        ...(model !== undefined ? { model } : {}),
        seq,
        label: typeof p.label === "string" ? p.label : "tool",
        detail: typeof p.detail === "string" ? p.detail : "",
        kind: "tool",
        ...(p.diff !== undefined && p.diff !== null ? { diff: p.diff } : {}),
        ...(typeof p.plan === "string" ? { plan: p.plan } : {}),
      });
    }
    // 2차 — end output 을 대응 시작 스텝에 병합.
    if (endOutputs.size > 0) {
      for (const s of out) {
        const o = endOutputs.get(okey(s.threadKey, s.adapter, s.seq));
        if (o !== undefined) s.output = o;
      }
    }
    // ★ASC 로 돌려준다 (2026-07-30) — `entries`(ASC, 위 sinceTs 주석)와 **같은 방향**이어야
    //  한다. listEvents 는 `ORDER BY id DESC` 라 여기까지 최신순인데, 소비처는 ASC 를
    //  가정한다: `tabs.js` 의 진행 중 턴 분할이 배열 끝에서부터 seq 증가 구간을 되짚어
    //  "마지막 turn" 을 찾는다(DESC 면 가장 오래된 1건만 집어 재개가 깨진다).
    //  `groupMergedItems` 는 자체 정렬이라 무영향 — 즉 지금까지 이 뒤집힘이 드러난 곳이
    //  분할 로직 하나뿐이었고, 그마저 위 상한 컷 때문에 실행된 적이 없어 가려져 있었다.
    out.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    return out;
  } catch {
    return [];
  }
};

// endpoint × role 매핑 — contract §1.Q3 표 그대로.
// admin 은 모든 role 포함 (superset). dashboard V2 contract §1.Q3.
