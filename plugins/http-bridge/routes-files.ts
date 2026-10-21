/**
 * **파일 라우트** — 첨부 서빙 · 전사 · 경로 열기.
 *
 * ★`/open-path` 가 크다(299줄) — 사용자 머신의 파일·폴더를 여는 자리라 **경로 검증**이
 *  대부분이다. 열어주는 것보다 안 열어주는 판정이 길다.
 * ★`/attachments/` 는 프리픽스 라우트다(그 아래 임의 경로).
 */
import * as nodeFs from "node:fs";
import { systemOpener } from "../../src/core/onboard-ready.js";
import crypto from "node:crypto";
import { resolveTranscriptionProvider } from "../../src/core/llm-runtime/transcription/index.js";
import { translate } from "../../src/core/i18n.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { getPaths } from "../../src/core/paths.js";
import { listProjects } from "../../src/store/projects.js";
import { ATTACH_MAX_FILE_BYTES, AUDIO_EXT_BY_MIME, CONTENT_TYPE_BY_EXT, contentDispositionFor } from "./attachments.js";
import { BODY_LIMIT_AUDIO, readJsonBody, bodyErrorStatus } from "./http-body.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import path from "node:path";
import type { RouteCtx } from "./route-ctx.js";

/**
 * `GET /plugin-icon?name=<플러그인>` — 그 플러그인이 선언한 아이콘 파일.
 *
 * ★선언이 없거나 파일이 없으면 **404** 다. 화면은 그때 기본 아이콘을 그린다(사용자 지정:
 *  *"비어있으면 그냥 기본 아이콘으로"*). 여기서 기본 아이콘을 대신 내보내지 않는다 —
 *  그러면 «선언했는데 파일이 없다» 와 «선언을 안 했다» 가 화면에서 구분이 안 된다.
 *
 * ★안전은 셋으로 막는다:
 *  ① 매니페스트 파서가 `..`·절대경로·비래스터를 **애초에 안 담는다**
 *  ② 여기서 심링크를 풀고 **플러그인 폴더 안인지 다시 검사**한다(첨부 서빙이 심링크로
 *    한 번 뚫린 전례가 있다 — 같은 엄격도로 맞춘다)
 *  ③ 확장자에서 content-type 을 **고정 표**로 정한다(파일이 이름을 정하게 두지 않는다)
 */
export const handlePluginIcon = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  const name = (url.searchParams.get("name") ?? "").trim();
  // 자리는 둘(번들 + 홈) — `routes-inventory` 의 설정 쓰기가 쓰는 그 조회와 같은 모양이다.
  const { scanPluginManifests } = await import("../../src/core/plugins/loader.js");
  const { appRoot, getPaths } = await import("../../src/core/paths.js");
  const found = (
    await Promise.all(
      [path.join(appRoot(), "plugins"), getPaths().commonPlugins].map((root) =>
        scanPluginManifests(root),
      ),
    )
  )
    .flat()
    .find((x) => x.manifest.name === name);
  const icon = found?.manifest.meta?.icon;
  if (found === undefined || typeof icon !== "string" || icon === "") {
    writeJson(res, 404, { error: "no icon" });
    return;
  }
  const abs = path.resolve(found.pluginDir, icon);
  let real: string;
  let realDir: string;
  try {
    real = nodeFs.realpathSync(abs);
    realDir = nodeFs.realpathSync(found.pluginDir);
  } catch {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  if (real !== realDir && !real.startsWith(realDir + path.sep)) {
    writeJson(res, 403, { error: "outside plugin dir" });
    return;
  }
  const type = real.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
  let bytes: Buffer;
  try {
    bytes = nodeFs.readFileSync(real);
  } catch {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": String(bytes.length),
    // 아이콘은 자주 안 바뀐다 — 매 렌더마다 다시 받지 않게. 바뀌면 새로고침으로 족하다.
    "Cache-Control": "private, max-age=300",
  });
  res.end(bytes);
};

export const handleAttachmentServe = async (ctx: RouteCtx): Promise<void> => {
  const { res, pathname, url } = ctx;
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
    // 받는 이름 — 화면이 원래 이름을 `?name=` 으로 싣는다(저장 이름은 해시라). `download=1` 이면 안전한 형식도 저장으로.
    const wanted = url.searchParams.get("name") ?? "";
    const asDownload = url.searchParams.get("download") === "1" || !inlineSafe;
    const disposition =
      asDownload || wanted !== ""
        ? contentDispositionFor(asDownload ? "attachment" : "inline", wanted, path.basename(abs))
        : undefined;
    res.writeHead(200, {
      "Content-Type": ctype,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:",
      ...(disposition !== undefined ? { "Content-Disposition": disposition } : {}),
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
  const { req, res } = ctx;
  let tbody: Record<string, unknown>;
  try {
    // 오디오(base64)가 오는 경로 — 상한은 파일당 첨부 한도에서 유도된다.
    tbody = await readJsonBody(req, BODY_LIMIT_AUDIO);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, bodyErrorStatus(e), { error: `invalid body: ${m}` });
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
    writeJson(res, 400, { error: translate("srv.transcribe.empty") });
    return;
  }
  if (buf.length > ATTACH_MAX_FILE_BYTES) {
    writeJson(res, 400, {
      error: translate("srv.transcribe.tooBig", { mb: ATTACH_MAX_FILE_BYTES / 1024 / 1024 }),
    });
    return;
  }
  // provider 해석은 저장 전에(미설정이면 파일 안 만들고 조기 종료). cwd = 데몬 루트(dev 홈은
  // TIGUCLAW_HOME 이 아닌 settings 레이어가 해석 — loadTranscriptionConfig 가 홈/프로젝트 병합).
  const resolved = resolveTranscriptionProvider(process.cwd());
  if (resolved === null) {
    writeJson(res, 200, {
      error: translate("srv.transcribe.notConfigured"),
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
    writeJson(res, 200, { error: translate("srv.transcribe.failed", { msg }) });
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

/**
 * 경로 → **등록 프로젝트 루트 하위의 실제 경로**(2026-10-21 「↗ 열기」에서 뽑았다 — «지금 파일에서 보기» 읽기와 **같은 판정**을 쓰게).
 *  ①심링크 탈출: realpath 로 실제 대상까지 풀고 **다시** 루트 하위인지 본다 ②루트도 실제 경로로 — 양쪽을 같은 기준에 놓는다.
 */
export const resolveInProject = (
  pathIn: string,
): { real: string; st: import("node:fs").Stats } | { status: number; error: string } => {
  const abs = nodePath.resolve(pathIn);
  let real: string;
  try {
    real = nodeFs.realpathSync(abs);
  } catch {
    return { status: 404, error: translate("srv.openPath.notFound") };
  }
  const roots = listProjects().map((p) => {
    const r = nodePath.resolve(p.path);
    try {
      return nodeFs.realpathSync(r);
    } catch {
      return r; // 루트가 사라졌으면 원경로로 비교(어차피 하위도 존재 안 함).
    }
  });
  if (!roots.some((r) => real === r || real.startsWith(r + nodePath.sep))) {
    return { status: 403, error: translate("srv.openPath.notProject") };
  }
  try {
    return { real, st: nodeFs.statSync(real) };
  } catch {
    return { status: 404, error: translate("srv.openPath.notFound") };
  }
};

/** «지금 파일에서 보기» 가 읽을 수 있는 크기 — 관측의 시작 줄 계산과 같은 상한(최악 ~9ms). */
export const FILE_VIEW_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 비밀 파일인가 — 이름이 `.env`·`.env.*` 이거나 경로 조각에 `.git`·`.ssh`·`.aws` 가 있다(2026-10-21 설계 §2.2 · `.ssh`·`.aws` 는 범위를 연 날 더했다).
 *  ★읽기는 내용이 HTTP 로 나간다 — tiguclaw 레포 자신이 프로젝트로 등록돼 있어 `.env`(봇 토큰)가 범위 안이다. 손 목록을 키우지 않는다.
 *  ★**대소문자를 가리지 않는다**(10-21 적대 검토 — macOS·Windows 기본 파일시스템은 `.ENV` 로 `.env` 가 열린다, 실측 200 · 비밀 내용).
 */
export const isSecretPath = (p: string): boolean => {
  const parts = p.toLowerCase().split(/[\\/]+/);
  const name = parts[parts.length - 1] ?? "";
  return name === ".env" || name.startsWith(".env.") || parts.includes(".git") || parts.includes(".ssh") || parts.includes(".aws");
};

/**
 * `GET /file-view?path=<절대경로>` — Edit·Write 카드의 «지금 파일에서 보기»(2026-10-21 설계 v2). 지금 디스크의 내용을 **읽기만** 한다.
 *  판정 = 읽기 규칙(상대 경로 거절 · 비밀 파일은 심링크 **전후** 둘 다 · 일반 파일 · 2MB · NUL 이면 바이너리). 범위는 어떤 경로든(10-21 정태님 —
 *  처음엔 「↗ 열기」와 같은 «등록 프로젝트 하위» 였다).
 *  ★판정은 **열기 전과 연 뒤 두 번** — 연 뒤엔 연 파일과 그 경로의 파일이 같은지까지 본다(검사·읽기 사이 경합). 아무것도 저장하지 않는다.
 */
export const handleFileView = async (ctx: RouteCtx): Promise<void> => {
  const { res, url } = ctx;
  const pathIn = (url.searchParams.get("path") ?? "").trim();
  if (pathIn === "" || !nodePath.isAbsolute(pathIn)) {
    writeJson(res, 400, { error: translate("srv.fileView.needAbsolute") });
    return;
  }
  // 판정 하나 — 연 **뒤에도** 같은 것을 다시 본다(아래).
  const judge = (): { status: number; error: string } | { real: string; st: import("node:fs").Stats } => {
    if (isSecretPath(pathIn)) return { status: 403, error: translate("srv.fileView.secret") };
    // ★범위는 **어떤 경로든**(2026-10-21 정태님 «유저가 풀권한이라 큰 문제가 아니다» — 대시보드에 닿는 사람은 이미 비서에게 아무 파일이나
    //  읽게 할 수 있다). 프로젝트 하위 제한은 「↗ 열기」(OS 앱으로 **실행**하는 길)에만 남긴다. 비밀 파일 거절은 유지 — 토큰이 화면에 뜨지 않게.
    //  ★전제: 대시보드에 닿는 사람 = 비서를 마음대로 쓰는 주인. **사용자별 권한이 생기면 이 범위를 그 권한에 묶는다**(정태님 같은 날).
    let found: { real: string; st: import("node:fs").Stats };
    try {
      // ★`.native` — 디스크가 아는 **진짜 이름**을 돌려준다. JS 판은 입력한 대소문자를 그대로 둬(`.ENV` → `.ENV`) 판정이 별칭을 봤다.
      //  Windows 에선 8.3 짧은 이름·끝 점/공백 같은 별칭도 진짜 이름으로 펴진다(최종 경로 이름).
      const real = nodeFs.realpathSync.native(pathIn);
      found = { real, st: nodeFs.statSync(real) };
    } catch {
      return { status: 404, error: translate("srv.fileView.notFound") };
    }
    if (isSecretPath(found.real)) return { status: 403, error: translate("srv.fileView.secret") };
    if (!found.st.isFile()) return { status: 403, error: translate("srv.fileView.notFile") };
    if (found.st.size > FILE_VIEW_MAX_BYTES) return { status: 413, error: translate("srv.fileView.tooBig") };
    return found;
  };
  // ① 열기 전 — 빨리 거절한다(비밀·특수 파일은 열지도 않는다: FIFO 를 열면 요청이 매달린다).
  const before = judge();
  if ("status" in before) {
    writeJson(res, before.status, { error: before.error });
    return;
  }
  // ② ★**연 다음에 다시 본다**(아스트라 10-21 경합 — 검사 뒤 읽기 전에 파일이 바뀌면 검사가 읽은 내용에 안 닿았다:
  //  밖을 가리키는 심링크로 교체 → 밖 내용 200 · 5B → 2MB+1 → 200). 계약: **연 파일 = 연 뒤 다시 판정한 그 경로의 파일**
  //  (장치·파일 번호, bigint — Windows 파일 id 가 커서 number 로는 뭉개진다). 크기·종류는 연 파일에서, 읽기도 상한+1 까지만.
  //  O_NONBLOCK: 그 사이 FIFO 로 바뀌어도 열기가 매달리지 않게(일반 파일엔 효과 없음 · Windows 엔 없다 — 그쪽은 "r").
  const flags = typeof nodeFs.constants.O_NONBLOCK === "number" ? nodeFs.constants.O_RDONLY | nodeFs.constants.O_NONBLOCK : "r";
  let fh: import("node:fs/promises").FileHandle;
  try {
    fh = await fs.open(pathIn, flags);
  } catch {
    writeJson(res, 404, { error: translate("srv.fileView.cantOpen") });
    return;
  }
  try {
    const opened = await fh.stat({ bigint: true });
    const after = judge();
    if ("status" in after) {
      writeJson(res, after.status, { error: after.error });
      return;
    }
    let atPath: import("node:fs").BigIntStats;
    try {
      atPath = nodeFs.statSync(after.real, { bigint: true });
    } catch {
      writeJson(res, 409, { error: translate("srv.fileView.changing") });
      return;
    }
    if (atPath.dev !== opened.dev || atPath.ino !== opened.ino) {
      writeJson(res, 409, { error: translate("srv.fileView.changing") });
      return;
    }
    if (!opened.isFile()) {
      writeJson(res, 403, { error: translate("srv.fileView.notFile") });
      return;
    }
    // 상한+1 바이트까지만 읽는다 — 연 뒤에 커져도 무제한으로 읽지 않는다(크기는 열기 전 판정이 이미 봤고, 그 뒤 커진 것은 여기서 걸린다).
    const buf = Buffer.alloc(FILE_VIEW_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n >= buf.length) break;
    }
    if (n > FILE_VIEW_MAX_BYTES) {
      writeJson(res, 413, { error: translate("srv.fileView.tooBig") });
      return;
    }
    const data = buf.subarray(0, n);
    if (data.includes(0)) {
      writeJson(res, 415, { error: translate("srv.fileView.binary") });
      return;
    }
    writeJson(res, 200, { content: data.toString("utf8") });
  } catch {
    writeJson(res, 404, { error: translate("srv.fileView.cantRead") });
  } finally {
    await fh.close().catch(() => {});
  }
};

export const handleOpenPath = async (ctx: RouteCtx): Promise<void> => {
  const { req, res } = ctx;
  let obody: Record<string, unknown>;
  try {
    obody = await readJsonBody(req);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    writeJson(res, bodyErrorStatus(e), { error: `invalid body: ${m}` });
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
  const found = resolveInProject(pathIn);
  if ("status" in found) {
    writeJson(res, found.status, { error: found.error });
    return;
  }
  const { real, st } = found;
  if (st.isFile() && (st.mode & 0o111) !== 0) {
    writeJson(res, 403, {
      error: translate("srv.openPath.executable"),
    });
    return;
  }
  if (!st.isFile() && !st.isDirectory()) {
    writeJson(res, 403, { error: translate("srv.openPath.notRegular") });
    return;
  }
  const match = { path: real };
  // OS 기본 앱으로 연다(판정은 코어 한 곳 — 온보딩의 브라우저 열기와 같다). 폴더 열기는 fire-and-forget(즉시 200).
  // Windows explorer 는 성공해도 exit 1 을 내는 알려진 quirk → win32 는 에러를 무시한다.
  const opener = systemOpener(process.platform);
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
