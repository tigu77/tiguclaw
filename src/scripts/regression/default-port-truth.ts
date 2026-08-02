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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

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
    source: "plugins/http-bridge/index.ts",
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
        .filter((f) => !f.endsWith("default-port-truth.ts"));
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
            if (!l.includes(p.env)) return;
            // ★한 줄이 **두 포트를 같이** 말하는 경우가 있다(예: "DASHBOARD_PORT(기본 X)·
            //  HTTP_BRIDGE_PORT 는 …"). 그 줄의 숫자를 한쪽에 귀속시킬 수 없으므로, 그때는
            //  **아는 기본값 중 하나이기만** 하면 통과시킨다. 낡은 숫자(3000·3101·3002)는
            //  어느 쪽도 아니라 그대로 걸린다 — 잡아야 할 것은 여전히 잡힌다.
            const both = PORTS.filter((q) => l.includes(q.env)).length > 1;
            const ok = both ? [...truth.values()] : [want];
            for (const n of l.match(/\b\d{4}\b/g) ?? []) {
              // 연도(2026 …)는 포트가 아니다 — 같은 줄에 날짜가 섞이면 오탐이 된다.
              if (/^(19|20)\d\d$/.test(n)) continue;
              if (!ok.includes(n)) wrong.push(`${f}:${i + 1} ${n}`);
            }
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
    return out;
  },
};
