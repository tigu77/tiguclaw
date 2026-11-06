/**
 * 회귀: **외부 MCP 설정을 동시에 고쳐도 하나도 안 사라진다** (2026-10-08 외부 검토 F3).
 *
 * 사고(검토 재현): `add_mcp_server` 두 개가 겹치면(병렬 도구 호출) 각자 mcp.json 을 읽고 각자 써서, 나중에 쓴 쪽이 먼저 쓴 쪽을
 * 지웠다 — 격리 홈에서 둘을 `Promise.all` 로 넣으면 5회 중 5회 한 항목만 남았다.
 *
 * 등급: **동작** — 실제 upsert/remove 를 격리 홈의 실제 파일에 동시에 돌린다.
 */
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeExternalMcpServer, upsertExternalMcpServer } from "../../core/external-mcp.js";
import { getPaths } from "../../core/paths.js";
import { assert, assertIsolated, loadPluginModule, skip, type Assertion, type RegressionCheck } from "./_framework.js";
import type { TestLinks } from "./file-link-refusal-continues.js";

/** 파일 symlink 가 있어야만 성립하는 단언 — 그 생성이 거부되는 환경(무권한 Windows)에선 이것만 미실행으로 남는다. */
const SYMLINK_IN_PLACE = "★제자리에 쓴다 — 심링크는 심링크로(원본에 추가) · 권한 0600 유지 · mcpServers 밖의 최상위 키 보존";
/** 파일 symlink 없이도 도는 추가 단언 — rename 교체 회귀(P4)를 잡는다. 심링크 보존 일반을 대신하지는 않는다. */
const HARDLINK_IN_PLACE = "하드링크 .mcp.json 도 제자리에 쓴다 — 원본이 새 서버를 받고 ino/dev 동일(rename 교체 아님) · mcpServers 밖 최상위 키 보존";
export const FILE_LINK_ASSERTIONS: readonly string[] = [SYMLINK_IN_PLACE];
export const LINK_FREE_COVERAGE: readonly string[] = [HARDLINK_IN_PLACE];

const names = (): string[] => {
  try {
    const j = JSON.parse(readFileSync(path.join(getPaths().home, "mcp.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
    return Object.keys(j.mcpServers ?? {}).filter((n) => n.startsWith("regr-conc-")).sort();
  } catch {
    return [];
  }
};

export const check: RegressionCheck = {
  name: "mcp-config-concurrent-writes",
  guards: "외부 MCP 서버를 동시에 추가·제거하면 mcp.json 의 읽기-쓰기가 겹쳐 한쪽 변경이 사라지던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const cfg = { command: "node", args: ["-e", "0"] };
    const added = ["a", "b", "c", "d", "e"].map((x) => `regr-conc-${x}`);
    await Promise.all(added.map((n) => upsertExternalMcpServer(n, cfg as never)));
    const afterAdd = names();
    // 지우기와 넣기가 겹쳐도 각자의 결과가 남는다
    const removed = await Promise.all([...added.map((n) => removeExternalMcpServer(n)), upsertExternalMcpServer("regr-conc-f", cfg as never)]);
    const afterMix = names();
    await removeExternalMcpServer("regr-conc-f");

    // ── 쓰기가 사용자의 파일을 망가뜨리지 않는다 (2026-10-08 적대 검토 P4 + 기존) ──
    const proj = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-mcpfile-"));
    const shared = path.join(proj, "shared.json");
    const file = path.join(proj, ".mcp.json");
    let broken: { threw: boolean; unchanged: boolean } = { threw: false, unchanged: false };
    let keep: { otherKey: boolean; symlink: boolean; mode: string; sharedGotIt: boolean } = { otherKey: false, symlink: false, mode: "", sharedGotIt: false };
    let linkRefused: string | undefined;
    let hard: { originalGotIt: boolean; otherKey: boolean; sameIno: boolean; sameDev: boolean } = { originalGotIt: false, otherKey: false, sameIno: false, sameDev: false };
    try {
      // ① 깨진 파일은 «빈 설정» 으로 읽어 덮지 않는다 — 다른 서버가 다 지워진다
      writeFileSync(file, "{ 깨진 json");
      try { await upsertExternalMcpServer("regr-x", cfg as never, proj); } catch { broken.threw = true; }
      broken.unchanged = readFileSync(file, "utf8") === "{ 깨진 json";
      rmSync(file);
      // ② 심링크·권한·다른 최상위 키를 그대로 둔다
      const links = await loadPluginModule<TestLinks>("./_test-links.mjs");
      writeFileSync(shared, JSON.stringify({ note: "keep me", mcpServers: { old: cfg } }));
      if (process.platform !== "win32") chmodSync(shared, 0o600);
      const linked = links.linkFile(shared, file);
      if (linked === true) {
        await upsertExternalMcpServer("regr-y", cfg as never, proj);
        const j = JSON.parse(readFileSync(shared, "utf8")) as { note?: string; mcpServers?: Record<string, unknown> };
        keep = {
          otherKey: j.note === "keep me" && "old" in (j.mcpServers ?? {}),
          symlink: lstatSync(file).isSymbolicLink(),
          mode: (statSync(shared).mode & 0o777).toString(8),
          sharedGotIt: "regr-y" in (j.mcpServers ?? {}),
        };
        rmSync(file);
      } else {
        linkRefused = `${links.FILE_LINK_NOT_RUN} · ${linked}`;
      }
      // ②' 하드링크 — 무권한 Windows 에서도 만들 수 있다. 제자리 쓰기면 같은 파일(ino/dev)이 그대로고 원본이 받는다.
      const original = path.join(proj, "hl-original.json");
      writeFileSync(original, JSON.stringify({ note: "keep me", mcpServers: { old: cfg } }));
      linkSync(original, file);
      await upsertExternalMcpServer("regr-h", cfg as never, proj);
      const h = JSON.parse(readFileSync(original, "utf8")) as { note?: string; mcpServers?: Record<string, unknown> };
      const so = statSync(original, { bigint: true });
      const sf = statSync(file, { bigint: true });
      hard = { originalGotIt: "regr-h" in (h.mcpServers ?? {}), otherKey: h.note === "keep me" && "old" in (h.mcpServers ?? {}), sameIno: so.ino === sf.ino, sameDev: so.dev === sf.dev };
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
    return [
      assert("★깨진 설정 파일은 덮어쓰지 않고 실패를 알린다(빈 설정으로 읽으면 다른 서버가 다 지워진다)", broken.threw && broken.unchanged, broken),
      linkRefused !== undefined
        ? skip(SYMLINK_IN_PLACE, linkRefused)
        : assert(SYMLINK_IN_PLACE, keep.symlink && keep.sharedGotIt && keep.otherKey && (process.platform === "win32" || keep.mode === "600"), keep),
      assert(HARDLINK_IN_PLACE, hard.originalGotIt && hard.otherKey && hard.sameIno && hard.sameDev, hard),
      assert("★동시에 다섯을 넣으면 다섯 다 남는다", afterAdd.join(",") === added.join(","), afterAdd),
      assert("동시에 지우고 넣으면 지운 것은 사라지고 넣은 것은 남는다 · 지우기는 각자 «있었다» 를 돌려준다",
        afterMix.join(",") === "regr-conc-f" && removed.slice(0, 5).every((r) => r === true), { afterMix, removed }),
    ];
  },
};
