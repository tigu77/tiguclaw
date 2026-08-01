/**
 * 회귀: **대시보드 포트를 말하는 곳이 전부 같은 숫자를 말한다** (2026-08-01 사용자 신고).
 *
 * 신고: "대시보드가 엄청 중요한데 띄우는 방법이 안 써있네 README에". 파 보니 문서 누락
 * 하나가 아니라 **같은 값이 네 곳에서 갈렸다** — 두 달을 그렇게 살았다:
 *   설치 마법사·`.env.example`·`plugins/http-bridge/README.md` `3000`(= 실제로 배포된 값) /
 *   코드 폴백 `3101` / `packages/dashboard/README.md` `3002`
 * 그래서 **문서에 한 숫자를 쓸 수가 없었다.** 여는 법이 안 적힌 진짜 이유가 이거다.
 *
 * ★뿌리는 `fa69120`(2026-06-11 대시보드 자동시작): 코드 폴백만 `3000`→`3101` 로 바뀌고
 *  마법사·예제·문서는 `3000` 에 남았다. 3101 은 **개발 기계 배치**(거기선 3000 이 브리지)가
 *  코드 기본값으로 새어 든 것이었다 — 제품 기본값은 `3000` 이다.
 *
 * ★고친 방식 = 숫자를 맞추는 게 아니라 **중복을 없앤다**. 마법사와 `.env.example` 은 기본
 *  포트를 적지 않고(주석 안내만), 코드 기본값 하나가 정본이다. 적어두는 순간 갈라진다.
 *
 * ★이 검사는 이름을 열거하지 않는다 — `DASHBOARD_PORT` 를 **말하는 모든 추적 파일**을 찾아
 *  거기 적힌 숫자가 코드 기본값과 같은지 본다. 새 파일이 생겨도 저절로 걸린다.
 *  기록물(`docs/decisions/`·dev `README.md`·스크래치)은 **당시**를 적은 것이라 제외한다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "dashboard-port-truth",
  guards:
    "대시보드 포트가 배포값 3000 / 코드 폴백 3101 / 문서 3002 로 갈라져 여는 법을 못 적던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★정본 — 데몬이 실제로 띄우는 포트. 여기가 진실이고 나머지는 이것을 따른다.
    const pluginSrc = read("plugins/dashboard/index.ts");
    const m = /const DEFAULT_DASHBOARD_PORT = "(\d+)"/.exec(pluginSrc);
    out.push(
      assert(
        "코드 기본값을 읽는다(검사 전제)",
        m !== null,
        m === null ? "★DEFAULT_DASHBOARD_PORT 를 못 찾음 — 검사 불가" : `${m[1]}`,
      ),
    );
    if (m === null) return out;
    const PORT = m[1];

    // 대시보드 프로세스(별도 패키지 — src 를 import 하지 않는 격리)도 같은 폴백이어야 한다.
    //  단독 실행(`npm run dashboard`) 시 이 값이 쓰인다.
    const svcSrc = read("packages/dashboard/index.ts");
    const svc = /process\.env\.DASHBOARD_PORT \?\? "(\d+)"/.exec(svcSrc);
    out.push(
      assert(
        "★띄우는 쪽과 서빙하는 쪽의 기본 포트가 같다",
        svc?.[1] === PORT,
        `plugins=${PORT} packages=${String(svc?.[1])}`,
      ),
    );

    // ★설치 마법사가 기본 포트를 `.env` 에 **적지 않는다** — 적는 순간 두 번째 정본이 된다.
    //  (주석으로 안내하는 건 정본이 아니므로 무해하다. 실제 대입만 본다.)
    const init = read("src/scripts/init.ts");
    const assigns = init
      .split("\n")
      .filter((l) => /^\s*DASHBOARD_PORT=/.test(l) || /^\s*HTTP_BRIDGE_PORT=/.test(l));
    out.push(
      assert(
        "★설치 마법사가 기본 포트를 .env 에 적지 않는다(두 번째 정본 0)",
        assigns.length === 0,
        assigns.length === 0 ? "대입 0 — 코드 기본값이 유일한 정본" : `★대입 잔존: ${assigns.join(" / ")}`,
      ),
    );

    // ★`DASHBOARD_PORT` 를 **말하는 모든 추적 파일**에서, 같은 줄의 4자리 숫자는 정본과 같아야
    //  한다. 이름을 열거하지 않으므로 새 파일이 생겨도 저절로 걸린다.
    const tracked = execFileSync("git", ["grep", "-l", "DASHBOARD_PORT"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f !== "")
      // ★기록물은 제외 — **당시**를 적은 것이라 현재값으로 고치면 오히려 거짓이 된다.
      //  판정 기준은 "사용자가 보는가": `docs/decisions/`·dev `README.md` 하단 라운드 로그·
      //  `_workspace/` 스크래치는 전부 배포되지 않는다(sync manifest EXCLUDE 와 같은 선).
      //  단 `public-overlay/` 는 **공개 README 그 자체**라 포함한다.
      .filter(
        (f) =>
          !f.startsWith("docs/decisions/") &&
          f !== "README.md" &&
          (!f.startsWith("_workspace/") || f.startsWith("_workspace/public-overlay/")),
      )
      // 이 검사 자신은 제외(사고 이력을 본문에 적고 있다).
      .filter((f) => !f.endsWith("dashboard-port-truth.ts"));
    out.push(
      assert(
        "DASHBOARD_PORT 를 말하는 파일을 찾는다(검사 전제 — 0이면 공짜 통과)",
        tracked.length >= 3,
        `${tracked.length}개: ${tracked.join(" ")}`,
      ),
    );
    const wrong: string[] = [];
    for (const f of tracked) {
      const lines = read(f).split("\n");
      lines.forEach((l, i) => {
        if (!l.includes("DASHBOARD_PORT")) return;
        for (const n of l.match(/\b\d{4}\b/g) ?? []) {
          // 연도(2026 …)는 포트가 아니다 — 같은 줄에 날짜가 섞이면 오탐이 된다.
          if (/^(19|20)\d\d$/.test(n)) continue;
          if (n !== PORT) wrong.push(`${f}:${i + 1} ${n}`);
        }
      });
    }
    out.push(
      assert(
        `★대시보드 포트를 말하는 모든 곳이 ${PORT} 하나를 말한다`,
        wrong.length === 0,
        wrong.length === 0 ? `${tracked.length}개 파일 일치` : `★불일치 ${wrong.length}건: ${wrong.join(" / ")}`,
      ),
    );

    // ★사용자가 실제로 신고한 것 — **여는 법이 공개 README 에 적혀 있는가**.
    //  포트가 하나로 정리돼도 URL 을 안 적어두면 신고는 그대로다. 영/한 양쪽을 본다.
    for (const f of ["_workspace/public-overlay/README.md", "_workspace/public-overlay/README.ko.md"]) {
      const src = read(f);
      const hasUrl = src.includes(`http://127.0.0.1:${PORT}`);
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
