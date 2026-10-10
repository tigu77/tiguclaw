/**
 * 회귀: **2026-10-09 전체 적대 검토가 찾은 코어 결함 묶음** — 하나하나는 작은데 셋 다 «조용히» 틀렸다.
 *
 *  ① Edit 한 번 바꾸기가 `$&`·`$'` 를 치환 패턴으로 해석해 **파일 뒷부분을 끼워 넣었다**(셸 `$$`·정규식·PHP 고칠 때).
 *  ② Edit 가 UTF-8 이 아닌 파일(CP949)을 «성공» 보고와 함께 **U+FFFD 로 영구 손상**시켰다(Read 는 정직하게 거절하던 파일).
 *  ③ 메모리 인덱스 캡 0(=끄기)이 «전부 잘렸다» 로 읽혀 매 턴 «정리를 제안하세요» 가 실렸다.
 *  ⑤ 포그라운드 Bash 가 새 세션 손자(setsid)에게 출력 파이프를 뺏기면 시한·/stop 에도 영영 안 끝났다.
 *  ⑥ Grep·Glob 출력이 10MB 를 넘으면 head_limit 와 무관하게 «maxBuffer 초과» 하나만 돌아왔다.
 *  ⑦ invoke_skill 이 기준 폴더를 안 줘서 번들 스킬의 references/·scripts/ 상대경로를 못 읽었다(Claude Code 는 준다).
 *  ⑧ 플러그인이 멈춰도(텔레그램 폴링 사망·대시보드 재기동 포기) 포트 표식이 아니면 자기 점검이 안 알렸다.
 *  ⑨ 채널 status 가 로드 시점 값으로 복사돼, 폴링이 죽어도 화면엔 계속 «up» 이었다.
 *  ④ 턴 실패 급증 감지가 실패마다 깨워 창을 당기는 바람에 «30초 안 3건» 일 때만 울렸다 — 2분 간격 10건은 0건.
 *
 * 등급: **동작** — 실제 도구 서버·실제 DB·실제 스윕.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, skip, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "review-1009-core-fixes",
  guards: "Edit 의 $ 치환·비 UTF-8 손상 · 메모리 캡 0 이 매 턴 정리 넛지 · 턴 실패 급증이 실패 간격에 묶여 안 울리던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "tiguclaw-regression-r1009-"));
    try {
      // ①② Edit
      const { createFileOpsMcpServer } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
      const { adaptClaudeMcpServer } = await import("../../core/llm-runtime/adapters/_mcp-bridge.js");
      const ops = await adaptClaudeMcpServer(createFileOpsMcpServer(dir), "r1009");
      const sh = path.join(dir, "run.sh");
      await writeFile(sh, "echo PID=OLD\nrest\n");
      await ops.callTool("Edit", { path: sh, old_string: "OLD", new_string: "$$ and $& and $' end" });
      const shOut = await readFile(sh, "utf8");
      out.push(assert("① 바꿀 글의 `$&`·`$'` 는 글자 그대로 들어간다(치환 패턴 아님)", shOut === "echo PID=$$ and $& and $' end\nrest\n", shOut));

      const cp = path.join(dir, "legacy.txt");
      const cp949 = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0x20, 0x68, 0x65, 0x6c, 0x6c, 0x6f]); // «안녕 hello» CP949
      await writeFile(cp, cp949);
      const r = JSON.stringify(await ops.callTool("Edit", { path: cp, old_string: "hello", new_string: "bye" }));
      const after = await readFile(cp);
      out.push(assert("② UTF-8 이 아닌 파일은 고치지 않는다 — 바이트가 그대로고, 왜 안 했는지 말한다", after.equals(cp949) && r.includes("UTF-8"), { same: after.equals(cp949), reply: r.slice(0, 160) }));

      // ⑤ 포그라운드 Bash — 새 세션으로 빠진 손자가 출력 파이프를 쥐어도 셸이 끝나면 끝난다
      if (process.platform !== "win32") {
        const grand = `"${process.execPath}" -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{detached:true,stdio:['ignore','inherit','inherit']}).unref()"; echo bash-done`;
        const t0 = Date.now();
        const reply = JSON.stringify(await ops.callTool("Bash", { command: grand, timeout: 30_000 }));
        const ms = Date.now() - t0;
        out.push(assert("⑤ 손자가 파이프를 쥐어도 셸이 끝나면 곧 돌아온다(출력도 온전)", ms < 5000 && reply.includes("bash-done"), { ms, reply: reply.slice(0, 120) }));
        // 대조 — 셸이 같은 그룹에 띄운 백그라운드(`cmd &`)의 늦은 출력은 기다려 받는다(끊으면 잃는다)
        const amp = JSON.stringify(await ops.callTool("Bash", { command: `echo now; (sleep 1; echo late-output) &`, timeout: 30_000 }));
        out.push(assert("⑤ `cmd &` 의 늦은 출력은 잃지 않는다(같은 그룹이 남아 있으면 기다린다)", amp.includes("late-output"), amp.slice(0, 160)));
        // 둘이 함께 — 같은 그룹에 남은 자식 + 새 세션 손자. 시한이 그룹을 죽이면 손자가 파이프를 쥐어도 끝나야 한다(2026-10-10 재검토: 영영 매달림)
        const both = `(sleep 20) & "${process.execPath}" -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:['ignore','inherit','inherit']}).unref()"; echo both-done`;
        const t1 = Date.now();
        const bothReply = JSON.stringify(await ops.callTool("Bash", { command: both, timeout: 2 }));
        const bothMs = Date.now() - t1;
        out.push(assert("⑤ 남은 자식과 새 세션 손자가 함께여도 시한(2초)에 끝난다", bothMs < 6000 && bothReply.includes("timeout"), { ms: bothMs, reply: bothReply.slice(0, 120) }));
      }

      // ⑥ Grep/Glob — 출력이 상한을 넘어도 받은 데까지 «잘렸다» 와 함께 준다(통째로 오류가 아니다)
      const big = path.join(dir, "big");
      await import("node:fs/promises").then((m) => m.mkdir(big));
      await writeFile(path.join(big, "huge.txt"), "needle-line-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(200_000)); // ≈13MB
      // ripgrep 이 없는 설치(깨끗한 설치·CI — `npm run doctor` 가 받는다)에선 Grep 자체가 «rg 없음» 이다 — 비대상으로 센다(조용한 통과 X).
      const { findRipgrep } = await import("../../core/ripgrep.js");
      const { getPaths } = await import("../../core/paths.js");
      if (findRipgrep(getPaths().home) === null) {
        out.push(skip("⑥ Grep 출력이 상한을 넘어도 앞부분을 «잘렸다» 와 함께 준다", "ripgrep 없음 — 이 설치에선 Grep 이 «rg 를 못 찾았습니다» 로 답한다(doctor 가 받는다)"));
      } else {
        const g = JSON.stringify(await ops.callTool("Grep", { pattern: "needle", path: big, output_mode: "content", head_limit: 5 }));
        out.push(assert("⑥ Grep 출력이 상한을 넘어도 앞부분을 «잘렸다» 와 함께 준다", g.includes("needle-line") && g.includes("truncated") && !/maxBuffer/i.test(g), g.slice(0, 160)));
      }

      // ⑦ invoke_skill 은 기준 폴더를 같이 준다 — 번들 스킬의 상대경로(references/·scripts/)가 풀리게
      const { createSkillInvokeMcpServer } = await import("../../core/llm-runtime/capabilities/skill-registry.js");
      const skills = await adaptClaudeMcpServer(createSkillInvokeMcpServer(dir), "r1009-skill");
      const sk = JSON.parse(JSON.stringify(await skills.callTool("invoke_skill", { name: "harness" }))) as { text?: string }[];
      const text = sk[0]?.text ?? "";
      const baseDir = /^Base directory for this skill: (.+)$/m.exec(text)?.[1] ?? "";
      const { existsSync } = await import("node:fs");
      out.push(assert("⑦ invoke_skill 이 기준 폴더를 준다 — 그 폴더에 본문이 가리키는 references/ 가 있다", baseDir !== "" && existsSync(path.join(baseDir, "references")), { baseDir, head: text.slice(0, 80) }));

      // ③ 메모리 캡 0
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      const { addMemory } = await import("../../store/memory.js");
      addMemory({ name: "r1009_probe", type: "reference", description: "캡 0 확인용", body: "x" } as never);
      const { formatMemoryIndex } = await import("../../core/prompt-assembly.js");
      const off = formatMemoryIndex(0);
      const on = formatMemoryIndex(100_000);
      out.push(assert("③ 캡 0 이면 인덱스를 싣지 않는다(정리 넛지도 없다) — 켜면 실린다", off === "" && on.includes("r1009_probe"), { off: off.slice(0, 80), on: on.includes("r1009_probe") }));

      // ④ 턴 실패 급증 — 2분 간격 실패 넷, 스윕은 매 실패 직후(실패가 깨우는 것처럼)
      const { insertEvent } = await import("../../store/events.js");
      const { runHealthSweep } = await import("../../core/health-sweep.js");
      const now = Date.now();
      let reports = 0;
      let lastSweep = now - 10 * 60_000;
      for (let i = 3; i >= 0; i -= 1) {
        const ts = now - i * 2 * 60_000;
        insertEvent(ts, "llm.turn_error", JSON.stringify({ threadKey: "dashboard:r1009", adapter: "codex", model: "m", errorKind: "error", message: `boom ${String(i)}` }));
        reports += runHealthSweep(lastSweep).filter((f) => f.kind === "turn_errors").length;
        lastSweep = ts;
      }
      // ⑧ 플러그인이 «사용자가 알아야 하는 멈춤» 이라고 표시한 오류는 알린다 — 표시 없는 건(답장 한 통 미배달 등)은 안 알린다
      insertEvent(now, "plugin.error", JSON.stringify({ pluginName: "telegram-channel", phase: "runtime", error: "telegram polling stopped — 409", userFacing: true }));
      insertEvent(now, "plugin.error", JSON.stringify({ pluginName: "noisy-plugin", phase: "runtime", error: "reply undelivered" }));
      const down = runHealthSweep(now - 1000).filter((f) => f.kind === "plugin_down");
      out.push(assert("⑧ 표시된 멈춤(폴링 사망)만 알린다 — 표시 없는 오류는 조용", down.length === 1 && down[0]!.summary.includes("telegram-channel"), down.map((f) => f.summary)));

      // ⑨ 채널 상태는 지금 값을 읽는다 — 플러그인 채널이 뒤에 status 를 내리면(폴링 사망) 배선된 채널도 따라 내려간다
      const { wirePlugin } = await import("../../core/plugins/wire.js");
      const { getEventBus } = await import("../../core/eventbus.js");
      const chInst = { name: "r1009-chan", status: "up" as string, startChannel: async (): Promise<void> => {}, stop: async (): Promise<void> => {} };
      const wiredChannels: Array<{ name: string; status?: string }> = [];
      await wirePlugin(
        { manifest: { schemaVersion: 1, kind: ["channel"], name: "r1009-chan", entry: "x" }, pluginDir: dir, capabilities: ["channel"], instance: chInst } as never,
        { bus: getEventBus(), channels: wiredChannels as never, serviceStops: [] },
      );
      const statusBefore = wiredChannels[0]?.status;
      chInst.status = "disabled";
      const statusAfter = wiredChannels[0]?.status;
      out.push(assert("⑨ 배선된 채널 status 가 인스턴스의 지금 값을 따른다(로드 시점 값으로 굳지 않는다)", statusBefore === "up" && statusAfter === "disabled", { statusBefore, statusAfter }));

      out.push(assert("④ 2분 간격 실패 넷은 한 번 알린다(실패 간격으로 창이 줄지 않는다 · 깨울 때마다 반복하지 않는다)", reports === 1, `보고 ${String(reports)}회`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
