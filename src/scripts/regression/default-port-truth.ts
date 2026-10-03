/**
 * 회귀: **기본 포트를 말하는 곳이 전부 같은 숫자를 말한다** (2026-08-01 사용자 신고).
 *
 * 신고: "대시보드가 엄청 중요한데 띄우는 방법이 안 써있네 README에". 파 보니 문서 누락
 * 하나가 아니라 **같은 값이 네 곳에서 갈렸다** — 두 달을 그렇게 살았다:
 *   설치 마법사·`.env.example`·`plugins/http-bridge/README.md` `3000`(= 실제로 배포된 값) /
 *   코드 폴백 `3101` / `packages/dashboard/README.md` `3002`
 * 그래서 **문서에 한 숫자를 쓸 수가 없었다.** 여는 법이 안 적힌 진짜 이유가 이거다.
 *
 * ★뿌리는 `fa69120`(2026-06-11 대시보드 자동시작): 코드 폴백만 `3000`→`3101` 로 바뀌고
 *  마법사·예제·문서는 `3000` 에 남았다. 3101 은 **개발 기계 배치**(거기선 3000 이 브리지)가
 *  코드 기본값으로 새어 든 것이었다.
 *
 * ★고친 방식 = 숫자를 맞추는 게 아니라 **중복을 없앤다**. 마법사와 `.env.example` 은 기본
 *  포트를 적지 않고(주석 안내만), 코드가 유일한 정본이다. 적어두는 순간 갈라진다.
 *
 * ★브리지 포트도 같이 본다 — 기본값 리터럴이 **네 벌**(`bin/daemon.mjs`·`packages/dashboard`·
 *  `plugins/http-bridge`·`doctor.ts`)이다. 대시보드는 두 벌이었는데도 갈라졌으니 넷은 시간
 *  문제였다. `bin/daemon.mjs` 는 의존성-프리(빌트인만)라 상수를 import 할 수 없어 **코드로
 *  합칠 수가 없다** — 합치는 대신 **판정으로 묶는다**(정본 하나를 읽어 나머지와 대조).
 *
 * ★이 검사는 이름을 열거하지 않는다 — 포트 env 이름을 **말하는 모든 추적 파일**을 찾아
 *  거기 적힌 숫자가 정본과 같은지 본다. 새 파일이 생겨도 저절로 걸린다.
 *  기록물(`docs/decisions/`·dev `README.md`·스크래치)은 **당시**를 적은 것이라 제외한다.
 */
import { execFileSync } from "node:child_process";
import { readSourceSync } from "./_wiring.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

/** 두 포트 각각의 **정본** — 여기 적힌 값이 진실이고 나머지는 전부 이것을 따른다. */
const PORTS = [
  {
    env: "DASHBOARD_PORT",
    what: "대시보드",
    source: "plugins/dashboard/index.ts",
    re: /const DEFAULT_DASHBOARD_PORT = "(\d+)"/,
  },
  {
    env: "HTTP_BRIDGE_PORT",
    what: "http-bridge",
    source: "plugins/http-bridge",
    re: /process\.env\.HTTP_BRIDGE_PORT \?\? "(\d+)"/,
  },
] as const;

/** 기록물 제외 — **당시**를 적은 것이라 현재값으로 고치면 오히려 거짓이 된다. */
const isRecord = (f: string): boolean =>
  f.startsWith("docs/decisions/") ||
  f === "README.md" ||
  // ★기억(`.claude/memory/`)도 기록물이다 — **각 기계·각 사고의 당시 사실**을 적는다
  //  (예: 윈도우 인스턴스는 .env 에 3010/3011 을 명시해 쓴다). 현재 기본값으로 고치면
  //  그 기록이 거짓이 된다. 2026-08-01 기억을 레포로 옮기며 이 범위가 처음 겹쳤다.
  f.startsWith(".claude/memory/") ||
  (f.startsWith("_workspace/") && !f.startsWith("_workspace/public-overlay/"));

/**
 * 한 줄이 «{env} 의 기본 포트» 에 대해 틀린 숫자를 말하는가 — 틀린 숫자 목록(없으면 빈 배열).
 * ★순수 함수로 뺀 이유: 예외 판정을 **실제 문서 상태와 무관하게** 픽스처로 고정하려고(재검토 F-E —
 *  수정 자신을 되돌려도 그날 문서엔 걸릴 줄이 없어 초록이었다).
 */
export const wrongPortsInLine = (l: string, env: string, want: string, truth: ReadonlyMap<string, string>): string[] => {
    // ★같은 줄에 env 이름이 없어도 **URL 형태의 포트**는 본다 — 실제로 놓쳤다:
    //  `app-ai-wiring` 은 `HTTP_BRIDGE_PORT` 를 두 번 언급하는데, 예제 줄은
    //  `OPENAI_BASE_URL=http://127.0.0.1:3000/v1` 이라 env 이름이 없어 스캔 밖이었다
    //  (그래서 배포 스킬이 사용자에게 틀린 포트를 알려주고 있었다, 2026-08-02).
    //  `127.0.0.1:<4자리>` 는 다른 뜻일 수 없으므로 오탐 위험이 낮다.
    const urlPort = /(?:127\.0\.0\.1|localhost):(\d{4})\b/.exec(l);
    if (!l.includes(env) && urlPort === null) return [];
    // ★한 줄이 **두 포트를 같이** 말하는 경우가 있다(예: "DASHBOARD_PORT(기본 X)·
    //  HTTP_BRIDGE_PORT 는 …"). 그 줄의 숫자를 한쪽에 귀속시킬 수 없으므로, 그때는
    //  **아는 기본값 중 하나이기만** 하면 통과시킨다. 낡은 숫자(3000·3101·3002)는
    //  어느 쪽도 아니라 그대로 걸린다 — 잡아야 할 것은 여전히 잡힌다.
    const both = PORTS.filter((q) => l.includes(q.env)).length > 1;
    //  ★env 이름이 없는 URL 줄은 **어느 포트인지 귀속할 수 없다**(브리지 URL 이
    //   대시보드 문서에 나오는 건 정상). 그때는 "아는 기본값 중 하나이기만" 하면
    //   통과 — 낡은 숫자(3000·3101·3002)는 어느 쪽도 아니라 그대로 걸린다.
    //   첫 판에서 이걸 안 해 정상 문서 6건을 오탐했다.
    const named = l.includes(env);
    const nums = named ? (l.match(/\b\d{4}\b/g) ?? []) : urlPort !== null ? [urlPort[1]] : [];
    // ★예시 대입의 값 **하나만** 면제한다 (2026-10-03) — 두 번째 인스턴스 안내의
    //  `HTTP_BRIDGE_PORT=7021   # 기본 7011 과 겹치지 않게`. 조건 셋: 줄 머리에서 대입한다 · 같은 줄이
    //  «기본 N»/«default N» 으로 **현재 기본값을 밝힌다** · 대입값이 **어느 포트의 기본값도 아니다**
    //  (다른 포트의 기본값이면 첫 인스턴스와 부딪히는 예시다). 그 줄의 다른 숫자는 계속 대조한다.
    //  ★첫 판은 줄 전체를 건너뛰었고(적대 검토 F1), 둘째 판은 «기본값 숫자가 어딘가 있으면» 이라
    //   «3101 이 기본값입니다 (7010 은 옛 값)» 이 통과했다(재검토 F-D). 판정은 아래 픽스처가 고정한다.
    const assigned = named && !both
      ? new RegExp(`^\\s*(?:#\\s*)?(?:export\\s+)?${env}\\s*=\\s*(\\d{4})\\b`).exec(l)?.[1]
      : undefined;
    const statesDefault = new RegExp(`(?:기본|default)\\s*${want}\\b`, "i").test(l);
    if (assigned !== undefined && statesDefault && ![...truth.values()].includes(assigned)) {
      nums.splice(nums.indexOf(assigned), 1);
    }
    const allowed = named && !both ? [want] : [...truth.values()];
    // 연도(2026 …)는 포트가 아니다 — 같은 줄에 날짜가 섞이면 오탐이 된다.
    return nums.filter((n) => !/^(19|20)\d\d$/.test(n) && !allowed.includes(n));
};

export const check: RegressionCheck = {
  name: "default-port-truth",
  guards:
    "대시보드 기본 포트가 배포값 3000 / 코드 폴백 3101 / 문서 3002 로 갈라져 여는 법을 못 적던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const truth = new Map<string, string>();

    for (const p of PORTS) {
      const m = p.re.exec(read(p.source));
      out.push(
        assert(
          `${p.what} 기본 포트 정본을 읽는다(검사 전제)`,
          m !== null,
          m === null ? `★${p.source} 에서 못 찾음 — 검사 불가` : `${p.env}=${m[1]}`,
        ),
      );
      if (m !== null) truth.set(p.env, m[1]);
    }
    if (truth.size !== PORTS.length) return out;

    // ★두 기본 포트가 겹치면 대시보드가 브리지 포트로 떠서 둘 다 못 쓴다.
    out.push(
      assert(
        "★두 기본 포트가 서로 다르다(자기 충돌 0)",
        new Set(truth.values()).size === truth.size,
        [...truth].map(([k, v]) => `${k}=${v}`).join(" "),
      ),
    );

    // ★설치 마법사가 기본 포트를 `.env` 에 **적지 않는다** — 적는 순간 두 번째 정본이 된다.
    //  (주석 안내는 정본이 아니므로 무해하다. 실제 대입만 본다.)
    const initAssigns = read("src/scripts/init.ts")
      .split("\n")
      .filter((l) => PORTS.some((p) => new RegExp(`^\\s*${p.env}=`).test(l)));
    out.push(
      assert(
        "★설치 마법사가 기본 포트를 .env 에 적지 않는다(두 번째 정본 0)",
        initAssigns.length === 0,
        initAssigns.length === 0
          ? "대입 0 — 코드가 유일한 정본"
          : `★대입 잔존: ${initAssigns.join(" / ")}`,
      ),
    );

    // ★env 이름을 **말하는 모든 추적 파일**에서, 같은 줄의 4자리 숫자는 정본과 같아야 한다.
    for (const p of PORTS) {
      const want = truth.get(p.env) as string;
      // git grep 은 **매치 0 이면 exit 1** 로 던진다(레포가 아닐 때도). 검사가 통째로
      //  죽지 않게 감싼다 — 파일이 0개면 아래 전제 단언이 그 사실을 말한다.
      let grepOut = "";
      try {
        grepOut = execFileSync("git", ["grep", "-l", p.env], { cwd: REPO, encoding: "utf8" });
      } catch {
        grepOut = "";
      }
      const files = grepOut
        .split("\n")
        .filter((f) => f !== "" && !isRecord(f))
        // 이 검사 자신은 제외(사고 이력의 옛 숫자를 본문에 적고 있다).
        // ★회귀 검사들은 통째로 제외 — 사고 이력을 본문에 적는 게 그 파일들의 일이라
        //  **옛 숫자가 남아 있는 게 정상**이다(현재값으로 고치면 기록이 거짓이 된다).
        //  docs/decisions 를 빼는 것과 같은 이유: 검사 대상은 "지금 동작을 말하는 곳" 이지
        //  "그때를 적은 곳" 이 아니다.
        .filter((f) => !f.startsWith("src/scripts/regression/"));
      out.push(
        assert(
          `${p.env} 를 말하는 파일을 찾는다(검사 전제 — 0이면 공짜 통과)`,
          files.length >= 3,
          `${files.length}개: ${files.join(" ")}`,
        ),
      );
      const wrong: string[] = [];
      for (const f of files) {
        read(f)
          .split("\n")
          .forEach((l, i) => {
            for (const n of wrongPortsInLine(l, p.env, want, truth)) wrong.push(`${f}:${i + 1} ${n}`);
          });
      }
      out.push(
        assert(
          `★${p.what} 포트를 말하는 모든 곳이 ${want} 하나를 말한다`,
          wrong.length === 0,
          wrong.length === 0
            ? `${files.length}개 파일 일치`
            : `★불일치 ${wrong.length}건: ${wrong.join(" / ")}`,
        ),
      );
    }

    // ★`bin/daemon.mjs` 는 의존성-프리라 상수를 못 받는다 — 리터럴이 정본과 같은지만 본다.
    //  (어긋나면 데몬 CLI 가 엉뚱한 포트로 헬스체크해 "죽었다" 고 오진한다.)
    const cli = /process\.env\.HTTP_BRIDGE_PORT\?\.trim\(\) \|\| "(\d+)"/.exec(
      read("bin/daemon.mjs"),
    );
    out.push(
      assert(
        "★의존성-프리 CLI(bin/daemon.mjs)의 브리지 포트가 정본과 같다",
        cli?.[1] === truth.get("HTTP_BRIDGE_PORT"),
        `cli=${String(cli?.[1])} 정본=${String(truth.get("HTTP_BRIDGE_PORT"))}`,
      ),
    );

    // ★사용자가 실제로 신고한 것 — **여는 법이 공개 README 에 적혀 있는가**.
    //  포트가 하나로 정리돼도 URL 을 안 적어두면 신고는 그대로다. 영/한 양쪽을 본다.
    const dash = truth.get("DASHBOARD_PORT") as string;
    // ★공개 README 는 **레포마다 자리가 다르다** — dev 는 오버레이(`_workspace/public-overlay/`)가
    //  정본이고 배포 레포엔 그게 루트 `README.md` 로 복사돼 있다(오버레이 자체는 EXCLUDE).
    //  종전엔 오버레이 경로만 읽어 **배포 레포 CI 에서 ENOENT 로 검사가 통째로 던졌다**
    //  (2026-08-02, 하루 8번 push 하도록 CI 를 안 봐서 몰랐다). 있는 쪽을 읽는다.
    const readEither = (overlay: string, shipped: string): string | null => {
      for (const f of [overlay, shipped]) {
        try {
          return readFileSync(path.join(REPO, f), "utf8");
        } catch {
          /* 다음 후보 */
        }
      }
      return null;
    };
    for (const [f, shipped] of [
      ["_workspace/public-overlay/README.md", "README.md"],
      ["_workspace/public-overlay/README.ko.md", "README.ko.md"],
    ] as const) {
      const src = readEither(f, shipped);
      if (src === null) {
        out.push(assert(`${path.basename(f)} 를 찾는다`, false, "★양쪽 경로 모두 없음"));
        continue;
      }
      const hasUrl = src.includes(`http://127.0.0.1:${dash}`);
      // 로컬 바인딩이라는 사실도 같이 있어야 한다 — 없으면 포트를 열어버린다(보안).
      const hasBind = /127\.0\.0\.1/.test(src) && /DASHBOARD_HOST/.test(src);
      out.push(
        assert(
          `★${path.basename(f)} 에 대시보드 여는 URL 과 로컬 전용 안내가 있다`,
          hasUrl && hasBind,
          `URL=${hasUrl} 바인딩안내=${hasBind}`,
        ),
      );
    }
    // ★예시 대입 면제를 **문서와 무관하게** 고정한다(재검토 F-E). 정상 예시 둘은 통과, 낡은 줄은 전부 걸린다.
    const fx = (l: string, env = "HTTP_BRIDGE_PORT"): string[] => wrongPortsInLine(l, env, truth.get(env) as string, truth);
    const b = truth.get("HTTP_BRIDGE_PORT") as string;
    const dsh = truth.get("DASHBOARD_PORT") as string;
    const okLines = [`   HTTP_BRIDGE_PORT=7021   # 기본 ${b} 과 겹치지 않게`, `   DASHBOARD_PORT=7020     # default ${dsh} — pick another`];
    const staleLines: [string, string?][] = [
      [`HTTP_BRIDGE_PORT 는 기본 ${b}, 대시보드는 기본 3000 입니다.`],
      [`HTTP_BRIDGE_PORT=7021  # 기본 ${b} · 열기 http://localhost:3000`],
      [`HTTP_BRIDGE_PORT=3000   # 기본값 · 게이트웨이 http://127.0.0.1:${b}/v1`],
      [`DASHBOARD_PORT=3101     # 이게 기본값입니다 (${dsh} 은 옛 값)`, "DASHBOARD_PORT"],
      [`export HTTP_BRIDGE_PORT=3001 # 브리지 기본값, ${b} 로 두면 안 됨`],
      [`DASHBOARD_PORT=${b}     # 기본 ${dsh} 과 겹치지 않게`, "DASHBOARD_PORT"],
      [`HTTP_BRIDGE_PORT=3000`],
    ];
    const fxOk = okLines.map((l, k) => fx(l, k === 0 ? "HTTP_BRIDGE_PORT" : "DASHBOARD_PORT"));
    const fxStale = staleLines.map(([l, env]) => ({ l, wrong: fx(l, env) }));
    out.push(
      assert(
        "★예시 대입 면제: «기본 N» 을 밝힌 바꾼 값만 통과 · 같은 줄의 낡은 숫자·URL·다른 포트의 기본값·«기본값» 만 적은 줄은 걸린다",
        fxOk.every((w) => w.length === 0) && fxStale.every((x) => x.wrong.length > 0),
        { fxOk, fxStale: fxStale.filter((x) => x.wrong.length === 0).map((x) => x.l) },
      ),
    );
    return out;
  },
};
