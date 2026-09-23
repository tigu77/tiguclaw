/**
 * 턴 출처(`turnOrigin`)가 **router 를 지나 어댑터 로그까지** 닿는지 실행으로 본다.
 *
 * 잡는 회귀 — 이 표식이 없던 동안 무엇이 안 됐나:
 * 완료 재주입과 점검 재주입은 **둘 다** `synthetic:true` 에 같은 `reason` 이라,
 * 도구 목록·캐시 사용량을 출처별로 가를 수가 없었다. 수치는 어댑터 로그에서 만나는데
 * 출처는 `src/index.ts` 에서 끊겼다 — **사슬이 두 동강**이었다.
 *
 * 등급: **동작 검사**. 진짜 `route` 를 부르고, 어댑터가 실제로 찍은 줄을 읽는다.
 * ★출처를 어댑터에 손으로 넣는 검사로 «전달» 을 대신하지 않는다(그건 찍기만 재는 것).
 */
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "turn-origin-reaches-adapter",
  guards:
    "완료 재주입과 점검 재주입이 둘 다 synthetic:true 라 도구·캐시를 출처별로 가를 수 없던 것 · 진단 표식이 모델 요청 payload 로 새는 것",
  run: async () => {
    const r = await spawnWithin(60_000, "턴 출처 전달", [
      "--import",
      "tsx",
      fileURLToPath(new URL("./_turn-origin-child.ts", import.meta.url)),
    ]);
    const line = r.out.split(/\r?\n/).find((l) => l.startsWith("ORIGIN_RESULT "));
    const v =
      line === undefined
        ? {}
        : (JSON.parse(line.slice("ORIGIN_RESULT ".length)) as Record<string, unknown>);
    const childSrc = await (await import("node:fs/promises")).readFile(
      new URL("./_turn-origin-child.ts", import.meta.url),
      "utf8",
    );
    // ★소스 판정은 **한 곳**에서 한다 — 주석·문자열·비교(`===`)를 걷어내고 줄머리 대입만.
    //  (같은 술어를 실패 문구에서 다시 적으면 그 문구가 장식이 된다.)
    const PINNED_MODEL = "gpt-5.6-sol";
    const pinnedInSource = childSrc
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .some((l) => new RegExp(String.raw`^\s*process\.env\.REGION_A_MODELS\s*=[^=]`).test(l));
    const models = (v.models ?? []) as string[];
    const origins = (v.origins ?? []) as string[];
    const runs = (v.runs ?? []) as string[];
    const callbacks = (v.callbacks ?? []) as string[];
    const tail = line ?? r.err.slice(-1500);
    return [
      assert("입력 구성 진단이 실제 요청별 배열과 일치", v.compositionsMatch === true && Number(v.requestCount) > 0, tail),
      assert("origins.summary/history/current 합이 매 요청 전체 items·chars 와 일치", v.originsSound === true, tail),
      assert(
        "★★요약1·이력2 fixture: 로그 origins 가 실제 payload 내용으로 가른 summary/history/current 와 같다(도구 왕복 후에도)",
        v.boundaryOriginsMatch === true,
        JSON.stringify(v.boundaryDetail ?? tail),
      ),
      assert("worker/subagent 값이 어댑터 로그에 남는다", origins[5] === "worker" && origins[6] === "subagent", { origins }),
      assert("실제 어댑터 로그: 숫자 요약·미지원 구분, 원문/요청 유출 없음", v.attributionLogged === true, tail),
      assert("두 요청의 곡선과 종료 로그가 같은 실행·출처·사용량으로 연결된다", v.loopLinked === true, tail),
      assert("실제 요청 tools와 각 곡선의 sendFileTool이 일치한다", v.toolsMatch === true, tail),
      assert("종료 로그의 lastSendFileTool은 직전 요청 기준이다", v.endsMatch === true, tail),
      assert("콜백이 있어도 최종 tools=[]이면 실제 도구 없음으로 기록한다", v.flushSeparated === true, tail),
      assert("★어댑터가 실제로 돌았다(0이면 아래는 미검사다)", !r.timedOut && origins.length >= 8, tail),
      // ★★**이 검사는 주변 환경에 기대면 안 된다** (2026-09-22, 배포 트리 회귀가 잡음).
      //  첫 판은 `route(msg, { specs: [...] })` 로 모델을 정한다고 믿었는데 `route` 는 그
      //  이름을 **안 받는다**(`modelProfile` 만) — 인자가 **조용히 무시**되고 기본 풀로
      //  떨어졌다. 개발 레포엔 Claude 인증이 있어 **우연히 초록**이었고, 인증이 없는 배포
      //  트리에서만 「Claude 인증 없음」으로 14건이 터졌다.
      //  ★한 번 **결과 단언을 지웠다가 되돌렸다**(2026-09-22 재검토). 지운 근거는
      //   *"DEV 에선 원리적으로 못 빨개진다"* 였는데 **그게 틀렸다** — 못 빨개진 이유는
      //   원리가 아니라 **러너 env 봉인이 자식에서 뚫려서**(`delete` 한 키를 자식이 레포
      //   `.env` 에서 되읽는다) 고정을 빼도 `.env` 가 같은 값을 다시 준 것이다.
      //   실제로 `.env` 없는 트리에서 고정을 깨자 즉시 14건 빨강이었다. **오진 위에서
      //   작동하던 그물을 제거한 것**이라 되돌린다.
      //  ★아래는 **둘 다** 둔다 — 재는 것이 다르다:
      //   · 결과 단언 = «어느 모델로 실제로 돌았나». 제품(라우터·풀 선택)이 갈리면 빨개진다.
      //   · 소스 단언 = «고정이 코드에 있나». 누가 그 줄을 지우면 빨개진다.
      assert(
        "★★**결과**로 잰다 — 어댑터가 고정한 모델로 실제로 돌았다",
        models.length === 1 && models[0] === PINNED_MODEL,
        models.length === 0
          ? "어댑터 로그 0줄 — codex 로 안 돌았다(기본 풀로 떨어졌을 가능성)"
          : `models=${JSON.stringify(models)} (기대 ["${PINNED_MODEL}"])`,
      ),
      assert(
        "★★자식이 모델을 **고정**한다 — 주변 설정이 어댑터를 바꾸면 이 검사는 무의미해진다",
        pinnedInSource,
        // ★증거는 관측이다. 종전 정규식은 `\s*=` 라 `===`·주석·문자열까지 물었다
        //  (실패 문구가 «언급만 있고 대입 없음» 으로 구분하는 척하면서 **같은 정규식**을
        //   썼다). 이제 주석을 걷어낸 뒤 **줄머리 대입**만 본다.
        pinnedInSource
          ? `고정=${PINNED_MODEL}`
          : `대입 없음 (언급: ${String(/REGION_A_MODELS/.test(childSrc))})`,
      ),
      assert(
        "★정규 인입은 `inbound` — 라우터가 기본값을 정한다",
        origins[0] === "inbound" && origins[4] === "inbound",
        `origins=${JSON.stringify(origins)}`,
      ),
      assert(
        "★★완료·점검 재주입이 **서로 구분된다**(이게 이 표식의 이유다)",
        origins[1] === "worker-completion" && origins[2] === "worker-checkin",
        `origins=${JSON.stringify(origins)}`,
      ),
      assert(
        "표식 없는 합성은 `synthetic-other`",
        origins[3] === "synthetic-other",
        `origins=${JSON.stringify(origins)}`,
      ),
      assert(
        "★router 를 우회한 직접 호출은 `unknown` — 본문·접두로 추론하지 않는다",
        origins[7] === "unknown",
        `origins=${JSON.stringify(origins)}`,
      ),
      assert(
        "★콜백 유무가 출처와 **따로** 기록된다(같은 값으로 대체하지 않는다)",
        callbacks[0] === "1" && callbacks[1] === "0",
        `callbacks=${JSON.stringify(callbacks)}`,
      ),
      assert(
        "★실행 ID 는 호출마다 다르다 — 같은 스레드를 연속 실행해도 갈린다",
        new Set(runs).size === runs.length && runs.every((x) => x.length > 8),
        `runs=${JSON.stringify(runs.map((x) => x.slice(0, 8)))}`,
      ),
      assert(
        "★★본문·이력이 같고 출처만 다른 두 실행의 요청이 **같다**(캐시 키 포함, 정규화 없음)",
        v.bodySameAcrossOrigin === true && v.headersSameAcrossOrigin === true,
        `body=${String(v.bodySameAcrossOrigin)} headers=${String(v.headersSameAcrossOrigin)}`,
      ),
      assert(
        "★★두 스레드를 **병렬로** 돌려도 출처·콜백·실행 ID 가 섞이지 않는다",
        v.parallelClean === true,
        `parallelClean=${String(v.parallelClean)}`,
      ),
      assert(
        "★★진단 값이 요청 본문으로 **새지 않는다**",
        v.leaked === false,
        `leaked=${String(v.leaked)} 요청=${String(v.requestCount)}건`,
      ),
    ];
  },
};
