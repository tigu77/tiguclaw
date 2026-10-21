/**
 * `file-view-current-file` 의 자식 프로세스 — **검사와 읽기 사이 경합**을 진짜 라우트 함수에 주입한다(아스트라 10-21 재현 그대로).
 *
 * ★자식으로 도는 이유: 내장 `fs/promises.open` 을 잠시 갈아 끼운다 — 같은 프로세스의 다른 검사에 새면 안 된다.
 * 주입 순서(`open` 을 감싼다):
 *   · `swapBefore` — 열기 **직전** 대상을 프로젝트 밖 파일을 가리키는 심링크로 바꾼다
 *   · `swapAfter`  — 연 **직후** 같은 교체(연 것은 원래 파일, 경로는 밖)
 *   · `replaceAfter` — 연 직후 같은 이름의 **다른 파일**로 바꾼다(경로 판정은 통과 · 파일이 다르다)
 *   · `growOnRead` — 첫 읽기 직전 같은 파일을 2MB+1 로 키운다(연 뒤 커짐 — 상한+1 까지만 읽어야 한다)
 *   · `none` — 정상
 * 결과를 마지막 줄 JSON 으로 낸다.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MODES = ["none", "swapBefore", "swapAfter", "replaceAfter", "growOnRead"] as const;
const { initStore } = await import("../../store/sessions.js");
const { upsertProject } = await import("../../store/projects.js");
initStore();
const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-fvrace-")));
const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-fvrace-out-")));
upsertProject({ path: root, name: "regr-fvrace", status: "active" } as never);
const target = path.join(root, "a.txt");
const outside = path.join(outsideDir, "outside.txt");
fs.writeFileSync(outside, "SYNTHETIC_OUTSIDE");
const swapToOutside = (): void => { fs.unlinkSync(target); fs.symlinkSync(outside, target); };
const originalOpen = fsp.open;
let mode: (typeof MODES)[number] = "none";
let readBytes = 0; // 라우트가 실제로 읽은 양 — «상한+1 까지만» 을 응답 코드가 아니라 읽은 양으로 잰다
(fsp as { open: typeof fsp.open }).open = (async (p: fs.PathLike, ...rest: unknown[]) => {
  if (String(p) !== target) return (originalOpen as (...a: unknown[]) => Promise<fsp.FileHandle>)(p, ...rest);
  if (mode === "swapBefore") swapToOutside();
  const fh = await (originalOpen as (...a: unknown[]) => Promise<fsp.FileHandle>)(p, ...rest);
  if (mode === "swapAfter") swapToOutside();
  if (mode === "replaceAfter") { fs.unlinkSync(target); fs.writeFileSync(target, "OTHER_FILE"); }
  if (mode === "growOnRead") {
    const read = fh.read.bind(fh);
    let first = true;
    (fh as { read: unknown }).read = (async (...a: unknown[]) => {
      if (first) { first = false; fs.writeFileSync(target, "x".repeat(3 * 1024 * 1024)); } // 같은 파일(inode)을 상한보다 훨씬 크게 — 읽은 양이 상한+1 에서 멈추는지 보이게
      const r = (await (read as (...x: unknown[]) => Promise<{ bytesRead: number }>)(...a));
      readBytes += r.bytesRead;
      return r;
    }) as never;
  }
  return fh;
}) as typeof fsp.open;
// plugins/ 를 문자 그대로 import 하지 않는다(build 경계 — `src-stays-inside-src`). 다른 회귀의 `loadPluginModule` 과 같은 방식.
const { handleFileView } = (await import(new URL("../../../plugins/http-bridge/routes-files.ts", import.meta.url).href)) as {
  handleFileView: (c: unknown) => Promise<void>;
};
const out: Record<string, { status: number; bytes?: number; outside: boolean; other: boolean; readBytes?: number }> = {};
try {
  for (const m of MODES) {
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, "small");
    mode = m;
    const res = { status: 0, body: "", writeHead(s: number) { res.status = s; return res; }, setHeader() {}, end(b?: string) { res.body = b ?? ""; } };
    await handleFileView({ res, url: new URL("http://x/file-view?path=" + encodeURIComponent(target)) } as never);
    const d = JSON.parse(res.body || "{}") as { content?: string };
    out[m] = { status: res.status, bytes: d.content?.length, outside: d.content === "SYNTHETIC_OUTSIDE", other: d.content === "OTHER_FILE", ...(m === "growOnRead" ? { readBytes } : {}) };
  }
} finally {
  (fsp as { open: typeof fsp.open }).open = originalOpen;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
