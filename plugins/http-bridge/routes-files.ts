/**
 * **파일 라우트** — 첨부 서빙 · 전사 · 경로 열기.
 *
 * ★`/open-path` 가 크다(299줄) — 사용자 머신의 파일·폴더를 여는 자리라 **경로 검증**이
 *  대부분이다. 열어주는 것보다 안 열어주는 판정이 길다.
 * ★`/attachments/` 는 프리픽스 라우트다(그 아래 임의 경로).
 */
import * as nodeFs from "node:fs";
import crypto from "node:crypto";
import { resolveTranscriptionProvider } from "../../src/core/llm-runtime/transcription/index.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { getPaths } from "../../src/core/paths.js";
import { listProjects } from "../../src/store/projects.js";
import { ATTACH_MAX_FILE_BYTES, AUDIO_EXT_BY_MIME, CONTENT_TYPE_BY_EXT, sanitizeFilename } from "./attachments.js";
import { readJsonBody } from "./http-body.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import path from "node:path";
import type { RouteCtx } from "./route-ctx.js";

export const handleAttachmentServe = async (ctx: RouteCtx): Promise<void> => {
  const { res, pathname } = ctx;
  try {
    const rel = decodeURIComponent(pathname.slice("/attachments/".length));
    const dir = getPaths().attachmentsDir;
    const abs = path.resolve(dir, rel);
    // ★**심링크를 풀고 다시 검사한다** (2026-08-17, 전체검토 C-L1 실증).
    //  `path.resolve` + 접두 비교는 `..` 는 막지만 **심링크는 못 막는다** — 첨부
    //  디렉터리 안의 링크 하나로 홈 밖 파일이 200 으로 나갔다(실측:
    //  `GET /attachments/link.txt` → 홈 밖 파일 내용, 로그 0줄).
    //  ★같은 파일의 `/open-path` 는 이미 `realpathSync` 로 풀고 다시 검사하며 회귀가
    //   그걸 강제한다(`open-path-safety`). 두 경로가 같은 파일 안에서 비대칭이었고
    //   하필 **파일 내용을 밖으로 내보내는 쪽**이 약했다 — 엄격도를 맞춘다.
    //  ★없는 파일은 realpath 가 throw 한다 → 404 로(존재 여부를 403/404 로 흘리지 않게
    //   기존 흐름 유지: 아래 readFile 이 null 이면 404).
    let real: string;
    try {
      real = nodeFs.realpathSync(abs);
    } catch {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    const realDir = ((): string => {
      try {
        return nodeFs.realpathSync(dir);
      } catch {
        return dir;
      }
    })();
    if (!(real === realDir || real.startsWith(realDir + path.sep))) {
      writeJson(res, 403, { error: "forbidden" });
      return;
    }
    const buf = await fs.readFile(real).catch(() => null);
    if (buf === null) {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    const ext = path.extname(real).replace(/^\./, "").toLowerCase();
    const ctype = CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
    // ★inline 실행 차단 3종 (2026-07-31 전체검토 P0):
    //  ①nosniff — 브라우저가 내용을 보고 타입을 추측(sniff)해 HTML/SVG 로 실행하는 것 차단.
    //  ②알려진 안전 타입이 아니면 `attachment` — 다운로드로만 열리고 렌더되지 않는다.
    //  ③CSP sandbox — 혹시 렌더돼도 스크립트·같은 오리진 권한이 없다.
    const inlineSafe = CONTENT_TYPE_BY_EXT[ext] !== undefined;
    res.writeHead(200, {
      "Content-Type": ctype,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:",
      ...(inlineSafe
        ? {}
        : { "Content-Disposition": `attachment; filename="${sanitizeFilename(path.basename(abs))}"` }),
      "Cache-Control": "private, max-age=86400",
      "Content-Length": buf.length,
    });
    res.end(buf);
  } catch (e) {
    writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
  return;
};

export const handleTranscribe = async (ctx: RouteCtx): Promise<void> => {
  const { req, res, pathname } = ctx;
  let tbody: Record<string, unknown>;
  try {
    tbody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const dataBase64 = typeof tbody.dataBase64 === "string" ? tbody.dataBase64 : "";
  const mimeRaw =
    typeof tbody.mimeType === "string" && tbody.mimeType !== ""
      ? tbody.mimeType
      : "audio/webm";
  if (dataBase64 === "") {
    writeJson(res, 400, { error: "dataBase64 required" });
    return;
  }
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length === 0) {
    writeJson(res, 400, { error: "빈 오디오" });
    return;
  }
  if (buf.length > ATTACH_MAX_FILE_BYTES) {
    writeJson(res, 400, {
      error: `오디오가 한도(${ATTACH_MAX_FILE_BYTES / 1024 / 1024}MB)를 초과합니다.`,
    });
    return;
  }
  // provider 해석은 저장 전에(미설정이면 파일 안 만들고 조기 종료). cwd = 데몬 루트(dev 홈은
  // TIGUCLAW_HOME 이 아닌 settings 레이어가 해석 — loadTranscriptionConfig 가 홈/프로젝트 병합).
  const resolved = resolveTranscriptionProvider(process.cwd());
  if (resolved === null) {
    writeJson(res, 200, {
      error: "전사가 설정되지 않았습니다 (settings.json transcription).",
    });
    return;
  }
  const mime = (mimeRaw.split(";")[0] ?? "audio/webm").trim();
  const ext = AUDIO_EXT_BY_MIME[mime] ?? "webm";
  const tmpDir = path.join(getPaths().attachmentsDir, "transcribe");
  let tmpPath = "";
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    tmpPath = path.join(
      tmpDir,
      `${crypto.randomBytes(8).toString("hex")}.${ext}`,
    );
    await fs.writeFile(tmpPath, buf);
    const text = await resolved.provider.transcribe({
      filePath: tmpPath,
      mimeType: mime,
      language: resolved.language,
    });
    writeJson(res, 200, { text: text.trim() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[transcribe] 실패 — ${msg}`);
    writeJson(res, 200, { error: `전사 실패: ${msg}` });
  } finally {
    if (tmpPath !== "") {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* 임시파일 정리 실패 무해(다음 부팅·OS 청소) */
      }
    }
  }
  return;
};

export const handleOpenPath = async (ctx: RouteCtx): Promise<void> => {
  const { req, res, pathname } = ctx;
  let obody: Record<string, unknown>;
  try {
    obody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, 400, { error: `invalid body: ${m}` });
    return;
  }
  const pathIn =
    typeof obody.path === "string" ? obody.path.trim() : "";
  if (pathIn === "") {
    writeJson(res, 400, { error: "path required" });
    return;
  }
  // ★파일 열기 확장 (2026-08-02) — 종전엔 **정확일치(등록 프로젝트 폴더)** 만 허용했다.
  //  편집 카드의 파일도 열려면 "등록 프로젝트 **루트 하위**" 로 넓혀야 한다. 넓히는
  //  만큼 두 가지를 닫는다:
  //   ①**심링크 탈출** — resolve 만으론 `<proj>/link → /etc` 를 못 막는다. realpath 로
  //     실제 대상까지 풀고 **다시** 루트 하위인지 본다(존재하지 않으면 애초에 못 연다).
  //   ②**실행** — macOS `open` 은 `.app`·실행권한 파일을 **실행**한다. 우리는 소스를
  //     *보려는* 것이지 실행하려는 게 아니므로 실행권한이 있으면 거부한다. 디렉터리는
  //     종전대로 허용(폴더 열기가 원래 용도).
  const abs = nodePath.resolve(pathIn);
  let real: string;
  try {
    real = nodeFs.realpathSync(abs);
  } catch {
    writeJson(res, 404, { error: "경로가 존재하지 않습니다" });
    return;
  }
  const roots = listProjects().map((p) => {
    const r = nodePath.resolve(p.path);
    try {
      return nodeFs.realpathSync(r); // 루트도 실제 경로로 — 양쪽을 같은 기준에 놓는다.
    } catch {
      return r; // 루트가 사라졌으면 원경로로 비교(어차피 하위도 존재 안 함).
    }
  });
  const inRoot = roots.some(
    (r) => real === r || real.startsWith(r + nodePath.sep),
  );
  if (!inRoot) {
    writeJson(res, 403, {
      error: "등록된 프로젝트 경로가 아닙니다(허용된 경로만 열 수 있음)",
    });
    return;
  }
  let st: import("node:fs").Stats;
  try {
    st = nodeFs.statSync(real);
  } catch {
    writeJson(res, 404, { error: "경로가 존재하지 않습니다" });
    return;
  }
  if (st.isFile() && (st.mode & 0o111) !== 0) {
    writeJson(res, 403, {
      error: "실행 권한이 있는 파일은 열지 않습니다(실행 위험) — 편집기에서 직접 여세요",
    });
    return;
  }
  if (!st.isFile() && !st.isDirectory()) {
    writeJson(res, 403, { error: "일반 파일·디렉터리만 열 수 있습니다" });
    return;
  }
  const match = { path: real };
  // darwin=open · win32=explorer · 그 외=xdg-open. 폴더 열기는 fire-and-forget(즉시 200).
  // Windows explorer 는 성공해도 exit 1 을 내는 알려진 quirk → win32 는 에러를 무시한다.
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  execFile(opener, [match.path], (err) => {
    if (err !== null && process.platform !== "win32") {
      console.warn(
        `http-bridge: open-path 실패(${opener} ${match.path}) — ${err.message}`,
      );
    }
  });
  writeJson(res, 200, { ok: true, path: match.path });
  return;
};
