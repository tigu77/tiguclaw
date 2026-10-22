/**
 * 회귀: **Edit·Write 카드의 «지금 파일에서 보기»** (2026-10-21 — 설계 docs/decisions/2026-10-21-edit-card-full-file-view-design.md v2 · 아스트라 검토 반영).
 *
 * 정태님 *«전체파일에서 바뀐부분을 보여줄 필요»* + *«억지로 저장되는 데이터를 늘리기보다»*. 지키는 것:
 *  ① 강조 판정(`locateEdit`, 순수 함수): 조각의 수정 후 내용이 지금 파일에 **정확히 한 곳**일 때만 — 줄 중간 수정 · 겹치는 출현 · 잘림·줄 컷 ·
 *     순수 삭제 · 못 찾음 · Edit·Write 공통 규칙 · CRLF
 *  ② 읽기 경로(`/file-view`): 등록 프로젝트 안 일반 파일만 · 비밀 파일(`.env`·`.git`)은 심링크 **전후** · 2MB · 바이너리 · 상대 경로 · 저장 0
 *  ③ 관측: Edit·Write 빌더가 그 턴의 cwd 로 `absPath` 를 싣는다(파일 내용은 안 싣는다)
 *  ④ 화면: ⤢ → 창(조각 + 지금 파일 + 강조) · 닫은 뒤 늦은 응답 무시 · 「↗ 열기」가 `absPath` 를 쓴다
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildActivityDiff } from "../../core/llm-runtime/adapters/_activity-diff.js";
import { initStore, getDb } from "../../store/sessions.js";
import { upsertProject, forgetProject } from "../../store/projects.js";
import { bootDashboard, dashSource, dispatch, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";
import { assert, assertIsolated, i18nForContext, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

type Line = { op: string; text: string };
type Where = { fromLine?: number; toLine?: number; reason?: string };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const check: RegressionCheck = {
  name: "file-view-current-file",
  guards: "Edit 카드가 바뀐 조각만 보여 주어 주변 코드를 볼 수 없던 것 — 지금 파일을 띄우되, 확인되지 않은 자리를 칠하거나 비밀 파일을 내보내지 않게",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];

    // ── ① 강조 판정 — 진짜 file-view.js 를 실어 순수 함수만 꺼낸다 ─────────────────
    const ctx = vm.createContext({ window: {}, document: {} });
    vm.runInContext(dashSource("file-view.js"), ctx, { filename: "file-view.js" });
    const locate = (content: string, lines: Line[], extra: Record<string, unknown> = {}): Where =>
      vm.runInContext(`locateEdit(${JSON.stringify(content)}, ${JSON.stringify({ lines, ...extra })})`, ctx) as Where;
    const exact = locate("a\nconst x = 1;\nb\n", [{ op: "-", text: "const x = 0;" }, { op: "+", text: "const x = 1;" }]);
    const midLine = locate('const x = "bar";\n', [{ op: "-", text: "foo" }, { op: "+", text: "bar" }]);
    const span = locate("x\nA\nB\ny", [{ op: " ", text: "A" }, { op: "+", text: "B" }]);
    const overlap = locate("aaa", [{ op: "+", text: "aa" }]);
    const many = locate("k=1\nk=1\n", [{ op: "+", text: "k=1" }]);
    const truncated = locate("a\nb\n", [{ op: "+", text: "a" }], { truncated: true });
    const clipped = locate("a".repeat(500), [{ op: "+", text: "a".repeat(399) + "…" }]);
    const onlyRemoved = locate("a\nb\n", [{ op: "-", text: "gone" }]);
    const missing = locate("a\nb\n", [{ op: "+", text: "zzz" }]);
    const writeAll = locate("l1\nl2\n", [{ op: "+", text: "l1" }, { op: "+", text: "l2" }]);
    const writeDiffers = locate("l1\nCHANGED\n", [{ op: "+", text: "l1" }, { op: "+", text: "l2" }]);
    const crlf = locate("a\r\nb\r\n", [{ op: "+", text: "a\r" }, { op: "+", text: "b\r" }]);
    out.push(
      assert(
        "★★강조는 **정확히 한 곳**일 때만 — 제자리·줄 중간 수정(문자열로 찾음)·여러 줄 걸침·Write 가 파일 전체와 같을 때·CRLF 는 그 줄",
        exact.fromLine === 2 && exact.toLine === 2 && midLine.fromLine === 1 && midLine.toLine === 1 &&
          span.fromLine === 2 && span.toLine === 3 && writeAll.fromLine === 1 && writeAll.toLine === 2 && crlf.fromLine === 1 && crlf.toLine === 2,
        JSON.stringify({ exact, midLine, span, writeAll, crlf }),
      ),
    );
    out.push(
      assert(
        "★★확인할 수 없으면 칠하지 않는다(이유만) — **겹치는 출현**(`aaa` 안의 `aa`)·여러 곳·잘림·400자 줄 컷·순수 삭제·못 찾음·Write 일부만 같음",
        overlap.reason === "fv.reason.many" && many.reason === "fv.reason.many" && truncated.reason === "fv.reason.truncated" &&
          clipped.reason === "fv.reason.truncated" && onlyRemoved.reason === "fv.reason.onlyRemoved" && missing.reason === "fv.reason.notFound" &&
          writeDiffers.reason === "fv.reason.notFound" &&
          [overlap, many, truncated, clipped, onlyRemoved, missing, writeDiffers].every((w) => w.fromLine === undefined),
        JSON.stringify({ overlap, many, truncated, clipped, onlyRemoved, missing, writeDiffers }),
      ),
    );

    // ── ② 읽기 경로 — 진짜 라우트 함수 + 격리 홈의 등록 프로젝트 ─────────────────────
    const routes = await loadPluginModule<{ handleFileView: (c: unknown) => Promise<void>; isSecretPath: (p: string) => boolean }>("../../../plugins/http-bridge/routes-files.ts");
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-fileview-")));
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-fileview-out-")));
    const view = async (p: string) => {
      const res = { status: 0, body: "", writeHead(s: number) { res.status = s; return res; }, setHeader() {}, end(b?: string) { res.body = b ?? ""; } };
      await routes.handleFileView({ res, url: new URL("http://x/file-view?path=" + encodeURIComponent(p)) });
      return { status: res.status, body: JSON.parse(res.body || "{}") as Record<string, unknown> };
    };
    let routeOut: Record<string, unknown> = {};
    try {
      upsertProject({ path: root, name: "regr-fileview", status: "active" } as never);
      writeFileSync(path.join(root, "a.ts"), "const a = 1;\n");
      writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
      writeFileSync(path.join(root, ".env.local"), "TOKEN=secret\n");
      mkdirSync(path.join(root, ".git"));
      writeFileSync(path.join(root, ".git", "config"), "[core]\n");
      symlinkSync(path.join(root, ".env"), path.join(root, "notes.md")); // 이름은 평범, 실제는 .env
      symlinkSync(path.join(root, "a.ts"), path.join(root, ".env.shared")); // 이름이 비밀, 실제는 평범 — 해석 **전** 경로 판정이 막는다
      writeFileSync(path.join(outside, "b.ts"), "out\n");
      symlinkSync(path.join(outside, "b.ts"), path.join(root, "escape.ts")); // 안의 이름, 실제는 밖
      writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
      mkdirSync(path.join(root, ".ssh"));
      writeFileSync(path.join(root, ".ssh", "id_test"), "KEY\n");
      mkdirSync(path.join(root, ".aws"));
      writeFileSync(path.join(root, ".aws", "credentials"), "KEY\n");
      writeFileSync(path.join(root, "big.txt"), "x".repeat(2 * 1024 * 1024 + 1));
      mkdirSync(path.join(root, "dir"));
      const eventsBefore = (getDb().prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
      const r = {
        ok: await view(path.join(root, "a.ts")),
        env: await view(path.join(root, ".env")),
        envLocal: await view(path.join(root, ".env.local")),
        git: await view(path.join(root, ".git", "config")),
        linkToEnv: await view(path.join(root, "notes.md")),
        envNamedLink: await view(path.join(root, ".env.shared")),
        outside: await view(path.join(outside, "b.ts")),
        escape: await view(path.join(root, "escape.ts")),
        binary: await view(path.join(root, "bin.dat")),
        big: await view(path.join(root, "big.txt")),
        relative: await view("a.ts"),
        dir: await view(path.join(root, "dir")),
        ssh: await view(path.join(root, ".ssh", "id_test")),
        aws: await view(path.join(root, ".aws", "credentials")),
        missing: await view(path.join(root, "nope.txt")),
        // ★대소문자 별칭(10-21 적대 검토 — macOS 에서 200 · 비밀 내용이 나갔다). 대소문자 무시 FS 면 같은 파일, 아니면 없는 파일 — 어느 쪽이든 403.
        envUpper: await view(path.join(root, ".ENV")),
        envLocalMixed: await view(path.join(root, ".Env.local")),
        sshUpper: await view(path.join(root, ".SSH", "id_test")),
        gitUpper: await view(path.join(root, ".GIT", "config")),
        // ★소문자로도 안 펴지는 별칭 — APFS 는 `ſ`(U+017F 긴 s)를 `s` 로 접어 `.ſſh` 로 `.ssh` 가 열린다(10-21 재검토 실측). 입력 판정은 못 보고
        //  디스크의 진짜 이름(realpath.native)만 `.ssh` 로 편다 — 그 층을 지키는 사례. 별칭이 안 접히는 FS 에선 없는 파일(404) — 어느 쪽이든 200 이 아니다.
        sshFolded: await view(path.join(root, ".\u017f\u017fh", "id_test")),
      };
      const eventsAfter = (getDb().prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
      routeOut = { ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status])), content: r.ok.body.content, eventsDelta: eventsAfter - eventsBefore };
      // 판정 함수 자체 — 대소문자 무시 파일시스템에선 위 라우트 검사가 «진짜 이름» 판정(realpath.native)으로도 막혀, 이 함수가 대소문자를 놓쳐도 초록이 된다.
      const secretCases = ["/a/.ENV", "/a/.Env.Local", "/a/.SSH/id", "/a/.Git/config", "/a/.AWS/credentials"];
      const plainCases = ["/a/env.ts", "/a/.envrc-notes/x", "/a/my.git.md"];
      out.push(
        assert(
          "★비밀 판정은 대소문자를 가리지 않는다(`.ENV`·`.SSH/` — macOS·Windows 는 그 이름으로 비밀 파일이 열린다) · 평범한 이름은 막지 않는다",
          secretCases.every((c) => routes.isSecretPath(c)) && plainCases.every((c) => !routes.isSecretPath(c)),
          JSON.stringify(Object.fromEntries([...secretCases, ...plainCases].map((c) => [c, routes.isSecretPath(c)]))),
        ),
      );
      out.push(
        assert(
          "★★읽기 경로: 일반 파일은 **어떤 경로든** 내용 그대로(프로젝트 밖·밖을 가리키는 링크 포함 — 10-21 정태님 «유저가 풀권한») · 비밀 파일 `.env`·`.env.*`·`.git/`·`.ssh/`·`.aws/` 403(★대소문자 별칭 `.ENV`·`.SSH/` 도) · ★**`.env` 를 가리키는 심링크·비밀 이름의 링크도 403**(심링크 전후 둘 다) · 바이너리 415 · 2MB 초과 413 · 상대 경로 400 · 디렉터리 거절 · 없는 파일 404 · 아무것도 저장 안 함",
          r.ok.status === 200 && r.ok.body.content === "const a = 1;\n" && r.env.status === 403 && r.envLocal.status === 403 && r.git.status === 403 &&
            r.ssh.status === 403 && r.aws.status === 403 &&
            r.envUpper.status === 403 && r.envLocalMixed.status === 403 && r.sshUpper.status === 403 && r.gitUpper.status === 403 && r.sshFolded.status !== 200 &&
            r.linkToEnv.status === 403 && r.envNamedLink.status === 403 && r.outside.status === 200 && r.outside.body.content === "out\n" &&
            r.escape.status === 200 && r.binary.status === 415 && r.big.status === 413 &&
            r.relative.status === 400 && r.dir.status === 403 && r.missing.status === 404 && eventsAfter === eventsBefore,
          JSON.stringify(routeOut),
        ),
      );
    } finally {
      forgetProject(root);
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }

    // ── ②' 검사와 읽기 사이 경합(아스트라 10-21) — 자식 프로세스가 진짜 라우트 함수의 `open` 앞뒤에 교체·성장을 주입한다 ─────────
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "_file-view-race-child.ts");
    const raceHome = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-fvrace-home-"));
    const rr = spawnSync(process.execPath, ["--import", "tsx", child], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TIGUCLAW_HOME: raceHome } });
    rmSync(raceHome, { recursive: true, force: true });
    let race: Record<string, { status: number; bytes?: number; outside: boolean; other: boolean; readBytes?: number }> = {};
    try { race = JSON.parse((rr.stdout ?? "").trim().split("\n").pop() ?? "{}"); } catch { race = {}; }
    out.push(
      assert(
        "★★검사 뒤 파일이 바뀌어도 검사가 읽은 내용에 닿는다 — 열기 직전·직후 **비밀 파일(.env)을 가리키는 심링크**로 교체 → 403(비밀 내용 0) · 연 뒤 다른 파일로 교체 → 409 · 연 뒤 3MB 로 커짐 → 413 · **읽은 양이 상한+1 이하** · 정상 200",
        race.none?.status === 200 && race.none.bytes === 5 &&
          race.swapBefore?.status === 403 && !race.swapBefore.outside &&
          race.swapAfter?.status === 403 && !race.swapAfter.outside &&
          race.replaceAfter?.status === 409 && !race.replaceAfter.other &&
          race.growOnRead?.status === 413 && race.growOnRead.readBytes !== undefined && race.growOnRead.readBytes <= 2 * 1024 * 1024 + 1,
        JSON.stringify({ race, stderr: (rr.stderr ?? "").slice(-300) }),
      ),
    );

    // ── ③ 관측 — 그 턴의 cwd 로 absPath ──────────────────────────────────────
    const relEdit = buildActivityDiff("Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" }, "/proj");
    const relWrite = buildActivityDiff("Write", { file_path: "src/b.ts", content: "z\n" }, "/proj");
    const absEdit = buildActivityDiff("Edit", { file_path: "/abs/c.ts", old_string: "x", new_string: "y" });
    const noCwd = buildActivityDiff("Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" });
    out.push(
      assert(
        "관측: Edit·Write 모두 상대 경로를 **그 턴의 cwd** 로 푼 `absPath` 를 싣는다 · 절대 경로는 그대로 · cwd 가 없으면 지어내지 않는다 · 파일 내용은 안 싣는다",
        relEdit?.absPath === path.resolve("/proj", "src/a.ts") && relWrite?.absPath === path.resolve("/proj", "src/b.ts") &&
          absEdit?.absPath === "/abs/c.ts" && noCwd !== undefined && noCwd.absPath === undefined &&
          !Object.keys(relWrite ?? {}).some((k) => k === "content"),
        JSON.stringify({ relEdit: relEdit?.absPath, relWrite: relWrite?.absPath, absEdit: absEdit?.absPath, noCwd: noCwd?.absPath }),
      ),
    );

    // ── ④ 화면 — 진짜 virtualization.js(buildDiffBlock) + file-view.js ───────────────
    const clock = makeClock();
    let hold: ((v: unknown) => void) | null = null;
    const opened: string[] = [];
    let fileContent = "head\nconst x = 1;\ntail\n";
    const fetched: string[] = [];
    const dash = bootDashboard({
      clock, i18n: i18nForContext, upTo: "token-delta.js", allIds: true,
      fetch: async (url: string, init?: { body?: string }) => {
        if (url === "/api/open-path") { opened.push(String(JSON.parse(String(init?.body ?? "{}")).path)); return jsonResponse({ ok: true }); }
        if (url.startsWith("/api/file-view")) {
          fetched.push(url);
          if (hold !== null) await new Promise((r) => { hold = r; });
          return jsonResponse({ content: fileContent });
        }
        return jsonResponse({}, 404);
      },
    });
    const doc = dash.document;
    const diff = { path: "src/a.ts", absPath: "/proj/src/a.ts", startLine: 2, added: 1, removed: 1, lines: [{ op: "-", text: "const x = 0;" }, { op: "+", text: "const x = 1;" }] };
    const block = dash.run(`(() => { const b = buildDiffBlock(${JSON.stringify(diff)}); document.body.appendChild(b); return b; })()`);
    const buttons = block.querySelectorAll("button");
    const fvBtn = buttons.find((b: { className: string }) => b.className.includes("act-diff-fileview"));
    const openBtn = buttons.find((b: { className: string }) => !b.className.includes("act-diff-fileview"));
    // 문법 색 — 진짜 hljs 대신 같은 계약(`highlight(text,{language}).value` = 이스케이프된 HTML)의 대역. 조각 카드와 같은 판별(`hlLangFromPath`)을 지나는지 본다.
    const hlCalls: string[] = [];
    dash.window.__hlCalls = hlCalls;
    dash.run(`window.hljs = { highlight: (t, o) => { window.__hlCalls.push(o.language + ":" + t.length); return { value: '<span class="hljs-keyword">' + t.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span>" }; } }`);
    if (openBtn) dispatch(openBtn, makeEvent("click"));
    if (fvBtn) dispatch(fvBtn, makeEvent("click"));
    await clock.advance(50);
    await sleep(10);
    const note = doc.querySelectorAll(".fv-note")[0]?.textContent ?? "";
    const fragInModal = doc.querySelectorAll(".fv-frag .act-diff").length;
    const nestedFv = doc.querySelectorAll(".fv-frag .act-diff-fileview").length;
    // 한 화면 — 앞(1) · 바뀐 곳(지운 줄 번호 없음 → 새 줄 2) · 뒤(3). 지운 줄은 기록의 글자, 새 줄은 지금 파일의 글자.
    const rows = doc.querySelectorAll(".fv-change .fv-row").map((r: { className: string; querySelectorAll: (q: string) => { textContent: string }[] }) =>
      [r.className.replace("fv-row ", ""), r.querySelectorAll(".fv-no")[0]?.textContent ?? "?", r.querySelectorAll(".fv-line")[0]?.textContent ?? "?"]);
    const segs = doc.querySelectorAll(".fv-seg").map((g: { querySelectorAll: (q: string) => { textContent: string }[] }) =>
      [g.querySelectorAll(".fv-gutter")[0]?.textContent ?? "", g.querySelectorAll(".fv-code")[0]?.textContent ?? ""]);
    const colored = doc.querySelectorAll(".fv-file .hljs-keyword").length;
    // 못 합치는 경우(지금 파일에 그 내용이 없다) — 조각을 위에 따로 남기고 본문엔 바뀐 곳을 그리지 않는다(위치를 지어내지 않는다).
    dispatch(doc, makeEvent("keydown", { key: "Escape" }));
    fileContent = "head\nsomething else\n";
    if (fvBtn) dispatch(fvBtn, makeEvent("click"));
    await clock.advance(50);
    await sleep(10);
    const miss = {
      frag: doc.querySelectorAll(".fv-frag .act-diff").length,
      change: doc.querySelectorAll(".fv-change").length,
      segs: doc.querySelectorAll(".fv-seg .fv-gutter").map((g: { textContent: string }) => g.textContent),
      note: doc.querySelectorAll(".fv-note")[0]?.textContent ?? "",
    };
    dispatch(doc, makeEvent("keydown", { key: "Escape" }));
    fileContent = "head\nconst x = 1;\ntail\n";
    // 닫은 뒤 늦게 온 응답 — 그리지 않는다
    hold = () => {};
    if (fvBtn) dispatch(fvBtn, makeEvent("click"));
    await clock.advance(10);
    dispatch(doc, makeEvent("keydown", { key: "Escape" }));
    const afterClose = doc.querySelectorAll(".fv-back").length;
    const release = hold as unknown as ((v: unknown) => void) | null;
    hold = null;
    if (typeof release === "function") release(undefined);
    await clock.advance(50);
    await sleep(10);
    out.push(
      assert(
        "★★화면: ⤢ → **한 화면** — 지금 파일 안 그 자리에 바뀐 곳(지운 줄은 번호 없이·새 줄은 지금 파일의 번호로), 위 조각 카드는 따로 안 남는다 · «지금 디스크» 를 말한다 · `absPath` 로 읽는다 (2026-10-22 «한번에 그냥 보여주면»)",
        fvBtn !== undefined && fragInModal === 0 && nestedFv === 0 &&
          JSON.stringify(rows) === JSON.stringify([["fv-del", "", "const x = 0;"], ["fv-add", "2", "const x = 1;"]]) &&
          JSON.stringify(segs) === JSON.stringify([["1", "head"], ["3", "tail"]]) &&
          note.includes("지금 디스크") && note.includes("2~2") && fetched[0] === "/api/file-view?path=" + encodeURIComponent("/proj/src/a.ts"),
        JSON.stringify({ hasBtn: fvBtn !== undefined, fragInModal, nestedFv, rows, segs, note, fetched: fetched[0] }),
      ),
    );
    out.push(
      assert(
        "★지금 파일에 그 내용이 없으면 합치지 않는다 — 조각은 위에 따로, 본문은 파일 그대로(바뀐 곳 0) · 이유를 말한다",
        miss.frag === 1 && miss.change === 0 && JSON.stringify(miss.segs) === JSON.stringify(["1\n2"]) && miss.note.includes("지금 디스크"),
        JSON.stringify(miss),
      ),
    );
    out.push(
      assert(
        "★지금 파일 본문에도 문법 색 — 앞·뒤 구간과 바뀐 곳 모두 조각 카드와 같은 판별(`hlLangFromPath`)로 칠한다 (2026-10-22 «전혀 일반 텍스트 형태로 나오네»)",
        colored >= 4 && hlCalls.some((c) => c.startsWith("typescript:")),
        JSON.stringify({ colored, hlCalls: hlCalls.slice(0, 8) }),
      ),
    );
    out.push(
      assert(
        "닫은 뒤(Esc) 도착한 늦은 응답은 창을 다시 만들지 않는다 · 「↗ 열기」는 상대 경로 카드에서도 `absPath` 로 연다(데몬 cwd 로 풀려 못 열던 것)",
        afterClose === 0 && doc.querySelectorAll(".fv-back").length === 0 && doc.querySelectorAll(".fv-code").length === 0 &&
          opened[0] === "/proj/src/a.ts",
        JSON.stringify({ afterClose, backs: doc.querySelectorAll(".fv-back").length, opened }),
      ),
    );
    return out;
  },
};
