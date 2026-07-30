/**
 * 회귀: **실행 중인 코드가 소스보다 오래되면 /status 가 말한다** (2026-07-30).
 *
 * 사고: 원격 인스턴스에서 같은 증상이 반복되는데 "그쪽이 업데이트를 받았나" 를 확인하려
 * `/status` 의 빌드 해시를 봤다. 그런데 그 값은 `git log` 로 읽은 **소스 HEAD** 이고,
 * built 런타임은 `dist/` 를 돈다 — `git pull` 은 됐는데 재빌드가 실패하면
 * **`/status` 는 "최신" 이라 하고 실제로는 옛 코드가 돈다.**
 * 실제로 반나절을 그 위에서 논쟁했다: 로그 분석은 "옛 버전", 사용자는 "이미 최신 빌드였어"
 * — **둘 다 맞았을 수 있다**(git 최신 · 실행 옛것).
 *
 * 같은 부류가 메모리에 두 건 더 있다(윈도우 /update tsc 미설치로 재빌드 실패, built
 * /update 의 appRoot=dist 함정). **빌드 실패가 조용한 게 반복 패턴**이라 그물을 건다.
 *
 * 순수 판정 로직이 아니라 **관측 가능성**을 지키는 검사다 — 배선이 빠지면 그 반나절이 돌아온다.
 */
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "stale-build-visible",
  guards:
    "git 은 최신인데 dist 가 옛것이면 /status 가 '최신' 이라 답해 진단이 반나절 헛돌던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // 판정 본체 — dist 진입점 mtime vs HEAD 커밋 시각.
    const impl = await sourceHas("../../core/version.ts", [
      /export const staleBuildWarning = \(\): string =>/,
      // ★dist 에서 로드됐을 때만 판정한다. 종전엔 `TIGUCLAW_RUNTIME === "source"` 를 봤는데
      //  그 변수는 built 에서만 세팅돼, tsx·npm run dev(변수 없음)에서 옛 dist 를 재고
      //  거짓 경고를 냈다. 이름 열거 대신 자명한 사실(내가 어디서 로드됐나)을 본다.
      /import\.meta\.url\.includes\("\/dist\/"\)/,
      // /status 한 번에 두 번 불린다 — git 자식 프로세스가 매번 두 번 뜨지 않게 캐시.
      /STALE_CACHE_MS/,
      // 실행 산출물의 시각을 실제로 잰다(선언만 하고 안 재는 것 방지).
      /statSync\(distEntry\)\.mtimeMs/,
      /\["log", "-1", "--format=%cI"\]/,
      /distMs >= headMs\) return answer\(""\)/,
      // dist 자체가 없으면 그것도 말한다.
      /dist 산출물이 없습니다/,
    ]);
    out.push(
      assert(
        "★dist mtime 과 HEAD 커밋 시각을 비교해 판정한다",
        impl.ok,
        impl.ok ? "7개 확인" : `누락 ${impl.missing.join(" ")}`,
      ),
    );

    // ★배선 — 판정만 있고 /status 가 안 부르면 아무도 못 본다(오늘의 교훈: 방어 코드가
    //  있다 ≠ 그 조건이 실제로 참이 된다·실제로 보인다).
    const wired = await sourceHas("../../index.ts", [
      /staleBuildWarning/,
      /staleBuildWarning\(\) !== ""/,
    ]);
    out.push(
      assert(
        "★/status 가 그 경고를 실제로 출력한다",
        wired.ok,
        wired.ok ? "배선 확인" : `누락 ${wired.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
