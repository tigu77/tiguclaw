/**
 * 회귀: **브리지에 못 닿았을 때 «왜» 가 남는가** (2026-09-18, 회사돌쇠 조사).
 *
 * ★사고: 대시보드가 `502 bridge unreachable: fetch failed` 를 냈다. 데몬도 대시보드도
 *  죽지 않았고 앞뒤로 작업 로그가 이어졌는데, **어느 요청이 무슨 코드로 실패했는지가
 *  아무 데도 없어** 원인을 확정할 수 없었다.
 *
 * ★★`fetch failed` 는 **껍데기**다 — Node 는 진짜 원인을 `cause` 에 넣어 감싼다
 *  (`ECONNREFUSED ::1:7011` 같은 것이 한 겹 아래에 있다). 같은 날 Windows 실행부에서 고친
 *  «CLIXML 이 오류를 가린다» 와 **같은 부류**다: 있는 정보를 안 꺼내 쓰는 것.
 *
 * ★그리고 **기본값 불일치**가 같이 나왔다 — 브리지는 `127.0.0.1` 을 듣는데 대시보드는
 *  `localhost` 로 걸었다(같은 환경변수 이름, 다른 기본값). Windows 에서 `localhost` 는
 *  `::1` 을 먼저 가리킨다. 이 검사는 **두 기본값이 같은지**도 소스에서 본다.
 *
 * ★토큰·본문은 안 싣는다 — 경로·코드·간단한 메시지까지다.
 */
import { readFile } from "node:fs/promises";
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

interface Mod {
  describeFetchFailure: (e: unknown) => string;
  bridgeFailureLog: (target: string, path: string, e: unknown) => string;
}

export const check: RegressionCheck = {
  name: "bridge-failure-names-its-cause",
  guards:
    "대시보드가 브리지에 못 닿았을 때 «fetch failed» 껍데기만 남기고 진짜 원인(ECONNREFUSED 등)·요청 경로를 안 적어, 사고 뒤에 원인을 확정할 수 없던 것 · 브리지와 대시보드의 기본 주소가 갈려 IPv6 경로가 열리던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { describeFetchFailure, bridgeFailureLog } = await loadPluginModule<Mod>(
      "../../../packages/dashboard/bridge-error.ts",
    );

    // ── ① 껍데기 밑의 진짜 원인을 꺼낸다 ──────────────────────────────────
    const real = Object.assign(new Error("connect ECONNREFUSED ::1:7011"), {
      code: "ECONNREFUSED",
    });
    const wrapped = Object.assign(new Error("fetch failed"), { cause: real });
    const got = describeFetchFailure(wrapped);
    out.push(
      assert(
        "★★`fetch failed` 밑의 **진짜 원인**을 꺼낸다 — 껍데기만 남기면 사후에 못 짚는다",
        got.includes("ECONNREFUSED") && got.includes("::1:7011"),
        got,
      ),
    );
    out.push(
      assert(
        "겉 메시지도 **버리지 않는다**(사슬을 보여준다)",
        got.includes("fetch failed"),
        got,
      ),
    );

    // ── ② 무엇을 부르다 실패했는지 ────────────────────────────────────────
    const line = bridgeFailureLog("127.0.0.1:7011", "/messages", wrapped);
    out.push(
      assert(
        "★로그가 **요청 경로와 대상**을 같이 적는다 — 그게 없으면 «어느 요청» 이 안 남는다",
        line.includes("/messages") && line.includes("127.0.0.1:7011") && line.includes("ECONNREFUSED"),
        line,
      ),
    );

    // ── ③ 방어 — 사슬이 없거나 순환이어도 죽지 않는다 ────────────────────
    // ★**두 칸짜리 순환**으로 잰다 (자기 변이로 적발). 자기참조(`a.cause = a`)는 «같은
    //  객체» 검사에서 걸려서, 그것만 쓰면 **깊이 상한이 하나도 안 재어진다** — 상한을
    //  없애는 변이가 통과했다. a→b→a 여야 상한이 유일한 방어다.
    const a: { message: string; cause?: unknown } = { message: "가 오류" };
    const b: { message: string; cause?: unknown } = { message: "나 오류", cause: a };
    a.cause = b;
    // ★**정직하게**: 여기서 재는 것은 «순환을 끝까지 따라가 둘 다 담고 멈춘다» 이지
    //  «무한 루프에 안 빠진다» 가 아니다. 동기 무한 루프는 이벤트 루프를 막아서
    //  **검사 안에서 잡을 방법이 없다**(타이머가 안 돈다 — 실제로 시도했다).
    //  그건 방문 집합과 깊이 상한 **둘이** 막고, 여기서는 그 결과만 본다.
    const looped = describeFetchFailure(a);
    out.push(
      assert(
        "★원인이 **순환**(가→나→가)이어도 둘을 담고 멈춘다 — 되돌아온 곳을 다시 안 간다",
        looped.includes("가 오류") && looped.includes("나 오류") && looped.length < 400,
        looped.slice(0, 100),
      ),
    );
    out.push(
      assert(
        "원인이 없거나 값이 아니어도 문자열을 낸다",
        describeFetchFailure(new Error("단순 오류")).includes("단순 오류") &&
          describeFetchFailure(undefined).length > 0,
        `${describeFetchFailure(new Error("단순 오류"))} / ${describeFetchFailure(undefined)}`,
      ),
    );

    // ── ④ 브리지와 대시보드의 **기본 주소가 같은가** ──────────────────────
    //  ★같은 환경변수 이름인데 기본값이 달랐다. 한쪽만 고치면 다시 갈린다.
    const dash = await readFile(new URL("../../../packages/dashboard/index.ts", import.meta.url), "utf8");
    const bridge = await readFile(new URL("../../../plugins/http-bridge/index.ts", import.meta.url), "utf8");
    const dashHost = /HTTP_BRIDGE_HOST\s*\?\?\s*"([^"]+)"/.exec(dash)?.[1];
    const bridgeHost = /HTTP_BRIDGE_HOST\?\.trim\(\)\s*\|\|\s*"([^"]+)"/.exec(bridge)?.[1];
    out.push(
      assert(
        "★**거는 쪽과 듣는 쪽의 기본 주소가 같다** — 갈리면 `localhost`→IPv6 경로가 열린다",
        dashHost !== undefined && bridgeHost !== undefined && dashHost === bridgeHost,
        `대시보드=${String(dashHost)} · 브리지=${String(bridgeHost)}`,
      ),
    );
    return out;
  },
};
