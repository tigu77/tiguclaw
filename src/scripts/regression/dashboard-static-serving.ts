/**
 * 회귀: **index.html 이 요구하는 자산이 실제로 서빙된다** (2026-08-01 아이콘 적용 중).
 *
 * 대시보드는 화이트리스트 방식으로 서빙한다 — `pathname === "/app.css"` 처럼 **경로마다
 * 라우트를 손으로 단다**. 그래서 새 자산을 index.html 에 참조만 하고 라우트를 안 달면
 * **404 인데 아무도 모른다**:
 *   - `.js` 는 즉시 티가 나지만(화면이 안 뜬다) `favicon`·이미지는 **조용히** 빈 채로 뜬다.
 *   - 실제로 오늘 `js/_manifest.json` 과 `<script>` 태그가 **양방향으로** 어긋나 있었고
 *     (한쪽은 404, 한쪽은 죽은 파일), 브랜드 아이콘은 라우트 자체가 없었다.
 *
 * ★"라우트 문자열이 소스에 있나" 를 보지 않는다 — **진짜로 띄워서 GET 한다**. 문자열 확인은
 *  경로 오타·읽기 실패·Content-Type 오류를 전부 통과시킨다(오늘 그런 검사를 여러 건 걷어냈다).
 *
 * ★목록을 손으로 들지 않는다 — index.html 에서 `href`/`src="/…"` 를 **뽑아서** 전수 확인한다.
 *  새 자산을 추가하면 저절로 포함된다(빠뜨릴 수가 없다).
 *
 * 격리: bridge 없이 대시보드 프로세스만 임의 빈 포트로 띄운다(정적 서빙은 bridge 무관).
 *  토큰은 합성값 — 실제 어디에도 안 붙는다.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 임의 빈 포트 하나 — 잠깐 열었다 닫아서 확실히 비어 있는 번호를 얻는다(추측 금지). */
const freePort = async (): Promise<number> => {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const check: RegressionCheck = {
  name: "dashboard-static-serving",
  guards:
    "index.html 이 참조하는 자산에 서빙 라우트가 없어 404 인데 조용하던 것(아이콘·새 js 모듈)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const dash = path.join(REPO, "packages/dashboard");

    // ★목록은 index.html 에서 뽑는다 — 손으로 들면 새 자산을 빠뜨린다.
    const html = readFileSync(path.join(dash, "index.html"), "utf8");
    const assets = [
      ...new Set(
        [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)]
          .map((m) => m[1])
          // 외부 링크·데이터 URI 는 대상이 아니다(로컬 자산만).
          .filter((u) => !u.startsWith("//")),
      ),
    ];
    out.push(
      assert(
        "index.html 에서 로컬 자산 목록을 뽑는다(검사 전제 — 0이면 공짜 통과)",
        assets.length >= 10,
        `${assets.length}개 (js 모듈 + css + 아이콘 + vendored)`,
      ),
    );
    if (assets.length < 10) return out;

    const port = await freePort();
    const child = spawn(
      process.execPath,
      [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(dash, "index.ts")],
      {
        env: {
          ...process.env,
          DASHBOARD_PORT: String(port),
          DASHBOARD_HOST: "127.0.0.1",
          // 합성 토큰 — 정적 서빙은 bridge 를 안 탄다. 실제 자격증명 아님.
          HTTP_BRIDGE_TOKEN: "regression-static-serving",
          HTTP_BRIDGE_PORT: String(await freePort()), // 붙을 bridge 없음(정적만 본다)
        },
        stdio: "ignore",
      },
    );
    try {
      // 기동 대기 — 뜰 때까지 짧게 폴링(고정 sleep 은 느리거나 불안정하다).
      let up = false;
      for (let i = 0; i < 60 && !up; i += 1) {
        await sleep(100);
        try {
          await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) });
          up = true;
        } catch {
          /* 아직 */
        }
      }
      out.push(
        assert(
          "대시보드 프로세스가 실제로 뜬다(검사 전제)",
          up,
          up ? `127.0.0.1:${port}` : "★기동 실패 — 아래 단언들은 의미 없음",
        ),
      );
      if (!up) return out;

      const bad: string[] = [];
      for (const a of assets) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}${a}`, {
            signal: AbortSignal.timeout(2000),
          });
          const len = (await r.arrayBuffer()).byteLength;
          // 200 이어도 본문이 비면 서빙된 게 아니다(읽기 실패를 200 으로 덮는 경우).
          if (!r.ok || len === 0) bad.push(`${a} → ${r.status}/${len}B`);
        } catch (e) {
          bad.push(`${a} → ${(e as Error).message}`);
        }
      }
      out.push(
        assert(
          `★index.html 이 요구하는 자산 ${assets.length}개가 전부 서빙된다(404 조용한 실패 0)`,
          bad.length === 0,
          bad.length === 0 ? `${assets.length}개 전부 200` : `★실패 ${bad.length}건: ${bad.join(" / ")}`,
        ),
      );

      // ★아이콘은 **이미지로** 나가야 한다 — 200 이어도 Content-Type 이 틀리면 브라우저가
      //  favicon 으로 안 쓴다(오늘 고친 "이미지를 텍스트로 주입" 과 같은 종류의 실수).
      const icon = await fetch(`http://127.0.0.1:${port}/icon.png`, {
        signal: AbortSignal.timeout(2000),
      });
      const ct = icon.headers.get("content-type") ?? "";
      const bytes = (await icon.arrayBuffer()).byteLength;
      out.push(
        assert(
          "★브랜드 아이콘이 image/png 로, 실제 바이트와 함께 나간다",
          icon.ok && ct.startsWith("image/png") && bytes > 1000,
          `status=${icon.status} type=${ct || "(없음)"} ${bytes}B`,
        ),
      );
      // 캐시 정책 — 내용이 고정인 자산을 매 요청 재전송하면 폰에서 체감이 나쁘다.
      out.push(
        assert(
          "아이콘은 캐시된다(no-store 아님)",
          !/no-store/.test(icon.headers.get("cache-control") ?? ""),
          `cache-control=${icon.headers.get("cache-control") ?? "(없음)"}`,
        ),
      );
    } finally {
      child.kill("SIGTERM");
      await sleep(200);
      child.kill("SIGKILL");
    }
    return out;
  },
};
