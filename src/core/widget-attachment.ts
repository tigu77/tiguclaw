// src/core/widget-attachment.ts
/**
 * **위젯 첨부가 지켜야 하는 것** — 판정만 (2026-08-28, 위젯 플랫폼).
 *
 * ★설계(`docs/decisions/2026-08-28-widget-platform.md` §C.1.1)에 **규칙은 적혀 있었는데
 *  집행하는 코드가 0**이었다. 이 레포가 여러 번 데인 자리다: *"게이트는 '있다'가 아니라
 *  '도는가'"*. 두 번째 플러그인 작성자가 500KB 를 실어도 아무 신호가 없었다 —
 *  `weather` 가 지킨 건 규칙 때문이 아니라 **우연**이었다.
 *
 * ★**언제 거부하느냐가 크기보다 중요하다.** 읽을 때 자르면 사용자에게 **조용히 반쪽
 *  위젯**이 뜬다(이 레포가 "캡 있는 자리에 도달해야 할 것을 두지 마라" 로 두 번 데인 방식).
 *  쓸 때 거부하면 **플러그인 개발자가 즉시** 보고, 사용자는 애초에 안 겪는다.
 *
 * ★**메시지는 안 죽인다.** 넘치는 건 그 **첨부 하나**고 텍스트는 그대로 간다 — 위젯은
 *  덤이고 *"도구의 텍스트 답만으로 완결"* 이 규약이기 때문이다. 카드가 크다고 답을
 *  통째로 버리면 그게 더 나쁘다.
 *
 * ★순수 함수인 이유는 검사다 — `deliverOutbound` 안에 인라인으로 두면 회귀가 데몬을
 *  띄워야 하고, 그러면 크기 경계를 **실제로 넘겨볼** 수가 없다(principle-check Q7).
 */

/**
 * 한 위젯 첨부의 상한.
 *
 * ★**잠정이다.** 직감으로 정했고(설계 노트에 그렇게 적었다), 실측은 `weather` 가 531B ·
 *  지도는 아직 없다. 지도 payload 를 재본 뒤 조정한다 — *"임계를 직감으로 정하지 마라"*.
 *  지금 값의 역할은 "정확한 선"이 아니라 **폭주를 막는 것**이다(`chat_log` 는 프루닝이
 *  없어서 선형으로 자란다).
 */
export const WIDGET_PAYLOAD_MAX_BYTES = 64 * 1024;

export interface WidgetAttachmentVerdict {
  /** 실제로 실을 것들(넘친 것은 빠져 있다). */
  readonly kept: readonly unknown[];
  /** 거부된 것 — 사람이 읽는 한 줄들. 비어 있으면 전부 통과. */
  readonly rejected: readonly string[];
}

const isWidget = (a: unknown): a is { kind: string; widget?: unknown; data?: unknown } =>
  typeof a === "object" && a !== null && (a as { kind?: unknown }).kind === "widget";

/**
 * 위젯 첨부만 검사해서 통과분과 거부 사유를 가른다.
 *
 * ★위젯이 **아닌** 첨부(파일·이미지)는 건드리지 않는다 — 그건 이 규칙의 대상이 아니고,
 *  여기서 같이 판정하면 남의 기능에 상한을 몰래 얹는 것이 된다.
 */
export const checkWidgetAttachments = (
  attachments: readonly unknown[] | undefined,
): WidgetAttachmentVerdict => {
  if (attachments === undefined || attachments.length === 0) {
    return { kept: [], rejected: [] };
  }
  const kept: unknown[] = [];
  const rejected: string[] = [];
  for (const a of attachments) {
    if (!isWidget(a)) {
      kept.push(a);
      continue;
    }
    const id = typeof a.widget === "string" ? a.widget : "(이름 없음)";
    if (typeof a.widget !== "string" || a.widget.indexOf("/") <= 0) {
      // `<plugin>/<widget>` 이 아니면 화면이 어느 플러그인 코드를 데려올지 모른다.
      rejected.push(`위젯 id 가 '<plugin>/<widget>' 형식이 아닙니다: ${id}`);
      continue;
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(a.data ?? null), "utf8");
    } catch {
      // 순환 참조 등 — 직렬화 못 하면 `chat_log` 에도 못 들어간다. 여기서 잡는 게 낫다.
      rejected.push(`위젯 '${id}' 의 data 를 직렬화할 수 없습니다`);
      continue;
    }
    if (bytes > WIDGET_PAYLOAD_MAX_BYTES) {
      rejected.push(
        `위젯 '${id}' 의 data 가 ${bytes}B 로 상한 ${WIDGET_PAYLOAD_MAX_BYTES}B 를 넘습니다 — ` +
          `요약만 싣고 상세는 플러그인 데이터 라우트로 받으세요.`,
      );
      continue;
    }
    kept.push(a);
  }
  return { kept, rejected };
};
