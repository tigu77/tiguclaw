/**
 * 회귀: **`/logs` 는 큐를 안 타고, 대화를 안 내보내고, 파일 전량을 안 읽는다** (2026-07-31).
 *
 * 사고(전체검토 P0 4건): `/logs`·`/diagnose` 를 "모델을 안 타니 백엔드가 죽어도 된다" 며
 * 넣었는데 검토가 셋을 잡았다.
 *  ①**직렬 큐 뒤에 섰다.** out-of-band 는 `/restart`·`/stop`·`/update` 뿐이라, 턴이 멈춰
 *   있을 때 쓰라고 만든 도구가 정확히 그때 같이 막혔다 — 커밋 메시지엔 "진단 수단이
 *   진단 대상에 의존하면 안 된다" 고 써놓고 배관을 안 봤다.
 *  ②**남의 대화가 나갔다.** 로그엔 다른 세션의 응답 서술(`tail:`)·사용자 원문(`userText=`)·
 *   백엔드 원문(`raw=`)·chatId 가 들어간다. `redactSecrets` 는 env 값·토큰 패턴만 지운다.
 *   텔레그램은 영구 보존이고 `channel.message.out` 은 chat_log·events 에 적재된다.
 *  ③**파일 전량을 동기 로드했다.** dev 에 이미 5.8MB 가 있고 turn-end·stream-trace 는
 *   턴마다 쌓인다 — 커지면 이벤트 루프가 멎고 V8 상한을 넘으면 throw 한다
 *   (**로그가 가장 필요한 순간에만 실패**).
 *
 * 순수 판정(문자열 가공)과 배선을 함께 본다 — 가공만 검사하면 배관이 되돌아가도 초록이다.
 */
import { stripLogPayloads } from "../../core/log-sanitize.js";
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/**
 * 실제 로그에서 형상만 딴 픽스처 — [입력, 남아 있으면 안 되는 조각].
 * ★id 는 합성값이다. 처음엔 실제 chatId 를 넣었다가 **public 싱크의 PII 게이트에 걸렸다**
 *  (게이트가 제 역할을 했다). 검사 픽스처도 배포되는 파일이다.
 */
const CARRIERS: Array<[string, string]> = [
  [
    "[stream-trace] dashboard:x total=91 +91(turn_done) tail: 네. 현재 SVN 워킹 카피의 미커밋 변경분을",
    "SVN 워킹 카피",
  ],
  [
    '[codex empty-response] iteration=5 inputChars=168 userText="InteractionCameraPose를 실제 카메라"',
    "InteractionCameraPose",
  ],
  [
    '[codex-backend-failure] error — raw={"type":"error","response":{"id":"resp_abc"}}',
    "resp_abc",
  ],
  ["route channel=telegram session=dashboard:default addr=1234567890", "1234567890"],
  ["[codex 6b] 요약 (threadKey=tg:1234567890 fold=72턴)", "1234567890"],
];

/** 지워지면 안 되는 진단 수치 — 이걸 잃으면 /logs 를 만든 이유가 사라진다. */
const KEEP =
  "[codex-turn-end] model=gpt-5.6-sol iter=4 req=71,860(i23,152/n25,794/t22,537) closing=종료";

export const check: RegressionCheck = {
  name: "logs-command-safety",
  guards:
    "/logs 가 직렬 큐에 막히고, 남의 대화·chatId 를 채널로 내보내고, 로그 파일 전량을 메모리에 올리던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★동작 — grep 이 아니라 실제로 지워지는지 본다(회귀 = 대화·PII 유출이라 문자열
    //  검사로 갈음하면 안 된다). 남으면 안 되는 조각과 남아야 하는 수치를 함께.
    const leaked = CARRIERS.filter(([line, secret]) =>
      stripLogPayloads(line).includes(secret),
    ).map(([, secret]) => secret);
    out.push(
      assert(
        "★대화 본문·사용자 원문·백엔드 원문·chatId 가 실제로 지워진다",
        leaked.length === 0,
        leaked.length === 0 ? `캐리어 ${CARRIERS.length}종 전부 제거` : `유출 ${leaked.join(", ")}`,
      ),
    );
    const kept = stripLogPayloads(KEEP);
    out.push(
      assert(
        "★진단 수치는 남는다(model·req·iter·closing)",
        kept === KEEP,
        kept === KEEP ? "무손실" : `변형됨: ${kept}`,
      ),
    );

    // 배선 ① — out-of-band(큐 우회). in-band 로 되돌아가면 원 사고가 그대로 복귀한다.
    const oob = await sourceHas("../../index.ts", [
      // /restart·/stop 과 같은 블록(serializedHandler 안, enqueueThreadTurn 앞)에 있어야 한다.
      /if \(msg\.text\.trim\(\)\.split\(\/\\s\+\/\)\[0\] === "\/logs"\) \{/,
      /if \(msg\.text\.trim\(\) === "\/diagnose"\) \{/,
    ]);
    out.push(
      assert(
        "★/logs·/diagnose 가 직렬 큐를 건너뛴다(멈춘 턴에서도 쓸 수 있다)",
        oob.ok,
        oob.ok ? "out-of-band 확인" : `누락 ${oob.missing.join(" ")}`,
      ),
    );

    // 배선 ② — 대화 캐리어 제거 규칙이 실제로 존재하고 호출된다.
    // 규칙 자체는 위에서 동작으로 봤다 — 여기선 **호출되는지**만 본다(규칙이 있어도
    // 안 부르면 원문이 그대로 나간다).
    const strip = await sourceHas("../../index.ts", [
      /lines\.map\(stripLogPayloads\)/,
      /redactSecrets\(lines\.map\(stripLogPayloads\)\.join\("\\n"\)\)/,
    ]);
    out.push(
      assert(
        "★그 규칙이 /logs 경로에서 실제로 호출된다",
        strip.ok,
        strip.ok ? "2개 확인" : `누락 ${strip.missing.join(" ")}`,
      ),
    );

    // 배선 ③ — 파일 전량 로드 금지(끝에서 청크만).
    const bounded = await sourceHas("../../index.ts", [
      /LOG_TAIL_READ_BYTES/,
      /Math\.max\(0, size - LOG_TAIL_READ_BYTES\)/,
    ]);
    const noFull = await sourceHas("../../index.ts", [/readFileSync\(file, "utf8"\)/]);
    out.push(
      assert(
        "★로그 파일 전량을 메모리에 올리지 않는다(끝에서 청크만)",
        bounded.ok && !noFull.ok,
        bounded.ok && !noFull.ok
          ? "청크 읽기 확인"
          : !bounded.ok
            ? `누락 ${bounded.missing.join(" ")}`
            : "readFileSync 전량 로드가 되돌아왔다",
      ),
    );

    // ★/diagnose 시한 — 진단이 진단 대상 증상(무응답)에 매달리면 안 된다.
    const probe = await sourceHas("../../core/llm-runtime/codex-weight-probe.ts", [
      /PROBE_TIMEOUT_MS/,
      /signal: ac\.signal/,
      /if \(ac\.signal\.aborted\) \{/, // SSE 루프도 끊긴다(fetch signal 만으론 안 끊긴다)
    ]);
    out.push(
      assert(
        "★/diagnose 한 발마다 시한이 있고 스트림 루프도 끊긴다",
        probe.ok,
        probe.ok ? "3개 확인" : `누락 ${probe.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
