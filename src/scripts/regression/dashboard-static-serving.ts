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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

import { createRequire } from "node:module";

/**
 * 설치 위치와 무관하게 tsx CLI 를 찾는다(워크트리·호이스팅 안전).
 * `tsx/dist/cli.mjs` 는 package exports 에 없어 직접 resolve 가 막히므로, 패키지의
 * package.json 을 짚어 그 옆의 CLI 를 찾는다.
 */
const tsxCli = (): string =>
  path.join(
    path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
    "dist/cli.mjs",
  );

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
    // 탭 제목 저장 — 앞뒤 공백 제거 · 60자 자르기 · 빈 값이면 키 삭제(기본 제목으로). 격리 홈의 settings.json 에서.
    {
      const S = await import("../../core/settings.js");
      const saved = S.setDashboardTitle(`  ${"가".repeat(70)}  `);
      const read1 = S.readDashboardTitle();
      S.setDashboardTitle("");
      const read2 = S.readDashboardTitle();
      const raw = JSON.parse(readFileSync((await import("../../core/paths.js")).getPaths().settings, "utf8")) as Record<string, unknown>;
      out.push(assert("탭 제목 저장: 공백 제거·60자 상한 · 비우면 키 삭제(기본 제목)",
        saved === "가".repeat(60) && read1 === saved && read2 === "" && !("dashboardTitle" in raw), { saved: saved.length, read2, keys: Object.keys(raw) }));
      // ★비서가 바꿀 수 있다 — «탭 제목 바꿔줘» 가 갈 길(`set_appearance` 의 title). 등록된 핸들러를 그대로 부른다.
      const { createModelSettingsMcpServer } = await import("../../core/llm-runtime/capabilities/model-settings-mcp.js");
      const reg = (createModelSettingsMcpServer(process.cwd()) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, x: unknown) => Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> }> } }).instance._registeredTools;
      const r1 = await reg["set_appearance"]!.handler({ title: "회사 비서" }, {});
      const viaTool = S.readDashboardTitle();
      const look = await reg["set_appearance"]!.handler({}, {});
      await reg["set_appearance"]!.handler({ title: "none" }, {});
      out.push(assert("★비서 도구(set_appearance title)로 탭 제목을 바꾸고 · 조회에 보이고 · none 이면 기본으로",
        r1.isError !== true && viaTool === "회사 비서" && (look.content?.[0]?.text ?? "").includes("탭 제목: 회사 비서") && S.readDashboardTitle() === "",
        { viaTool, look: look.content?.[0]?.text?.slice(-40), after: S.readDashboardTitle() }));
    }

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

    // ★`node_modules` 위치를 **박아 넣지 않는다** (2026-08-23 2라운드). 종전엔
    //  `path.join(REPO, "node_modules/tsx/…")` 라 워크트리(git worktree)에선 항상 빨강이었다
    //  — 레드팀이 격리 워크트리에서 스위트를 돌 때마다 이 검사만 상시 FAIL 이라, 결국
    //  "환경 문제" 로 분류돼 아무도 안 보는 게이트가 된다([[feedback_gate_must_actually_run]]).
    //  resolve 로 찾으면 워크트리·호이스팅·설치 위치와 무관하다.
    const port = await freePort();
    // ★탭 제목 설정(`dashboardTitle`)이 첫 렌더부터 실린다 — 전용 홈에 HTML 특수문자와 `$&`(replace 특수문자)를 넣어 둔다.
    const home = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-dashtitle-"));
    const TITLE = '<b>회사 $& 대시</b>';
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ dashboardTitle: TITLE }));
    const child = spawn(
      process.execPath,
      [tsxCli(), path.join(dash, "index.ts")],
      {
        env: {
          ...process.env,
          TIGUCLAW_HOME: home,
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

      const page = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).text();
      const titleTag = /<title>([\s\S]*?)<\/title>/.exec(page)?.[1] ?? "";
      out.push(
        assert(
          "★탭 제목 설정이 첫 렌더부터 실린다 — HTML 이스케이프 · `$&` 가 치환 특수문자로 안 먹힌다 · 설정 화면이 읽을 현재값도 주입",
          titleTag === "&lt;b&gt;회사 $&amp; 대시&lt;/b&gt;" && page.includes('"title":"\\u003cb>회사 $& 대시\\u003c/b>"'),
          { titleTag, injected: /__TIGU_THEME__ = (\{[^<]*?\});/.exec(page)?.[1]?.slice(0, 160) },
        ),
      );

      // ★신원 판정 이음매 — 제목을 바꾼 채 서빙된 페이지를 데몬의 실제 판정 함수로 본다(적대 검토 F1: 제목이 표식이라 «남의 앱» 오판).
      const { probeLocalPort } = await import("../../core/local-port-probe.js");
      const marker = /const DASHBOARD_MARKER = "([^"]+)"/.exec(readFileSync(path.join(REPO, "plugins/dashboard/index.ts"), "utf8"))?.[1] ?? "";
      const probe = await probeLocalPort(String(port), marker, 2000);
      // 표식의 **정본 자리**는 제목 밖(`<meta name="application-name">`)이다 — 서빙 때 주입한 원본 제목(defaultTitle)도 같은 글자를
      //  실어 판정이 우연히 성립할 수 있으니, 원본 index.html 에서 <title> 을 뺀 나머지에 표식이 있는지 따로 본다.
      const outsideTitle = html.replace(/<title>[\s\S]*?<\/title>/, "").includes(`content="${marker}"`);
      out.push(assert("★탭 제목을 바꿔도 데몬이 자기 대시보드로 알아본다 · 표식은 제목 밖(meta)에도 있다", marker !== "" && probe === "ours" && outsideTitle, { marker, probe, outsideTitle }));

      const bad: string[] = [];
      for (const a of assets) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}${a}`, {
            signal: AbortSignal.timeout(2000),
          });
          const len = (await r.arrayBuffer()).byteLength;
          // 200 이어도 본문이 비면 서빙된 게 아니다(읽기 실패를 200 으로 덮는 경우).
          // ★예외 하나 — 사용자 테마 오버라이드(`<home>/theme.css`)는 **비어 있는 게 정상**
          //  이다(2026-08-26). 없을 때 404 를 주면 콘솔에 매번 에러가 찍혀 진짜 문제를 덮으므로
          //  빈 200 으로 답한다. 이 자산만 크기 조건에서 빼고, 지키는 것(404 조용한 실패)은 그대로.
          // 프리셋(고른 게 없을 때)과 개인 오버라이드(파일이 없을 때) 둘 다 빈 200 이 정상이다.
          const mayBeEmpty = a === "/theme.css" || a === "/theme-preset.css";
          if (!r.ok || (len === 0 && !mayBeEmpty)) bad.push(`${a} → ${r.status}/${len}B`);
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
      // ★**두 판이 다 나가야 한다** (2026-08-27). `icon.png` 는 배경을 뚫은 것(어느 테마에도
      //  얹힌다), `icon-solid.png` 는 배경이 있는 것(**iOS 홈 화면 전용** — iOS 는 투명을
      //  검게 합성하므로 뚫은 걸 주면 지금과 똑같거나 더 나빠진다).
      //  ★한쪽만 검사하면 나머지가 404 여도 초록이다 — 그러면 홈 화면 아이콘이 통째로 깨진다.
      const solid = await fetch(`http://127.0.0.1:${port}/icon-solid.png`, {
        signal: AbortSignal.timeout(2000),
      });
      const solidCt = solid.headers.get("content-type") ?? "";
      const solidBytes = (await solid.arrayBuffer()).byteLength;
      out.push(
        assert(
          "★apple-touch 용 solid 아이콘도 image/png 로 나간다(iOS 홈 화면)",
          solid.ok && solidCt.startsWith("image/png") && solidBytes > 1000,
          `status=${solid.status} type=${solidCt || "(없음)"} ${solidBytes}B`,
        ),
        assert(
          "★둘이 서로 다른 파일이다(같으면 나눈 의미가 없다)",
          solidBytes !== bytes,
          `투명 ${bytes}B · solid ${solidBytes}B`,
        ),
        assert(
          "★마크업이 apple-touch 에만 solid 를 건다(파비콘·브랜드는 투명)",
          /rel="apple-touch-icon" href="\/icon-solid\.png"/.test(html) &&
            /rel="icon"[^>]*href="\/icon\.png"/.test(html) &&
            /class="brand-icon" src="\/icon\.png"/.test(html),
          `apple-touch=${/apple-touch-icon" href="\/icon-solid\.png"/.test(html)} · ` +
            `favicon=${/rel="icon"[^>]*href="\/icon\.png"/.test(html)} · ` +
            `brand=${/class="brand-icon" src="\/icon\.png"/.test(html)}`,
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
      rmSync(home, { recursive: true, force: true });
    }
    return out;
  },
};
