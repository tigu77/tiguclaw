/**
 * 회귀: **첨부의 보이는 이름은 원래 이름(한글 포함)이고, 저장 이름·헤더 대체만 ASCII 다** (2026-10-28).
 *
 * 사고: 대시보드로 올린 `회사돌쇠전달.md` 가 이력·모델 입력에 `.md` 로, 비서가 보낸 `VB개선안.md` 가 `VB.md` 로 남았다.
 *  ASCII 대체용 `sanitizeFilename` 을 표시 이름에도 써서 한글이 지워졌다(받기 헤더는 10-16 에 따로 고쳐 원래 이름을 실었지만,
 *  화면이 넘기는 이름 자체가 이미 잘려 있었다).
 *
 * 본다: ① 업로드(ingest)·송신(outbound) 의 이름 = 원래 이름 · 저장 경로는 `<hex>.<ASCII 확장자>` 로 첨부 디렉터리 안
 *  ② 경로 문자·제어/방향 제어 문자·짝 없는 서로게이트는 이름에서 빠진다(인코딩이 던지지 않는다) · 이름이 비면 `file`
 *  ③ 받기 헤더가 그 이름을 그대로 `filename*` 로 싣는다 · ASCII 대체는 그대로
 *  ④ [배선] 이력 메타가 그 이름을 그대로 쓴다(`name: a.filename`)
 *
 * 등급: **실행**(격리 홈에 실제로 쓴다) + ④ 배선(소스).
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "attachment-name-keeps-unicode",
  guards: "한글 첨부 이름이 업로드·송신에서 지워지던 것(회사돌쇠전달.md→.md, VB개선안.md→VB.md) — 표시 이름과 ASCII 대체를 한 함수가 겸했다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "attname-"));
    const prevHome = process.env.TIGUCLAW_HOME;
    process.env.TIGUCLAW_HOME = home;
    const { __resetPathsCache, getPaths } = await import("../../core/paths.js");
    __resetPathsCache();
    try {
      const mod = (await import(new URL("../../../plugins/http-bridge/attachments.js", import.meta.url).href)) as {
        ingestAttachments: (raw: unknown, channel: string) => Promise<Array<{ filename: string; path: string; mimeType: string }>>;
        persistOutboundAttachment: (src: string, channel: string) => Promise<{ rel: string; name: string } | null>;
        contentDispositionFor: (type: "inline" | "attachment", wanted: string, stored: string) => string;
      };
      const b64 = (s: string): string => Buffer.from(s).toString("base64");
      const dir = getPaths().attachmentsDir;
      const storedOk = (p: string): boolean =>
        p.startsWith(dir + path.sep) && /^[0-9a-f]{16}\.[\w\- ]{1,8}$/.test(path.basename(p));

      const ins = await mod.ingestAttachments(
        [
          { filename: "회사돌쇠전달.md", mimeType: "text/markdown", dataBase64: b64("# 전달") },
          { filename: "../../밖/보고서.txt", mimeType: "text/plain", dataBase64: b64("x") },
          { filename: "a\uD800b\uDFFF.txt", mimeType: "text/plain", dataBase64: b64("y") },
          { filename: "보고서\u202Etxt.exe\u0007", mimeType: "application/octet-stream", dataBase64: b64("z") },
          { filename: "파일.한글", mimeType: "application/octet-stream", dataBase64: b64("w") },
          { filename: "\u0001\u202E", mimeType: "text/plain", dataBase64: b64("v") },
          { filename: "plain-name.CSV", mimeType: "text/csv", dataBase64: b64("q") },
        ],
        "http-bridge",
      );
      const names = ins.map((a) => a.filename);
      const exts = ins.map((a) => path.extname(a.path));

      const srcDir = mkdtempSync(path.join(home, "src-"));
      const src = path.join(srcDir, "VB개선안.md");
      writeFileSync(src, "# 개선안");
      const outb = await mod.persistOutboundAttachment(src, "http-bridge");
      const outAbs = outb !== null ? path.join(dir, ...outb.rel.split("/")) : "";

      const disp = mod.contentDispositionFor("attachment", names[0] ?? "", "abcdef0123456789.md");
      const star = decodeURIComponent((disp.match(/filename\*=UTF-8''(.+)$/) ?? [])[1] ?? "");
      let loneOk = true;
      let loneDisp = "";
      try { loneDisp = mod.contentDispositionFor("attachment", "x\uDC00y.pdf", "abc.pdf"); } catch { loneOk = false; }

      const index = stripComments(readSourceSync("src/index.ts"));
      return [
        assert(
          "★① 업로드 이름 = 원래 이름(한글) · 저장은 해시+ASCII 확장자로 첨부 디렉터리 안",
          names[0] === "회사돌쇠전달.md" && exts[0] === ".md" && names[6] === "plain-name.CSV" && exts[6] === ".csv" &&
            ins.every((a) => storedOk(a.path)) && readFileSync(ins[0]!.path, "utf8") === "# 전달",
          { names, exts, stored: ins.map((a) => path.basename(a.path)) },
        ),
        assert(
          "★① 송신(send_file) 이름 = 원래 이름 · 서빙 rel 은 ASCII",
          outb !== null && outb.name === "VB개선안.md" && /^[\x20-\x7e]+$/.test(outb.rel) && storedOk(outAbs),
          outb,
        ),
        assert(
          "② 경로 문자는 `_` · 제어/방향 제어·짝 없는 서로게이트는 빠진다 · 다 빠지면 `file` · 한글 확장자는 저장에 안 쓴다",
          names[1] === ".._.._밖_보고서.txt" && names[2] === "ab.txt" && names[3] === "보고서txt.exe" &&
            names[5] === "file" && names[4] === "파일.한글" && exts[4] === ".bin" &&
            names.every((n) => { try { encodeURIComponent(n); JSON.stringify(n); return true; } catch { return false; } }),
          { names, exts },
        ),
        assert(
          "③ 받기 헤더가 그 이름을 그대로 filename* 로 싣고 · ASCII 대체는 저장 이름 · 짝 없는 서로게이트도 던지지 않는다",
          star === "회사돌쇠전달.md" && /filename="abcdef0123456789\.md"/.test(disp) && loneOk &&
            decodeURIComponent((loneDisp.match(/filename\*=UTF-8''(.+)$/) ?? [])[1] ?? "") === "xy.pdf",
          { disp, loneDisp },
        ),
        assert(
          "④ [배선] 이력 메타가 첨부 이름을 그대로 쓴다(다시 거르지 않는다)",
          /name: a\.filename,/.test(index),
          "src/index.ts attachmentsMeta",
        ),
      ];
    } finally {
      process.env.TIGUCLAW_HOME = prevHome;
      __resetPathsCache();
    }
  },
};
