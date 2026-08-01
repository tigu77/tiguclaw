/**
 * 회귀: **로그만으로 진단이 서야 한다** (2026-08-01, A4b·A4c).
 *
 * 이 프로젝트의 1차 진단면은 로그다 — 회사 PC·윈도우는 원격 접속이 안 되고, 결국 로그다.
 * 그런데 두 방향으로 무너져 있었다.
 *
 *  ①**있어야 할 줄이 없다.** `[env] loaded …` 는 `load-env.ts` 의 **import 부작용**이라
 *   진입점의 `initFileLogging()` 보다 먼저 돌았다 → 데몬 로그 파일에 **부팅 206회 중 0건**
 *   (launchd.out 에만 373건). 하필 "어느 `.env` 를 쓰는가" 는 봇 토큰 409 충돌 사고의
 *   전제였고, 윈도우엔 launchd.out 자체가 없어 **어디에도 안 남았다**.
 *
 *  ②**없어야 할 줄이 에러를 채운다.** `migrateLegacyAgent skip` 은 **정상 상태**인데
 *   `error` 였다 — 12일치 실측 546줄. node 의 `punycode` DeprecationWarning 도 stderr
 *   직행이라 `[error]` 로 527줄. 둘이 에러 로그의 큰 덩어리를 차지하면 진짜 사고가
 *   배경 소음에 묻힌다.
 *
 * ★소스 정규식으로는 이걸 못 본다 — 종전에도 `console.log` 호출은 멀쩡히 **있었다**.
 *  문제는 그게 **언제** 불리느냐였다. 그래서 자식 프로세스를 띄워 **실제로 찍힌 것**을 본다.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, within, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "log-diagnosability",
  guards:
    "어느 .env 를 썼는지가 데몬 로그에 영원히 안 남고, 정상 상태·node 경고가 [error] 를 채워 진짜 사고를 덮던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const child = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "_log-diag-child.ts",
    );
    const r = await within(
      60_000,
      "로거 자식 실행",
      new Promise<{ out: string; err: string; logPath: string }>((resolve) => {
        const p = spawn(process.execPath, ["--import", "tsx", child], {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
        let so = "";
        let se = "";
        p.stdout.on("data", (d: Buffer) => (so += d.toString()));
        p.stderr.on("data", (d: Buffer) => (se += d.toString()));
        p.on("close", () =>
          resolve({ out: so, err: se, logPath: (so.match(/LOGFILE=(.+)/) ?? [])[1] ?? "" }),
        );
        p.on("error", () => resolve({ out: "", err: "", logPath: "" }));
      }),
    );
    const cap = "value" in r ? r.value : { out: "", err: "", logPath: "" };
    const fileText =
      cap.logPath === "" ? "" : await readFile(cap.logPath.trim(), "utf8").catch(() => "");

    out.push(
      assert(
        "자식이 로그 파일을 만들었다(검사 전제)",
        fileText !== "",
        cap.logPath === "" ? "LOGFILE 미출력 — 하네스 고장" : `${fileText.length}자`,
      ),
    );

    // ★① env 요약이 **로그 파일에** 남는다. 표준출력에만 있으면 윈도우에선 사라진다.
    const envLine = fileText.split("\n").find((l) => l.includes("[env] "));
    out.push(
      assert(
        "★`[env] …` 가 데몬 로그 **파일**에 남는다(부팅 206회 중 0건이던 것)",
        envLine !== undefined,
        envLine?.slice(0, 100) ?? "파일에 [env] 줄 없음",
      ),
    );
    out.push(
      assert(
        "env 줄이 한 번만 남는다(명시 flush + microtask 폴백 중복 0)",
        fileText.split("\n").filter((l) => l.includes("[env] ")).length === 1,
        `${fileText.split("\n").filter((l) => l.includes("[env] ")).length}건`,
      ),
    );

    // ★② 정상 상태는 error 가 아니다.
    const errLines = fileText.split("\n").filter((l) => l.includes("] [error]"));
    const normalAsError = errLines.filter(
      (l) => l.includes("migrateLegacyAgent skip") || l.includes("DeprecationWarning"),
    );
    out.push(
      assert(
        "★정상 상태·node 경고가 [error] 로 안 찍힌다(에러 로그의 73%를 차지하던 것)",
        normalAsError.length === 0,
        normalAsError.length === 0
          ? `[error] ${errLines.length}줄 — 정상상태 0`
          : `★여전히 error: ${normalAsError[0].slice(0, 90)}`,
      ),
    );
    // 버리지는 않는다 — 레벨만 내린다. 신호 자체가 사라지면 그건 다른 종류의 실명이다.
    out.push(
      assert(
        "★그래도 경고는 남는다(레벨만 내렸지 버리지 않았다)",
        fileText.includes("[node-warning]") && fileText.includes("[warn]"),
        (fileText.split("\n").find((l) => l.includes("[node-warning]")) ?? "없음").slice(0, 90),
      ),
    );
    // 반복은 센다 — 같은 경고가 매번 찍히면 그게 배경 소음이 된다.
    out.push(
      assert(
        "★같은 경고 반복은 부팅당 1줄로 접힌다(배경 소음 0)",
        fileText.split("\n").filter((l) => l.includes("[node-warning]")).length === 1,
        `${fileText.split("\n").filter((l) => l.includes("[node-warning]")).length}줄`,
      ),
    );
    return out;
  },
};
