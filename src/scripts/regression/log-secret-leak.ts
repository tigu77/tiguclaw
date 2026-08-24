/**
 * 회귀: **로그 파일에 시크릿·PII 가 평문으로 남지 않는다** (2026-07-31 전체검토 P0).
 *
 * 사고: grammy `HttpError` 의 own property `error`(내부 FetchError)의 message 가
 * `request to https://api.telegram.org/bot<TOKEN>/sendMessage failed` 라서,
 * `console.error("...", e)` 의 `util.inspect` 가 **현재 유효한 봇 토큰**을 평문으로 찍었다.
 * 실측 **468회**(daemon 234 + launchd.err 234). 같은 자리에서 `payload.chat_id`(실 텔레그램
 * id)와 `payload.text`(발신 본문 전문)도 통째로 펼쳐져 **1,780줄**이 쌓였다.
 *
 * ★뼈아픈 대칭: 커밋 4d4a18c 가 `/logs` **출구**에서 막은 바로 그 부류가 **입구에서**
 *  그대로 들어오고 있었다. 출구만 보고 입구를 안 봤다.
 *
 * 두 계층으로 닫는다 — 하나로는 부족하다는 걸 실측으로 확인했다:
 *  ①**로거 관문**(`logging.ts`)에서 `redactSecrets` — 모든 `console.*` 이 디스크로 가는
 *   단일 지점이라 호출부를 열거하지 않아도 현재·미래 모듈이 전부 덮인다. 토큰을 잡는다.
 *   (실측: 885자 → 868자, 토큰 ✅ / chatId·본문 🔴)
 *  ②**발생원 요약**(`describeTelegramError`) — redact 는 env 값 매칭이라 chat_id·본문 같은
 *   **비밀 아닌 PII** 는 원리적으로 못 잡는다. payload 를 애초에 안 만든다.
 *   (실측: 885자 → 45자 / 646자 → 94자, 세 축 전부 ✅)
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { stripComments } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas } from "./_wiring.js";

/**
 * 시크릿 **형상** 픽스처 — 조각으로 조립한다.
 *
 * ★소독을 검사하는 코드는 본질적으로 시크릿처럼 생긴 입력이 필요하다. 그런데 리터럴로
 *  적으면 public 싱크의 시크릿 게이트(`[0-9]{8,10}:[A-Za-z0-9_-]{30,}`)에 걸린다.
 *  게이트에 예외(allowlist)를 파는 건 금지다 — 그러면 나중에 **진짜** 유출이 그 구멍으로
 *  나간다. 대신 조립해서 리터럴이 파일에 안 남게 한다(값은 완전 합성).
 *
 *  첫 판에서는 실제 봇의 숫자 ID 를 검토 출력에서 그대로 옮겨 적었다가 게이트에 걸렸다 —
 *  **픽스처도 배포되는 파일**이고, 봇 ID 는 그 자체로 식별 정보다. 게이트가 두 번 잡아줬다.
 */
const SYNTHETIC_TOKEN = `${"0".repeat(10)}:${"SYNTHETIC_FIXTURE_no_real_secret_here"}`;
const FOREIGN_TOKEN = `${"1234567890"}:${"Z".repeat(8)}${"synthetic".repeat(3)}`;

export const check: RegressionCheck = {
  name: "log-secret-leak",
  guards:
    "grammy 에러 객체를 통째로 찍어 봇 토큰 468회·chat_id·발신 본문 전문이 로그 파일에 평문으로 쌓이던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 로거 관문이 실제로 소독한다 — 부를 수 있는 순수 함수라 동작으로 본다.
    const { redactSecrets } = await import("../../core/outbound-sanitize.js");
    const prev = process.env.REGRESSION_FAKE_TOKEN;
    // ★값은 **완전 합성**이다. 첫 판에서 실제 봇의 숫자 ID(토큰 앞부분)를 검토 출력에서
    //  그대로 옮겨 적었다가 public 싱크의 시크릿 게이트에 걸렸다 — 픽스처도 배포되는 파일이고,
    //  봇 ID 는 그 자체로 식별 정보다. 게이트가 잡아준 게 두 번째다.
    process.env.REGRESSION_FAKE_TOKEN = SYNTHETIC_TOKEN;
    try {
      const fake = process.env.REGRESSION_FAKE_TOKEN;
      const line = redactSecrets(
        `telegram send failed: request to https://api.telegram.org/bot${fake}/sendMessage failed`,
      );
      out.push(
        assert(
          "★env 시크릿이 로그 문자열에서 가려진다(값 매칭 1층)",
          !line.includes(fake) && line.includes("[REDACTED:REGRESSION_FAKE_TOKEN]"),
          line.slice(0, 110),
        ),
      );
    } finally {
      if (prev === undefined) delete process.env.REGRESSION_FAKE_TOKEN;
      else process.env.REGRESSION_FAKE_TOKEN = prev;
    }

    // env 에 없는 봇 토큰(다른 인스턴스·회전본)도 형상으로 잡는다.
    const foreign = redactSecrets(`bot${FOREIGN_TOKEN} 로 요청`);
    out.push(
      assert(
        "env 밖 봇 토큰도 형상 패턴으로 가려진다(2층)",
        !foreign.includes(FOREIGN_TOKEN),
        foreign.slice(0, 90),
      ),
    );

    // ★② 로거 관문이 **두 출구 모두** 소독한다 — 자식을 띄워 실제 출력을 읽는다.
    //  (2026-07-31 3차: 여기 있던 정규식은 "redactSecrets 호출이 있다" 만 봤다. 호출은
    //   있었지만 **파일 미러에만** 걸려 있었고 터미널 경로는 원문을 흘렸다. launchd 가
    //   그 stdout/stderr 를 같은 logs/ 폴더에 평문 파일로 쌓는다 — 소독이 아니었다.)
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "_log-leak-child.ts");
    const captured = await within(
      60_000,
      "로거 자식 출력 캡처",
      new Promise<{ out: string; err: string; file: string }>((resolve) => {
        const p = spawn(process.execPath, ["--import", "tsx", child, SYNTHETIC_TOKEN], {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
        let so = "";
        let se = "";
        p.stdout.on("data", (d: Buffer) => (so += d.toString()));
        p.stderr.on("data", (d: Buffer) => (se += d.toString()));
        p.on("close", () => resolve({ out: so, err: se, file: "" }));
        p.on("error", () => resolve({ out: "", err: "", file: "" }));
      }),
    );
    const cap = "value" in captured ? captured.value : { out: "", err: "", file: "" };
    const streams = `${cap.out}\n${cap.err}`;
    const sawOutput = streams.trim() !== "";
    out.push(
      assert(
        "★터미널 출구(stdout/stderr)에도 시크릿이 안 나간다 — launchd 가 그걸 파일로 쌓는다",
        sawOutput && !streams.includes(SYNTHETIC_TOKEN),
        !sawOutput
          ? "자식이 아무것도 안 찍음 — 검사 불가(하네스 고장)"
          : streams.includes(SYNTHETIC_TOKEN)
            ? `★유출: 터미널 출력 ${streams.length}자에 토큰 원문 존재`
            : `출력 ${streams.length}자 · 토큰 0회 · [REDACTED 표시 ${(streams.match(/\[REDACTED/g) ?? []).length}회`,
      ),
    );
    // 대조군 — 소독이 출력 자체를 삼켜버리면 진단면이 죽는다(과잉 방어 금지).
    out.push(
      assert(
        "대조군 — 소독해도 진단 문구는 남는다(로그를 통째로 죽이지 않는다)",
        streams.includes("telegram: 발송 실패") && streams.includes("HttpError"),
        streams.slice(0, 120).replace(/\n/g, "⏎"),
      ),
    );

    // ★대조군 2 — **낱말 중간의 우연한 일치를 먹지 않는다** (2026-08-24 실사용 신고).
    //  `disk-cleanup` 스킬 이름이 화면에 `di[REDACTED]` 로 떴다. 패턴 `sk-…`·`eyJ…` 에
    //  **시작 경계가 없어서** 낱말 중간에 우연히 그 글자가 있으면 통째로 먹었다.
    //  ★이건 미관이 아니라 **조용한 오염**이다 — 잘린 자리에 표시가 없어 읽는 쪽은 원문이
    //   그랬다고 믿는다. 오늘은 눈에 띄는 자리라 사용자가 잡았지만 진단 로그 한가운데였다면
    //   몰랐다. 같은 파일이 기록한 `Bearer \S+` 꼬리 먹기(윈도우 DB payload 3건 파손)의
    //   **거울상**이다 — 그때는 끝을, 이번엔 시작을 안 닫았다.
    //  ★가리는 힘은 위 ①② 가 지킨다. 여기는 **반대편**(과잉 방어)을 지켜, 둘이 같이 있어야
    //   "완화했다" 와 "오탐을 고쳤다" 가 구분된다.
    {
      const { redactSecrets } = await import("../../core/outbound-sanitize.js");
      const keep = [
        "스킬 disk-cleanup 을 만들었습니다", // sk- 가 낱말 중간
        "risk-analysis 결과",
        "my_sk-note 파일", // 밑줄 뒤
        "keyJson.parse.result 확인", // eyJ 가 낱말 중간
      ];
      // ★**가리는 쪽도 여기서 같이 본다** (2026-08-24). 위 ①② 는 env 값 매칭과 텔레그램
      //  토큰 형상만 보고 있었다 — 실측: `sk-…` 패턴을 **통째로 지워도 스위트 1,649건이
      //  전부 초록**이었다. 즉 이 축엔 그물이 **없었다**. 오탐만 막고 가리는 힘을 안 지키면,
      //  다음 사람이 "오탐 또 났네" 하며 패턴을 지워도 아무도 모른다.
      //  두 방향을 **한 자리에** 둔다 — 그래야 "완화" 와 "오탐 수정" 이 구분된다.
      const mustMask: [string, string][] = [
        ["OpenAI", "OPENAI_API_KEY=sk-proj-AbC123_def-456.xyz"],
        ["Anthropic", `{"key":"sk-ant-api03-AAAA-BBBB_cccc"}`],
        ["문장 중간", "토큰은 sk-live-9f8e7d6c5b4a3210 입니다"],
        ["하이픈 뒤(경계에서 뺀 축)", "--api-key=-sk-realkeyvalue123"],
        ["JWT", "auth eyJhbGciOi.eyJzdWIi.SflKxwRJ 끝"],
      ];
      const leaked = mustMask.filter(([, t]) => !redactSecrets(t).includes("[REDACTED]"));
      out.push(
        assert(
          "★진짜 키 형상은 계속 가려진다(경계를 닫아도 마스킹이 안 준다)",
          leaked.length === 0,
          leaked.length === 0
            ? `${mustMask.length}종 전부 가림`
            : `★${leaked.length}건 샌다: ${leaked.map(([n]) => n).join(", ")}`,
        ),
      );
      const eaten = keep.filter((t) => redactSecrets(t) !== t);
      out.push(
        assert(
          "★대조군 — 낱말 중간의 우연한 `sk-`·`eyJ` 를 먹지 않는다",
          eaten.length === 0,
          eaten.length === 0
            ? `${keep.length}종 무손상`
            : `★${eaten.length}건 먹힘: ${eaten.map((t) => `${t} → ${redactSecrets(t)}`).join(" / ")}`,
        ),
      );
    }

    // ★③ 발생원이 에러 객체를 통째로 넘기지 않는다 — redact 로는 못 잡는 PII 축.
    const summarized = await sourceHas("../../../plugins/telegram-channel/index.ts", [
      /const describeTelegramError = \(e: unknown\): string =>/,
      // 진단 수치는 남긴다(에러코드·설명·메서드·본문 길이).
      /GrammyError \$\{e\.error_code\} \$\{e\.description\} \(method=/,
      // HttpError 는 message 를 쓰지 않는다 — 그 안에 토큰이 있다.
      /HttpError\(transport\)/,
    ]);
    const rawDump = await sourceHas("../../../plugins/telegram-channel/index.ts", [
      // `console.error("...", e)` 형태 = 객체 통째로 넘기기. 하나도 남으면 안 된다.
      /console\.(?:error|warn|log)\([^)]*",\s*(?:e|e2|err)\s*\)/,
    ]);
    out.push(
      assert(
        "★텔레그램 채널이 에러 객체를 통째로 로그에 넘기지 않는다(payload 미생성)",
        summarized.ok && !rawDump.ok,
        summarized.ok && !rawDump.ok
          ? "요약 경로 확인"
          : rawDump.ok
            ? "console.*(…, e) 형태가 되살아났다 — payload 가 통째로 펼쳐진다"
            : `누락 ${summarized.missing.join(" ")}`,
      ),
    );
  // ── ★가리는 것이 **뒤를 먹지 않는다** (2026-08-15) ──────────────────────────
  //  사고: `Bearer\s+\S+` 의 `\S+` 가 "공백 아닌 것"을 끝까지 삼켜 **토큰 뒤에 붙은
  //  것까지 지웠다**. 직렬화된 JSON 에선 토큰 다음이 `\"}` 라 공백이 없어 **JSON 꼬리째**
  //  사라졌고, 윈도우 DB 에 파싱 불가 payload 3건이 그렇게 생겼다(len=318, `Bearer
  //  [REDACTED]` 에서 끊긴 채 끝난다). 다른 패턴은 전부 클래스가 닫혀 있었고 이것만 열려 있었다.
  //
  //  ★DB 보다 채널 출력이 더 위험하다 — 이건 **아웃바운드 살균기**다. 답변에 `Bearer …`
  //   가 섞이면 그 뒤 문장이 조용히 사라진다. 가리는 일이 지우는 일이 되면 안 된다.
  {
    const { redactSecrets } = await import("../../core/outbound-sanitize.js");

    // ① 사고 재현 — 직렬화된 JSON 이 살균 후에도 **파싱된다**.
    //  ★픽스처는 **실물 그대로** 만든다: 실제 깨진 행은 detail 이 `… Bearer <토큰>` 으로
    //   **끝났다**(길이 캡에 잘려서). 그래야 토큰 뒤가 `","seq":132}` 뿐이라 공백이 없고,
    //   열린 `\S+` 가 JSON 의 꼬리를 통째로 먹는다.
    //   ★처음엔 토큰 뒤에 ` -X POST` 를 붙인 픽스처를 썼는데 **변이가 통과했다** — 따옴표
    //    하나만 먹혀도 남은 문자열이 우연히 유효 JSON 이었다. 사고를 재현하지 못하는
    //    픽스처는 검사가 아니라 장식이다(변이 검증이 잡아냈다).
    const payload = JSON.stringify({
      label: "Bash",
      detail: 'curl -X POST http://x/v1/chat -H "Authorization: Bearer sk-livetoken123456',
      seq: 132,
    });
    const cleaned = redactSecrets(payload);
    let parsed: { seq?: number; detail?: string } | null = null;
    try {
      parsed = JSON.parse(cleaned) as { seq?: number; detail?: string };
    } catch {
      parsed = null;
    }
    out.push(
      assert(
        "★살균한 JSON 이 여전히 파싱된다(가리는 게 꼬리를 먹지 않는다)",
        parsed !== null && parsed.seq === 132,
        parsed === null ? `★파싱 실패 — 끝: ...${cleaned.slice(-42)}` : "파싱 OK",
      ),
    );

    // ② 토큰은 확실히 사라진다 — 위 완화가 마스킹을 약화시키지 않았다.
    out.push(
      assert(
        "그래도 토큰 자체는 남지 않는다",
        !cleaned.includes("sk-livetoken123456") && cleaned.includes("[REDACTED]"),
        cleaned.includes("sk-livetoken") ? "★토큰 잔존" : "마스킹 확인",
      ),
    );

    // ③ 문장 뒤가 살아남는다 — 채널 출력에서 답변이 잘리던 축.
    const sentence = redactSecrets(
      "Authorization: Bearer eyJhbG.ciOiJz.9abc 로 호출했고 결과는 정상입니다.",
    );
    out.push(
      assert(
        "★토큰 뒤 문장이 살아남는다(답변이 조용히 잘리지 않는다)",
        sentence.includes("결과는 정상입니다"),
        sentence,
      ),
    );

    // ⑤ ★**가리는 힘** — Bearer 패턴을 실제로 태운다 (적대 검토 P8).
    //  종전 픽스처 셋은 토큰이 전부 앞선 패턴(`sk-`·JWT)에 **먼저** 잡혀서, Bearer 규칙을
    //  밟는 단언이 **0건**이었다. 그래서 그 규칙을 통째로 지워도, 문자 클래스를 좁혀도
    //  스위트가 초록이었다("꼬리를 안 먹는가" 만 재고 "가리는가" 는 못 쟀다).
    //  ★어느 앞선 패턴에도 안 걸리는 **불투명 토큰**을 쓴다. 그리고 종전 `\S+` 가 가리던
    //   두 형상(`id:secret` · URL 인코딩)이 **계속** 가려지는지도 같이 본다 — 그게
    //   2026-08-15 에 조용히 좁아졌던 자리다.
    for (const [label, raw, secret] of [
      ["불투명", "Authorization: Bearer ghp_16C7e42F292c6912E7710c838347Ae178B4a", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
      ["id:secret", "Authorization: Bearer 12345:aBcDeFgHiJkLmNoPqRsTuV", "aBcDeFgHiJkLmNoPqRsTuV"],
      ["URL 인코딩", "Authorization: Bearer abc123%2Fdef456%3Dghi789JKL", "%2Fdef456%3D"],
    ] as const) {
      const masked = redactSecrets(raw);
      out.push(
        assert(
          `★Bearer 토큰이 실제로 가려진다(${label})`,
          !masked.includes(secret) && masked.includes("[REDACTED]"),
          masked,
        ),
      );
    }

    // ④ 클래스가 닫혀 있다 — `\S+` 같은 열린 수량자를 다시 들이지 않는다.
    const src = await readFile(
      new URL("../../core/outbound-sanitize.ts", import.meta.url),
      "utf8",
    );
    // ★주석 제거는 `_wiring.stripComments` 를 **공유**한다 (적대 검토 P13). 여기 있던
    //  자체 구현은 줄 첫머리 `//` 만 걷어서, 코드 **뒤에 붙은** 설명 주석에 빨간불이 났다
    //  (같은 판정이 세 벌이었고 그중 둘이 약했다 — 이 레포가 반복해서 데인 부류).
    const code = stripComments(src);
    out.push(
      assert(
        "★마스킹 패턴에 열린 `\\S+` 가 없다(뒤를 먹는 형태 금지)",
        !/\\S\+/.test(code),
        /\\S\+/.test(code) ? "★열린 수량자 재도입" : "닫힌 클래스 확인",
      ),
    );
  }

    return out;
  },
};
