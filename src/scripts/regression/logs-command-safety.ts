/**
 * 회귀: **`/logs` 는 큐를 안 타고, 대화를 안 내보내고, 파일 전량을 안 읽는다** (2026-07-31).
 *
 * 1차 사고: `/logs`·`/diagnose` 가 직렬 큐 뒤에 서서, 턴이 멈췄을 때 쓰라고 만든 도구가
 * 정확히 그때 같이 막혔다. 파일도 전량 동기 로드했다(로그가 가장 필요한 순간에만 실패).
 *
 * ★2차 사고 — **그물이 잡았어야 할 걸 못 잡았다.** 유출 방지를 캐리어 접두사 5종
 * (`tail:`·`userText=`·`raw=`…) **열거**로 만들고, 픽스처도 전부 **합성 단일 줄**로 지었다.
 * 그래서 실로그의 주력 형상을 통째로 놓쳤다: `console.error("...", err)` 의 `util.format`
 * 다중 줄 덤프는 계속 줄에 **접두사가 아예 없다**. 검토 2인이 독립으로 실측 —
 * 텔레그램 502 직후 `/logs 40` 의 표시 40줄 중 **29줄이 chat_id + 발송 본문 전문**이었다.
 *
 * 그래서 이 검사는 두 가지를 바꿨다:
 *  ①판정을 **구조**로 본다(로그 접두사 유무). 이름 열거는 구조로 못 가르는 것에만.
 *  ②픽스처를 **실로그 형상에서 딴다**. REAL_SHAPES 는 daemon-2026-07-26.log 의 실제
 *   GrammyError 덤프 구조다 — 값만 합성이다(픽스처도 배포되는 파일이라 실 PII 는 금지.
 *   첫 판에서 진짜 chatId 를 넣었다가 public 싱크 PII 게이트에 걸렸다).
 */
import { sanitizeLogTail } from "../../core/log-sanitize.js";
import { sourceHas, sourceOrder } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const P = (msg: string): string => `[2026-07-26 07:12:03] [error] ${msg}`;

/** ★실로그에서 딴 형상 — 특히 **다중 줄 덤프**(접두사 없는 계속 줄). */
const REAL_SHAPES: readonly string[] = [
  P("telegram formatted send failed, falling back to plain:"),
  "GrammyError: Call to 'sendMessage' failed! (400: can't parse entities)",
  "    at toGrammyError (/Users/someone/work/app/node_modules/grammy/out/core/error.js:38:12)",
  "  method: 'sendMessage',",
  "  payload: {",
  "    chat_id: '1234567890',",
  "    text: '<b>오늘의 주요 뉴스</b>\\n' +",
  "      '이재명 대통령이 미국 샌프란시스코에서 젠슨 황을 만나…',",
  "  }",
  P("[codex-turn-end] model=gpt-5.6-terra iter=4 req=71,860(i23,152/n25,794/t22,537) closing=종료"),
];

/** 이 조각들이 채널로 나가면 안 된다. */
const MUST_NOT_LEAK = [
  "1234567890", // chatId
  "이재명", // 발송 본문
  "젠슨 황",
  "오늘의 주요 뉴스",
  "/Users/someone", // 절대경로(스택 프레임)
];

/** 지워지면 안 되는 진단 수치 — 이걸 잃으면 /logs 를 만든 이유가 사라진다. */
const MUST_KEEP = ["model=gpt-5.6-terra", "req=71,860", "iter=4", "closing=종료"];

/** 접두사 있는 줄 안의 캐리어(구조로 못 가르는 것) — 이름으로 잡는 쪽. */
const INLINE_CARRIERS: Array<[string, string]> = [
  [P("[stream-trace] dashboard:x total=91 tail: 네. SVN 워킹 카피의 미커밋 변경분을"), "SVN 워킹 카피"],
  [P('[codex empty-response] iteration=5 userText="InteractionCameraPose를 실제 카메라"'), "InteractionCameraPose"],
  [P('[codex-backend-failure] error — raw={"type":"error","response":{"id":"resp_abc"}}'), "resp_abc"],
  [P("route channel=telegram session=dashboard:default addr=1234567890"), "1234567890"],
  [P("[codex 6b] 요약 (threadKey=tg:1234567890 fold=72턴)"), "1234567890"],
];

export const check: RegressionCheck = {
  name: "logs-command-safety",
  guards:
    "/logs 가 직렬 큐에 막히고, 남의 대화·chatId 를 채널로 내보내고(다중 줄 덤프 포함), 로그 파일 전량을 메모리에 올리던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 실로그 형상 — 다중 줄 덤프가 통째로 걸러진다.
    const r = sanitizeLogTail(REAL_SHAPES);
    const joined = r.out.join("\n");
    const leaked = MUST_NOT_LEAK.filter((s) => joined.includes(s));
    out.push(
      assert(
        "★실로그 다중 줄 덤프에서 chatId·발송 본문·절대경로가 안 나간다",
        leaked.length === 0,
        leaked.length === 0
          ? `계속 줄 ${r.dropped}줄 제외, 남은 ${r.out.length}줄`
          : `유출 ${leaked.join(", ")}`,
      ),
    );
    const lostNumbers = MUST_KEEP.filter((s) => !joined.includes(s));
    out.push(
      assert(
        "★진단 수치는 남는다(model·req·iter·closing)",
        lostNumbers.length === 0,
        lostNumbers.length === 0 ? "4종 보존" : `유실 ${lostNumbers.join(", ")}`,
      ),
    );
    // 생략을 **말한다** — 조용히 지우면 "로그에 아무것도 없었다" 는 틀린 결론이 된다.
    out.push(
      assert(
        "생략된 본문 줄 수를 표시한다(조용히 지우지 않는다)",
        r.dropped === 8 && joined.includes("본문 8줄 생략"),
        `dropped=${r.dropped} 표시=${joined.includes("본문 8줄 생략")}`,
      ),
    );

    // ★② 접두사 있는 줄 안의 캐리어.
    const inlineLeak = INLINE_CARRIERS.filter(([line, secret]) =>
      sanitizeLogTail([line]).out.join("").includes(secret),
    ).map(([, s]) => s);
    out.push(
      assert(
        "★접두사 있는 줄의 캐리어(tail·userText·raw·addr·tg)도 지운다",
        inlineLeak.length === 0,
        inlineLeak.length === 0
          ? `${INLINE_CARRIERS.length}종 전부 제거`
          : `유출 ${inlineLeak.join(", ")}`,
      ),
    );

    // ★③ 길이 상한 — 한 줄에 들어간 객체 덤프도 바운드된다(실측 p99.9=286).
    const longLine = P(`inline dump ${"x".repeat(2000)} chat_id=1234567890`);
    const capped = sanitizeLogTail([longLine]).out[0] ?? "";
    out.push(
      assert(
        "★한 줄짜리 거대 덤프도 상한에서 잘린다",
        capped.length < 500 && capped.includes("자 생략>"),
        `${capped.length}자`,
      ),
    );

    // 배선 ① — out-of-band(큐 우회). ★위치로 본다: `enqueueThreadTurn` **앞**에 있어야
    //  한다. 종전엔 `if` 줄 존재만 grep 해서, 블록을 큐 뒤로 옮겨도 초록이었다(변이 확인).
    const oob = await sourceOrder("../../index.ts", [
      /if \(msg\.text\.trim\(\) === "\/restart"\) \{/,
      /if \(msg\.text\.trim\(\)\.split\(\/\\s\+\/\)\[0\] === "\/logs"\) \{/,
      /if \(msg\.text\.trim\(\) === "\/diagnose"\) \{/,
      /return enqueueThreadTurn\(/,
    ]);
    out.push(
      assert(
        "★/logs·/diagnose 가 직렬 큐 **앞**에 있다(멈춘 턴에서도 쓸 수 있다)",
        oob.ok,
        oob.detail,
      ),
    );

    // ★답을 **기다리고** 내보낸다. `void (async …)()` 로 띄우고 즉시 return 했더니
    //  http-bridge 의 동기 요청/응답이 답보다 먼저 끝나 **`replyText: ""`** 였다
    //  (배포 직후 라이브에서 발각 — 위치·소독은 다 맞는데 사용자에겐 빈 답이 갔다).
    //  out-of-band 의 목적은 *직렬 큐를 안 타는 것*이지 *답을 안 기다리는 것*이 아니다.
    //  `/diagnose` 는 최대 2분이라 fire-and-forget 이 맞고, 먼저 "진단 중" 을 보낸다.
    const awaited = await sourceHas("../../index.ts", [
      /return \(async \(\): Promise<void> => \{\s*const text = await buildLogTail\(/,
    ]);
    const fireForget = await sourceHas("../../index.ts", [
      /void \(async \(\): Promise<void> => \{\s*const text = await buildLogTail\(/,
    ]);
    out.push(
      assert(
        "★/logs 가 답을 기다린 뒤 반환한다(fire-and-forget 이면 빈 답이 간다)",
        awaited.ok && !fireForget.ok,
        awaited.ok && !fireForget.ok
          ? "await 확인"
          : fireForget.ok
            ? "void 로 띄우고 즉시 return — replyText 가 빈다"
            : `누락 ${awaited.missing.join(" ")}`,
      ),
    );

    // 배선 ② — 소독기가 /logs 경로에서 실제로 호출된다(규칙이 있어도 안 부르면 무의미).
    const wired = await sourceHas("../../index.ts", [
      /const \{ out, dropped \} = sanitizeLogTail\(lines\)/,
      /redactSecrets\(out\.join\("\\n"\)\)/,
    ]);
    out.push(
      assert(
        "★그 소독기가 /logs 경로에서 실제로 호출된다",
        wired.ok,
        wired.ok ? "2개 확인" : `누락 ${wired.missing.join(" ")}`,
      ),
    );

    // 배선 ③ — 파일 전량 로드 금지. ★부정 시그니처(`!readFileSync`)를 한 API 이름으로 두면
    //  `readFile`·`createReadStream` 으로 갈아타도 통과한다(변이 확인). 긍정 조건만 못박는다.
    const bounded = await sourceHas("../../index.ts", [
      /const readFrom = Math\.max\(0, size - LOG_TAIL_READ_BYTES\)/,
      /await fh\.read\(buf, 0, len, readFrom\)/,
    ]);
    out.push(
      assert(
        "★로그 파일 끝에서 고정 청크만 읽는다",
        bounded.ok,
        bounded.ok ? "2개 확인" : `누락 ${bounded.missing.join(" ")}`,
      ),
    );

    // 헤더가 표본 크기를 속이지 않는다 — 자른 **뒤** 줄 수를 센다.
    const honest = await sourceHas("../../index.ts", [
      /const shownLines = shown === "" \? 0 : shown\.split\("\\n"\)\.length/,
      /\$\{shownLines\}줄 표시/,
    ]);
    out.push(
      assert(
        "★헤더가 실제로 표시된 줄 수를 말한다(200줄 요청→36줄 표시를 200이라 하던 것)",
        honest.ok,
        honest.ok ? "2개 확인" : `누락 ${honest.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
