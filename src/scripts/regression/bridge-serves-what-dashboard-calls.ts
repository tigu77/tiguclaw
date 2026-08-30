/**
 * 회귀: **대시보드가 부르는 라우트를 브리지가 실제로 낸다** (2026-08-30).
 *
 * 왜 지금: `plugins/http-bridge/index.ts` 를 쪼개는 중이다(3,905줄 · `handleRequest` 하나가
 * 2,970줄 · 라우트 블록 52개). 결합도를 재보니 낮아서(공유 지역 변수 4 · `this` 멤버 4)
 * 대부분은 **기계적 이동**이고, 빠뜨린 의존은 **타입체커가 잡는다.**
 *
 * ★그런데 타입체커가 못 잡는 게 하나 있다 — **라우트가 조용히 사라지는 것.** 블록을
 *  옮겼는데 등록을 빠뜨리면 그냥 죽은 코드가 되고, 컴파일도 스위트도 통과한다. 사용자
 *  화면에서만 404 로 나타난다. 이 검사가 정확히 그 하나를 막는다.
 *
 * ★**스냅샷 목록을 안 만든다.** "지금 52개" 를 적어두면 그건 손으로 관리하는 목록이고,
 *  라우트를 정당하게 늘릴 때마다 숫자를 고쳐야 한다([[feedback_hand_maintained_lists]]).
 *  대신 **계약**을 본다: *"화면이 부르는 것을 서버가 내는가."* 소비자가 정의점이라
 *  리팩터로 파일이 몇 개로 갈리든, 라우트가 늘든 줄든 그대로 성립한다.
 *
 * ★생산자를 **디렉터리 전체**에서 찾는다 — 지금은 파일 하나지만 쪼개면 여러 개가 된다.
 *  파일 이름을 적으면 그 순간 이 검사가 분할을 막는다.
 *
 * 등급: 소스 대조(양쪽 모두). 지키는 것은 "부르는 이름이 서버에 있는가" 한 가지이고,
 * 그 라우트가 **옳게 동작하는가**는 각 기능의 회귀가 본다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BRIDGE = path.join(REPO, "plugins/http-bridge");
const DASH = path.join(REPO, "packages/dashboard");

const filesUnder = (dir: string, ext: RegExp): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist" || name === "web") continue;
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (ext.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
};

const readAll = (files: string[]): string =>
  files.map((f) => readFileSync(f, "utf8")).join("\n");

export const check: RegressionCheck = {
  name: "bridge-serves-what-dashboard-calls",
  guards:
    "http-bridge 를 쪼개다 라우트 블록을 옮기고 **등록을 빠뜨리는 것** — 그러면 죽은 코드가 되어 타입체크도 스위트도 통과하고, 사용자 화면에서만 404 로 나타난다(3,905줄 · handleRequest 2,970줄 · 라우트 52개를 분할하는 중이라 지금이 가장 위험한 시기다)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    const bridgeFiles = filesUnder(BRIDGE, /\.ts$/);
    const bridgeSrc = readAll(bridgeFiles);
    const dashFiles = filesUnder(DASH, /\.(js|ts)$/);
    const dashSrc = readAll(dashFiles);

    out.push(
      assert(
        `★생산자를 **디렉터리 전체**에서 찾는다(파일 이름을 적으면 그 검사가 분할을 막는다) — http-bridge ${String(bridgeFiles.length)}개 · dashboard ${String(dashFiles.length)}개`,
        bridgeFiles.length > 0 && dashFiles.length > 0,
        `${bridgeFiles.map((f) => path.basename(f)).join(", ")}`,
      ),
    );

    // ── 소비자: 화면이 부르는 `/api/...` ────────────────────────────────────
    const called = new Set<string>();
    for (const m of dashSrc.matchAll(/["'`]\/api(\/[a-z0-9/_-]+)/g)) called.add(m[1]!);
    out.push(
      assert(
        "화면이 부르는 `/api/…` 를 찾을 수 있다(0이면 이 검사가 공짜로 통과한다)",
        called.size >= 40,
        `${String(called.size)}개`,
      ),
    );

    // ── 생산자: 브리지가 다루는 정확 경로 + 프리픽스 ────────────────────────
    // ★**핸들러 모양만** 센다 — `if (pathname === …)`. 종전엔 `pathname === "x"` 를 통째로
    //  세서 **권한 표(삼항 연쇄)까지 생산자로 셌고**, 그래서 핸들러를 지우는 변이가 살아
    //  남았다(표에 이름이 남아 있으니 "있다"로 읽혔다). 표는 등급을 정할 뿐 요청을 처리하지
    //  않는다 — 둘을 같은 것으로 세면 이 검사의 축이 통째로 무의미해진다.
    const exact = new Set<string>();
    for (const m of bridgeSrc.matchAll(/if \(\s*pathname === "([^"]+)"/g)) exact.add(m[1]!);
    const prefixes: string[] = [];
    for (const m of bridgeSrc.matchAll(/if \(\s*pathname\.startsWith\("([^"]+)"\)/g)) {
      prefixes.push(m[1]!);
    }
    out.push(
      assert(
        `브리지가 내는 경로를 찾을 수 있다 — 정확 ${String(exact.size)}개 · 프리픽스 ${String(prefixes.length)}개`,
        exact.size >= 40,
        `프리픽스: ${[...new Set(prefixes)].join(", ")}`,
      ),
    );

    // ── 계약 ────────────────────────────────────────────────────────────────
    // ★프리픽스 라우트(`/plugin-data/`·`/attachments/`)는 그 아래 임의 경로를 다룬다 —
    //  화면이 `/plugin-data/weather/forecast` 를 불러도 정상이다.
    const missing = [...called]
      .filter((c) => !exact.has(c))
      .filter((c) => !prefixes.some((p) => c.startsWith(p)))
      .sort();
    out.push(
      assert(
        "★★화면이 부르는 라우트를 **서버가 전부 낸다** — 쪼개다 하나를 빠뜨리면 컴파일도 스위트도 통과하고 사용자 화면에서만 404 가 된다",
        missing.length === 0,
        missing.length === 0
          ? `화면이 부르는 ${String(called.size)}개 전부 실재(정확 ${String(exact.size)} + 프리픽스 ${String(new Set(prefixes).size)})`
          : `★서버에 없음: ${missing.join(", ")}`,
      ),
    );

    return out;
  },
};
