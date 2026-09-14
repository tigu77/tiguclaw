/** 병렬 도구 응답에서 같은 파일의 성공한 Edit가 서로 덮이는 회귀. */
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, assertIsolated, within, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "file-edit-concurrency",
  guards: "같은 파일의 독립 Edit를 함께 실행하면 모두 성공 보고하지만 일부 수정이 소실되는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { createFileOpsMcpServer } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
    const { adaptClaudeMcpServer } = await import("../../core/llm-runtime/adapters/_mcp-bridge.js");
    const { withFileMutation } = await import("../../core/llm-runtime/capabilities/_file-mutation.js");
    const dir = await mkdtemp(path.join(tmpdir(), "tiguclaw-edits-"));
    const a = await adaptClaudeMcpServer(createFileOpsMcpServer(dir), "edit-a");
    const b = await adaptClaudeMcpServer(createFileOpsMcpServer(dir), "edit-b");
    const out: Assertion[] = [];
    try {
      const file = path.join(dir, "data.txt");
      const before = Array.from({ length: 12 }, (_, i) => `before-${i};`).join("\n");
      const expected = before.replaceAll("before-", "after-");
      await writeFile(file, before);
      const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).callTool("Edit", {
        path: i % 2 ? "data.txt" : file, old_string: `before-${i};`, new_string: `after-${i};`,
      })));
      out.push(assert("모두 성공한 같은 파일 독립 수정이 전부 남는다(서버 두 개·상대/절대 경로)", await readFile(file, "utf8") === expected, { content: await readFile(file, "utf8"), replies }));
      await writeFile(file, "alpha beta");
      const alias = path.join(dir, "alias.txt");
      await symlink(file, alias);
      await Promise.all([
        a.callTool("Edit", { path: file, old_string: "alpha", new_string: "ALPHA" }),
        b.callTool("Edit", { path: alias, old_string: "beta", new_string: "BETA" }),
      ]);
      out.push(assert("기존 파일 심링크도 같은 수정 대상으로 직렬화", await readFile(file, "utf8") === "ALPHA BETA", await readFile(file, "utf8")));
      await a.callTool("Edit", { path: file, old_string: "absent", new_string: "bad" });
      await b.callTool("Edit", { path: file, old_string: "ALPHA", new_string: "ok" });
      out.push(assert("매칭 실패 뒤 다음 수정 가능", await readFile(file, "utf8") === "ok BETA", await readFile(file, "utf8")));
      // Edit가 옛 내용을 읽은 직후 멈춰 Write와 경합시킨다.
      await writeFile(file, "edit-me");
      const originalRead = fs.readFile;
      let unblockRead!: () => void;
      let didRead!: () => void;
      const readStarted = new Promise<void>(resolve => { didRead = resolve; });
      const readGate = new Promise<void>(resolve => { unblockRead = resolve; });
      fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
        const value = await originalRead(...args);
        if (args[0] === file) { didRead(); await readGate; }
        return value;
      }) as typeof fs.readFile;
      let editPending: Promise<unknown> | undefined;
      let writePending: Promise<unknown> | undefined;
      try {
        editPending = a.callTool("Edit", { path: file, old_string: "edit-me", new_string: "stale-edit" });
        await readStarted;
        writePending = b.callTool("Write", { path: file, content: "write-wins" });
        const early = await within(100, "Edit 완료 전 Write", writePending);
        unblockRead();
        await Promise.all([editPending, writePending]);
        const content = await originalRead(file, "utf8");
        out.push(assert("Write가 진행 중 Edit를 기다려 오래된 내용이 되살아나지 않는다", "timedOut" in early && content === "write-wins", { early, content }));
      } finally {
        unblockRead();
        await Promise.allSettled([editPending, writePending]);
        fs.readFile = originalRead;
      }
      const created = path.join(dir, "nested", "new.txt");
      await a.callTool("Write", { path: created, content: "x x" });
      await b.callTool("Edit", { path: created, old_string: "x", new_string: "bad" });
      out.push(assert("새 부모/파일 생성과 중복 매칭 거부 유지", await readFile(created, "utf8") === "x x", await readFile(created, "utf8")));
      await a.callTool("Edit", { path: created, old_string: "x", new_string: "y", replace_all: true });
      out.push(assert("replace_all 계약 유지", await readFile(created, "utf8") === "y y", await readFile(created, "utf8")));
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const held = withFileMutation(file, async () => { entered(); await gate; });
      try {
        await started;
        const other = await within(1000, "다른 파일은 독립 실행", withFileMutation(created, async () => "ran"));
        out.push(assert("한 파일이 대기해도 다른 파일은 진행", "value" in other && other.value === "ran", other));
      } finally { release(); await held; }
      const failed = withFileMutation(file, async () => { throw new Error("synthetic failure"); }).catch(() => "failed");
      const recovered = withFileMutation(file, async () => "recovered");
      out.push(assert("예외가 나도 후속 수정 큐가 풀린다", (await failed) === "failed" && (await recovered) === "recovered", await recovered));

    } finally {
      await a.close?.(); await b.close?.();
      await rm(dir, { recursive: true, force: true });
    }
    return out;
  },
};
