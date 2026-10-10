/**
 * 회귀: **비서의 셸은 데몬 시크릿을 못 보고, 중립 턴의 Read 는 첨부만 연다** (2026-10-09 전체 적대 검토).
 *
 * 사고 ①: 비서 Bash 도구(포그라운드·백그라운드)가 데몬 env 를 그대로 물려받았다 — `.env` 로 올린 봇 토큰·API 키·OAuth
 *  가 `env` 한 줄로 대화·로그에 샌다. `run:` 커맨드만 `buildChildEnv()` 로 지우고 있었다(정태님 결정: 지워서 넘긴다).
 * 사고 ②: 게이트웨이 중립 턴에 첨부를 보이려고 되돌려준 `Read` 에 경로 제한이 없었다 — 외부 앱이 시킨 턴이
 *  `/etc/hosts`·홈 `.env` 까지 읽을 수 있었다.
 *
 * ★등급: 동작 — 진짜 도구 서버를 띄워 셸 출력과 Read 결과를 본다(세 어댑터가 같은 서버를 쓴다).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileOpsMcpServer } from "../../core/llm-runtime/capabilities/file-ops-mcp.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { nodeCommand } from "./_shell-fixture.js";

const textOf = (content: unknown): string => {
  const arr = Array.isArray(content) ? content : [content];
  return (arr[0] as { text?: string } | undefined)?.text ?? JSON.stringify(content);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const check: RegressionCheck = {
  name: "file-ops-secrets-and-reads",
  guards: "비서 Bash 가 데몬 시크릿(.env)을 그대로 물려받던 것 + 중립 턴 Read 가 첨부 밖(/etc/hosts·홈 .env)까지 열던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "fileops-sec-"));
    const SECRET = "REGRESSION_PROBE_API_TOKEN";
    const PLAIN = "REGRESSION_PROBE_PLAIN";
    process.env[SECRET] = "s3cr3t-value-should-not-leak";
    process.env[PLAIN] = "plain-value-ok";
    const show = nodeCommand(`console.log("S=" + (process.env.${SECRET} ?? "<none>") + " P=" + (process.env.${PLAIN} ?? "<none>"))`);
    try {
      const srv = await adaptClaudeMcpServer(createFileOpsMcpServer(dir, "regression:sec"), "file-ops");
      const fg = textOf(await srv.callTool("Bash", { command: show }));
      out.push(
        assert(
          "★포그라운드 Bash 에 시크릿 env 가 안 넘어간다(일반 env 는 그대로)",
          fg.includes("S=<none>") && fg.includes("P=plain-value-ok"),
          fg.replace(/\s+/g, " ").slice(0, 120),
        ),
      );
      const started = textOf(await srv.callTool("Bash", { command: show, run_in_background: true }));
      const id = /bash_id: (bash_[0-9a-f]+)/.exec(started)?.[1] ?? "";
      let bg = "";
      for (let i = 0; i < 30 && !bg.includes("S="); i++) {
        await sleep(100);
        bg = textOf(await srv.callTool("BashOutput", { bash_id: id }));
      }
      out.push(
        assert(
          "★백그라운드 Bash 도 같은 판정이다(시크릿 없음 · 일반 env 있음)",
          bg.includes("S=<none>") && bg.includes("P=plain-value-ok"),
          `${id} → ${bg.replace(/\s+/g, " ").slice(0, 120)}`,
        ),
      );
      await srv.close();

      // ── 중립 턴 Read — 첨부만 ────────────────────────────────────────────────
      const att = path.join(dir, "attached.txt");
      const other = path.join(dir, "secret.env");
      writeFileSync(att, "ATTACHED-BODY");
      writeFileSync(other, "TOKEN=nope");
      const ro = await adaptClaudeMcpServer(createFileOpsMcpServer(dir, "regression:ro", { readsOnly: [att] }), "file-read");
      const tools = (await ro.listTools()).map((t) => (t as { name: string }).name);
      const okRead = textOf(await ro.callTool("Read", { path: att }));
      const relRead = textOf(await ro.callTool("Read", { path: "attached.txt" }));
      const denied = textOf(await ro.callTool("Read", { path: other }));
      const etc = textOf(await ro.callTool("Read", { path: "/etc/hosts" }));
      out.push(assert("중립 턴엔 Read 하나뿐이다", tools.length === 1 && tools[0] === "Read", tools.join(",")));
      out.push(assert("첨부는 열린다(비전이 산다 — 절대·상대 모두)", okRead.includes("ATTACHED-BODY") && relRead.includes("ATTACHED-BODY"), `${okRead.slice(0, 40)} / ${relRead.slice(0, 40)}`));
      out.push(
        assert(
          "★첨부 밖(같은 폴더의 다른 파일·/etc/hosts)은 못 연다",
          !denied.includes("TOKEN=nope") && /첨부된 파일만/.test(denied) && /첨부된 파일만/.test(etc),
          `${denied.slice(0, 60)} | ${etc.slice(0, 60)}`,
        ),
      );
      await ro.close();
    } finally {
      delete process.env[SECRET];
      delete process.env[PLAIN];
      rmSync(dir, { recursive: true, force: true });
    }
    return out;
  },
};
