/**
 * 회귀: **도구 결과·미리보기의 문법 색** (2026-11-28 정태님 — «Read 결과에서도 Edit/Write 처럼 … 텍스트로 출력해서 보여주는 부분들은 가능하면 다 해주면 좋을거같아»).
 *
 * 지키는 것(진짜 대시보드 소스 + 진짜 vendored highlight.js · 미니 DOM · 합성 예시만):
 *  ① Read 저장 프리뷰(자체 Read — 행 번호가 확인된 것): 경로 확장자로 칠한다 · 줄마다 **글자 그대로**(앞뒤 공백·`<script>`·`&amp;`) ·
 *     번호 그대로 · **여러 줄 주석이 다음 줄에도 이어진다**(줄마다 따로 칠하면 첫 줄에서 끊긴다) · 실행되는 태그가 생기지 않는다
 *  ② 칠하지 않는 것: 모르는 확장자 · 번호 형식 미확인(Claude 기본 Read 등 unknown) · 오류 — 평문, 글자 그대로
 *  ③ 도구 출력: 통째로 파싱되는 JSON · 머리 줄+메타데이터 줄이 확인되는 git diff 만 칠한다. 잘린 JSON·깨진 JSON·`[` 로 시작하는 로그·오류 JSON 은 평문.
 *     잘림 안내는 색 뒤에 글자로 그대로
 *  ④ 라이브(`buildActivityLine`)·이력(`buildHistStepLine`)·잡 카드(`buildToolOutputBlock`) 가 같은 결과
 *  ⑤ 첨부 텍스트 미리보기: 이름 확장자로 칠하되 **이미 받은 글자만**(요청 1회 — 전과 같음) · 800자 잘림 표시 그대로 · `.txt` 는 평문
 *  ⑥ 계획 카드 코드블록 — 언어를 적은 펜스만 칠한다(자동 감지 안 함)
 *  ⑦ 비용·폴백: 상한(`HL_TEXT_MAX`) 초과·hljs 없음 → 평문 · 도구 출력을 그리며 네트워크 요청 0
 * 등급: 동작(진짜 소스·진짜 hljs). 실제 브라우저의 색·복사·가상화는 격리 브라우저 확인이 잰다(이 검사 밖).
 */
import { readFileSync } from "node:fs";
import tsLib from "typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildActivityOutput } from "../../core/llm-runtime/adapters/_activity-output.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, dispatch, makeClock, makeEvent } from "./_mini-dom.js";
import { bgPanelHtml } from "./_bg-panel-fixture.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

export const check: RegressionCheck = {
  name: "tool-output-syntax-highlight",
  guards: "Read 결과·도구 출력·첨부 미리보기가 Edit/Write 와 달리 단색이던 것 — 칠하며 생길 것: 글자·공백·번호가 바뀜 · 이스케이프가 풀림 · 여러 줄 색이 끊김 · 로그/자연어를 억지로 칠함 · 미리보기를 위해 다시 받음",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);
    let fetches: string[] = [];
    const ATT_TS = "const tag = \"<script>x</script>\";\n/* 첨부\n   주석 */\n" + "let n = 1;\n".repeat(90); // 800자를 넘긴다
    const ATT_GO = "package main\nfunc main() { return }";
    const ATT_JSON = "{\n  \"ok\": true,\n  \"n\": 3\n}";
    const clock = makeClock();
    const dash = bootDashboard({
      html: bgPanelHtml(), clock, i18n: i18nForContext, allIds: true, upTo: "axis1-options.js",
      fetch: async (url: string) => {
        fetches.push(url);
        const body = url.endsWith(".ts") ? ATT_TS : url.endsWith("/result") ? ATT_JSON : url.endsWith("/gofile") ? ATT_GO : "plain <b>note</b> 그대로";
        return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
      },
    });
    dash.run(readFileSync(path.join(REPO, "packages/dashboard/highlight.min.js"), "utf8"), "highlight.min.js");
    dash.run("window.hljs = hljs;");
    dash.ctx.__in = null;
    const call = (expr: string, arg: unknown): R => { dash.ctx.__in = arg; return dash.run(`(${expr})(__in)`) as R; };
    // 그린 카드 → 비교할 사실만(글자·번호·색 클래스·태그).
    const factsOf = (el: R): R => {
      const all = (sel: string): R[] => [...el.querySelectorAll(sel)];
      return {
        rows: all(".act-read-text").map((n) => n.textContent),
        rowHl: all(".act-read-text").map((n) => [...new Set([...n.querySelectorAll("span")].map((s: R) => s.className))].sort().join(" ")),
        nums: all(".act-read-num").map((n) => n.textContent),
        pre: (all("pre")[0] || {}).textContent ?? null,
        hl: all('[class*="hljs-"]').map((n) => n.className),
        script: all("script").length,
        captions: all(".act-read-caption").map((n) => n.textContent),
      };
    };

    await new Promise((r) => setImmediate(r));
    const bootFetches = fetches.slice();
    fetches = []; // 부팅이 내는 요청(상태·설정 조회)은 셈에서 뺀다 — 아래는 도구 출력을 그리는 동안만 센다.
    // ① 자체 Read 저장 프리뷰 — 진짜 생산자(`buildActivityOutput`)가 만든 관측 그대로.
    const SRC = [
      "  const html = \"<script>alert(1)</script> &amp; ok\";   ",
      "/* 여러 줄",
      "   주석 */",
      "\tlet n = 42;",
    ];
    const readOut = buildActivityOutput("Read", SRC.join("\n"), false, { kind: "text", startLine: 10, returnedLineCount: 4 }, true);
    const tsFile = { path: "src/synthetic.ts", absPath: "/synthetic/src/synthetic.ts" };
    const ts = factsOf(call("(o) => buildReadBlock(o.out, o.file)", { out: readOut, file: tsFile }));
    out.push(assert(
      "★① Read(.ts) — 줄마다 글자 그대로(앞뒤 공백·<script>·&amp;) · 번호 10~13 그대로 · 실행 태그 0 · 1줄 문자열·4줄 숫자 색",
      JSON.stringify(ts.rows) === JSON.stringify(SRC) && ts.nums.join(",") === "10,11,12,13" && ts.script === 0 &&
        ts.rowHl[0].includes("hljs-string") && ts.rowHl[3].includes("hljs-number"),
      show(ts),
    ));
    out.push(assert(
      "★① 여러 줄 주석의 색이 다음 줄에도 이어진다(2·3줄 모두 주석) — 줄마다 따로 칠하면 3줄이 주석으로 안 보인다",
      ts.rowHl[1] === "hljs-comment" && ts.rowHl[2] === "hljs-comment",
      show(ts.rowHl),
    ));
    const htmlFile = { path: "page.html", absPath: "/synthetic/page.html" };
    const htmlOut = buildActivityOutput("Read", "<div onclick=\"x()\">a &lt; b</div>\n<script>alert(1)</script>", false, { kind: "text", startLine: 1, returnedLineCount: 2 }, true);
    const html = factsOf(call("(o) => buildReadBlock(o.out, o.file)", { out: htmlOut, file: htmlFile }));
    out.push(assert(
      "★① Read(.html) — 마크업이 글자로 보이고(태그로 살아나지 않음) 색만 입는다",
      html.rows[0] === "<div onclick=\"x()\">a &lt; b</div>" && html.rows[1] === "<script>alert(1)</script>" && html.script === 0 && html.hl.length > 0,
      show(html),
    ));

    // ② 칠하지 않는 것.
    const txt = factsOf(call("(o) => buildReadBlock(o.out, o.file)", { out: readOut, file: { path: "notes.txt", absPath: "/synthetic/notes.txt" } }));
    const native = buildActivityOutput("Read", "    17→const a = 1;\n    18→/* b */", false, { kind: "unknown" });
    const nat = factsOf(call("(o) => buildReadBlock(o.out, o.file)", { out: native, file: tsFile }));
    const errOut = buildActivityOutput("Read", "Error: const nope = 1;", true, { kind: "text", startLine: 1, returnedLineCount: 1 }, true);
    const err = factsOf(call("(o) => buildReadBlock(o.out, o.file)", { out: errOut, file: tsFile }));
    out.push(assert(
      "★② 모르는 확장자(.txt) · 번호 형식 미확인(unknown) · 오류 — 색 0 · 글자 그대로",
      txt.hl.length === 0 && JSON.stringify(txt.rows) === JSON.stringify(SRC) &&
        nat.hl.length === 0 && nat.pre === "    17→const a = 1;\n    18→/* b */" && nat.rows.length === 0 &&
        err.hl.length === 0 && err.pre === "Error: const nope = 1;",
      show({ txt: txt.hl, nat, err }),
    ));
    // 확장자 없는 이름 · CR(LF)·NUL — HTML 파서가 글자를 바꾸는 입력은 칠하지 않는다(GPT R1).
    const goDoc = factsOf(call("(o) => buildReadBlock(o.out, o.file)", { out: readOut, file: { path: "docs/go", absPath: "/synthetic/docs/go" } }));
    const CR = ["const a = 1;\r", "/* x */\r", "let b\u0000 = 2;"];
    const crOut = buildActivityOutput("Read", CR.join("\n"), false, { kind: "text", startLine: 1, returnedLineCount: 3 }, true);
    const cr = factsOf(call("(o) => buildReadBlock(o.out, o.file)", { out: crOut, file: tsFile }));
    const langs = call("(xs) => xs.map((p) => hlLangFromName(p))", ["docs/go", "Makefile", ".bashrc", "dir.v2/r", "src/a.go", "C:\\x\\y.TS"]);
    // 기존 Edit/Write·⤢ 파일 보기가 쓰는 판별기는 그대로다(점 없는 `docs/go` → go — 이번에 안 바꿈, GPT R2).
    const legacy = call("(p) => hlLangFromPath(p)", "docs/go") as unknown as string | null;
    out.push(assert(
      "★② 확장자 없는 이름(`docs/go`)은 언어로 읽지 않는다 · CR/NUL 이 든 스냅샷은 평문(글자 그대로) · 판별: 점 없는 이름·숨김 이름 → 없음",
      goDoc.hl.length === 0 && cr.hl.length === 0 && JSON.stringify(cr.rows) === JSON.stringify(CR) &&
        JSON.stringify(langs) === JSON.stringify([null, null, null, null, "go", "typescript"]) && legacy === "go",
      show({ goDoc: goDoc.hl, cr, langs, legacy }),
    ));

    // ③ 도구 출력 — 형식이 구조로 확인될 때만.
    const JSON_TEXT = JSON.stringify({ name: "<b>x</b>", list: [1, true, null], nested: { "a&b": "  두 칸  " } }, null, 2);
    const outFacts = (tool: string, text: string, isError?: boolean): R => factsOf(call("(o) => buildOutputBlock(o)", buildActivityOutput(tool, text, isError)));
    const js = outFacts("Bash", JSON_TEXT);
    const mcp = outFacts("mcp__scheduler__list_schedules", "[{\"id\":1}]");
    out.push(assert(
      "★③ 통째로 파싱되는 JSON(Bash·MCP) — 키·값 색 · 글자·들여쓰기 그대로 · 태그 0",
      js.pre === JSON_TEXT && js.hl.includes("hljs-attr") && js.hl.includes("hljs-string") && js.script === 0 && mcp.hl.length > 0 && mcp.pre === "[{\"id\":1}]",
      show({ js, mcp }),
    ));
    const bigJson = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ i })), null, 2); // 40줄 캡 → 잘림
    const cut = outFacts("Bash", bigJson);
    const broken = outFacts("Bash", "{ not: json");
    const log = outFacts("Bash", "[INFO] server started\n[WARN] const x = 1");
    const errJson = outFacts("Bash", "{\"error\":\"denied\"}", true);
    const prose = outFacts("WebFetch", "function 이라는 단어가 든 안내 문장입니다.");
    out.push(assert(
      "★③ 잘린 JSON(잘림 안내 그대로) · 깨진 JSON · `[` 로 시작하는 로그 · 오류 JSON · 자연어 — 색 0 · 글자 그대로",
      cut.hl.length === 0 && typeof cut.pre === "string" && cut.pre.endsWith(i18nForContext("stream.truncated.nl")) &&
        broken.hl.length === 0 && broken.pre === "{ not: json" && log.hl.length === 0 && log.pre === "[INFO] server started\n[WARN] const x = 1" &&
        errJson.hl.length === 0 && prose.hl.length === 0,
      show({ cut: cut.hl, broken, log, errJson, prose }),
    ));
    const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const a = \"<i>\";\n+const a = \"<b>\";";
    const df = outFacts("Bash", DIFF);
    const longDiff = outFacts("Bash", DIFF + "\n" + "+x\n".repeat(60));
    out.push(assert(
      "★③ git diff(`diff --git` 머리) — 추가·삭제 색 · 글자 그대로 · 잘려도 diff 색 + 잘림 안내 글자",
      df.pre === DIFF && df.hl.includes("hljs-addition") && df.hl.includes("hljs-deletion") && df.script === 0 &&
        longDiff.hl.includes("hljs-addition") && String(longDiff.pre).endsWith(i18nForContext("stream.truncated.nl")),
      show({ df, longDiff: longDiff.hl.length }),
    ));
    const diffProse = outFacts("Bash", "diff --git 사용법 안내\n- 참고사항\n+ 추가 안내");
    const diffHeadOnly = outFacts("Bash", "diff --git a/x.ts b/x.ts\nindex 1234567..89abcde 100644");
    const diffProse2 = outFacts("Bash", "diff --git 사용법 안내\nindex 명령은 다음과 같습니다\n- 주의사항");
    const diffProse3 = outFacts("Bash", "diff --git 사용법 안내\n아래 세 줄은 각 머리의 예시입니다.\n--- 이전 파일\n+++ 이후 파일\n@@ -1 +1 @@\n이상으로 설명을 마칩니다.");
    const PROSE4 = "diff --git 사용법 안내\nindex 명령은 다음과 같습니다.\n--- 이전 파일\n+++ 이후 파일\n@@ -1 +1 @@\n이상으로 설명을 마칩니다.";
    const diffProse4 = outFacts("Bash", PROSE4);
    // 확장 머리(새 파일 모드·해시 쌍)가 붙은 진짜 패치는 diff 다.
    const NEWFILE = "diff --git a/n.ts b/n.ts\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+const n = 1;";
    const newFile = outFacts("Bash", NEWFILE);
    const SPACED = "diff --git a/my file.ts b/my file.ts\nindex 1234567..89abcde 100644\n--- a/my file.ts\n+++ b/my file.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx";
    const spaced = outFacts("Bash", SPACED);
    const crJson = outFacts("Bash", "{\r\n  \"a\": 1\r\n}");
    out.push(assert(
      "★③ `diff --git`·`index` 로 시작하는 안내문·머리 사이에 설명(`index …` 문장 포함)이 낀 안내문·hunk 전에 끝난 출력 · CRLF JSON — 평문 · 공백 든 경로·새 파일(확장 머리) 진짜 패치는 diff 색 · 글자 그대로",
      diffProse.hl.length === 0 && diffProse.pre === "diff --git 사용법 안내\n- 참고사항\n+ 추가 안내" && diffHeadOnly.hl.length === 0 && diffProse2.hl.length === 0 && diffProse3.hl.length === 0 && diffProse4.hl.length === 0 && diffProse4.pre === PROSE4 &&
        newFile.hl.includes("hljs-addition") && newFile.pre === NEWFILE &&
        spaced.hl.includes("hljs-addition") && spaced.pre === SPACED &&
        crJson.hl.length === 0 && crJson.pre === "{\r\n  \"a\": 1\r\n}",
      show({ diffProse: diffProse.hl, diffHeadOnly: diffHeadOnly.hl, diffProse2: diffProse2.hl, diffProse3: diffProse3.hl, diffProse4: diffProse4.hl, newFile: newFile.hl, spaced: spaced.hl, crJson: crJson.hl }),
    ));

    // ④ 세 화면이 같은 결과.
    const histLine = factsOf(call("(a) => buildHistStepLine(a)", { label: "Read", kind: "tool", ts: 1, seq: 3, threadKey: "main", output: readOut, file: tsFile }));
    const liveLine = factsOf(call("(p) => buildActivityLine(p)", { label: "Read", kind: "tool", seq: 4, threadKey: "main", output: readOut, file: tsFile, durationMs: 5 }));
    // 잡 카드 — 진짜 경로: 매니저 스텝 시작(파일 관측) → 끝(출력 보관) → 클릭으로 펼침(보관한 output·file 로 지연 빌드).
    dash.ctx.__jp = { label: "Read", kind: "tool", threadKey: "worker:HL1", seq: 1, file: tsFile, ts: 1 };
    dash.run("handleWorkerActivity(__jp, 1)");
    dash.ctx.__je = { threadKey: "worker:HL1", seq: 1, phase: "end", durationMs: 4, output: readOut };
    dash.run("annotateToolDuration(__je)");
    const jStep = dash.run(`jobCards.get("HL1").stepsEl.querySelector('.bg-step[data-seq="1"]')`) as R | null;
    if (jStep) dispatch(jStep as never, makeEvent("click", { bubbles: true, detail: 1 }));
    const jobLine = jStep ? factsOf(jStep) : { rows: [], rowHl: [] };
    const histJson = factsOf(call("(a) => buildHistStepLine(a)", { label: "Bash", kind: "tool", ts: 1, seq: 5, threadKey: "main", output: buildActivityOutput("Bash", JSON_TEXT) }));
    out.push(assert(
      "★④ 라이브·이력·잡 카드(시작→끝→펼침 실경로) — Read 행 글자·색이 같다 · 이력 Bash JSON 도 같은 색",
      [histLine, liveLine, jobLine].every((f) => JSON.stringify(f.rows) === JSON.stringify(ts.rows) && JSON.stringify(f.rowHl) === JSON.stringify(ts.rowHl)) &&
        histJson.pre === JSON_TEXT && histJson.hl.includes("hljs-attr"),
      show({ histLine: histLine.rowHl, liveLine: liveLine.rowHl, jobLine: jobLine.rowHl, histJson: histJson.hl.length }),
    ));
    const toolFetches = fetches.length;

    // ⑤ 첨부 텍스트 미리보기.
    const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
    fetches = [];
    const attTs = call("(a) => buildAttachmentsPreview([a], { download: true })", { rel: "http-bridge/20261128/abc.ts", name: "sample.ts", mime: "", kind: "file" });
    const attTxt = call("(a) => buildAttachmentsPreview([a], { download: true })", { rel: "http-bridge/20261128/abc.txt", name: "sample.txt", mime: "text/plain", kind: "file" });
    const attMime = call("(a) => buildAttachmentsPreview([a], { download: true })", { rel: "http-bridge/20261128/result", name: "result", mime: "application/json", kind: "file" });
    const attGo = call("(a) => buildAttachmentsPreview([a], { download: true })", { rel: "http-bridge/20261128/gofile", name: "go", mime: "text/plain", kind: "file" });
    await settle();
    const ap = (el: R): R => { const pre = el.querySelector(".att-textpreview"); return { text: pre ? pre.textContent : null, hl: pre ? [...pre.querySelectorAll('[class*="hljs-"]')].length : -1, script: el.querySelectorAll("script").length }; };
    const a1 = ap(attTs), a2 = ap(attTxt), a3 = ap(attMime), a4 = ap(attGo);
    out.push(assert(
      "★⑤ 첨부(.ts) — 받은 글자 800자 그대로 + «…» · 색 · 실행 태그 0 · 요청은 첨부마다 1회(전과 같음) · .txt 는 평문",
      a1.text === ATT_TS.slice(0, 800) + "\n…" && a1.hl > 0 && a1.script === 0 && a2.text === "plain <b>note</b> 그대로" && a2.hl === 0 &&
        fetches.length === 4 && fetches.every((u) => u.startsWith("/api/attachments/")),
      show({ a1: { ...a1, text: String(a1.text).slice(-40) }, a2, fetches }),
    ));
    out.push(assert(
      "★⑤ 이름에 확장자가 없어도 명시된 `application/json` 첨부는 JSON 색 · 점 없는 이름(`go`)의 text/plain 은 평문 · 글자 그대로",
      a3.hl > 0 && a3.text === ATT_JSON && a4.hl === 0 && a4.text === ATT_GO,
      show({ a3, a4 }),
    ));

    // ⑥ 계획 카드 — **언어를 적은 펜스만** 칠한다(답변의 자동 감지는 쓰지 않는다 — 언어 없는 로그까지 칠한다, GPT R1).
    //  마크다운 렌더(정화 포함)는 바뀌지 않았고 미니 DOM 이 그 정화를 못 돌리므로, 진짜 선언을 떼어 렌더 결과만 대역(marked 의 모양)으로 준다.
    const decl = (file: string, name: string): string => {
      const text = readFileSync(path.join(REPO, "packages/dashboard/js", file), "utf8");
      const sf = tsLib.createSourceFile(file, text, tsLib.ScriptTarget.Latest, true, tsLib.ScriptKind.JS);
      const found: string[] = [];
      const visit = (n: import("typescript").Node): void => {
        if (tsLib.isVariableDeclaration(n) && tsLib.isIdentifier(n.name) && n.name.text === name) found.push("const " + n.getText(sf) + ";");
        tsLib.forEachChild(n, visit);
      };
      visit(sf);
      if (found.length !== 1) throw new Error("선언을 하나로 못 찾음: " + name);
      return found[0] as string;
    };
    const planDash = bootDashboard({ clock: makeClock(), i18n: i18nForContext, upTo: "util.js", fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    planDash.run(readFileSync(path.join(REPO, "packages/dashboard/highlight.min.js"), "utf8"), "highlight.min.js");
    // 미니 DOM 의 innerHTML 읽기는 늘 "" 다 — 제품의 «렌더 결과가 비었나» 판정이 브라우저처럼 돌게 자식이 있으면 비지 않은 값으로(이 컨텍스트만).
    planDash.run(`{ const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerHTML"); Object.defineProperty(HTMLElement.prototype, "innerHTML", { get() { return this.childNodes.length ? "<filled>" : ""; }, set: d.set, configurable: true }); }`);
    planDash.run(`window.hljs = hljs; const i18n = (k) => k;
      const renderMarkdown = () => '<p>계획</p><pre><code class="language-ts">const a = &quot;&lt;b&gt;&quot;;</code></pre><pre><code>[INFO] server started\\n[WARN] retry in 5 seconds</code></pre><pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre><pre><code class="language-ts.custom">const x = 1;</code></pre>';
      ${decl("virtualization.js", "HL_TEXT_MAX")}
      ${decl("virtualization.js", "hlHtml")}
      ${decl("virtualization.js", "buildPlanBlock")}`, "plan.js");
    const plan = planDash.run(`(() => { const b = buildPlanBlock("계획"); return [...b.querySelectorAll("pre code")].map((c) => ({ text: c.textContent, hl: c.querySelectorAll('[class*="hljs-"]').length, tags: c.querySelectorAll("b").length })); })()`) as R[];
    out.push(assert(
      "★⑥ 계획 카드 — 언어 펜스(ts)만 색 · 언어 없는 로그·번들에 없는 언어(mermaid·`ts.custom` 을 `ts` 로 자르지 않음)는 평문 · 글자 그대로",
      plan.length === 4 && plan[3]?.hl === 0 && plan[3]?.text === "const x = 1;" && plan[0]?.text === 'const a = "<b>";' && plan[0]?.hl > 0 && plan[0]?.tags === 0 &&
        plan[1]?.hl === 0 && plan[1]?.text === "[INFO] server started\n[WARN] retry in 5 seconds" && plan[2]?.hl === 0 && plan[2]?.text === "graph TD; A-->B",
      show(plan),
    ));

    // ⑦ 비용·폴백.
    const max = dash.run("HL_TEXT_MAX") as number;
    const over = call("(n) => [hlLines('a'.repeat(n + 1), 'typescript'), hlHtml('{}'.padEnd(n + 1, ' '), 'json'), outputLangOf({ text: '{' + ' '.repeat(n) + '}' })]", max);
    dash.run("window.__hl = window.hljs; window.hljs = undefined;");
    const noHl = factsOf(call("(o) => buildReadBlock(o.out, o.file)", { out: readOut, file: tsFile }));
    dash.run("window.hljs = window.__hl;");
    out.push(assert(
      "★⑦ 상한 초과 → 평문(null) — 형식 판별(JSON.parse)도 상한 뒤 · hljs 없음 → 평문·글자 그대로 · 도구 출력을 그리는 동안 요청 0",
      typeof max === "number" && max > 0 && over[0] === null && over[1] === null && over[2] === null && noHl.hl.length === 0 &&
        JSON.stringify(noHl.rows) === JSON.stringify(SRC) && toolFetches === 0,
      show({ max, over, noHl: noHl.hl.length, toolFetches, bootFetches: bootFetches.length }),
    ));
    if (clock.errors.length > 0) out.push(assert("비동기 오류 없음", false, clock.errors));
    return out;
  },
};
