/**
 * 회귀: **Windows 셸 출력의 OEM 코드 페이지를 줄마다 가려 읽는다** (2026-10-23, 설계 docs/decisions/2026-10-23-windows-shell-output-encoding.md).
 *
 * 사고(집 Windows 실측): 콘솔 프로그램·cmd 내장 명령은 파이프에 OEM 코드 페이지(949) 바이트를 쓰는데, 셸 출력을 읽는 세 자리(Bash 포그라운드·
 *  백그라운드·훅)가 조각마다 `toString("utf8")` 로 읽어 `ping`·`echo 한글`·`dir` 오류가 U+FFFD 로 깨졌다(«백그라운드만» 으로 보고됐지만 셋 다).
 *
 * 재는 것:
 *  ① 판정부(모든 OS · OEM 은 주입): 같은 바이트면 조각을 어디서 나눠도 같은 결과 — 섞인 출력 · R1 반례 `C2 A1 B0 A1 0A` · CP932 `1A 82 A0 0A` ·
 *     4KB 잠금 경계 · 긴 CP949 줄 · 안전 바이트만 미리 · 잠정 해석 · `end()` 멱등·뒤 `write` · OEM 없음 = 지금 동작 · 비 Windows UTF-8 조각 경계 · 이름표
 *  ② 진짜 셸 경로(Windows 판정을 주입해 맥에서도): Bash 포그라운드·백그라운드 · 보류 CP949 프롬프트로 `until` · 줄바꿈 없는 CP949 를 계속 내면 `idle` 로
 *     안 깬다 · kill 직후 꼬리 · kill 뒤 늦게 온 꼬리가 `close` 에서 확정(비 Windows — 새 세션 손자가 파이프를 쥔다) · 종료 이벤트 1번
 *  ③ 훅: CP949 차단 사유가 읽힌다(자식 — 격리 홈)
 *
 * 등급: **동작**. Windows 의 진짜 `cmd` 출력은 `windows-shell-output-real` 이 본다.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

type Tools = Record<string, { handler?: (a: Record<string, unknown>, e: unknown) => Promise<{ content?: { text?: string }[] }> }>;
const HOOK_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_shell-output-hook-child.ts");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** euc-kr(=CP949) 인코더 — 디코더의 역표(검사 전용). */
const cp949 = (() => {
  const d = new TextDecoder("euc-kr");
  const map = new Map<string, number[]>();
  for (let a = 0x81; a <= 0xfe; a += 1) for (let b = 0x41; b <= 0xfe; b += 1) {
    const ch = d.decode(Uint8Array.of(a, b));
    if (ch.length === 1 && ch !== "�" && !map.has(ch)) map.set(ch, [a, b]);
  }
  return (s: string): Buffer => {
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c < 0x80) out.push(c);
      else out.push(...(map.get(ch) ?? [0x3f]));
    }
    return Buffer.from(out);
  };
})();

export const check: RegressionCheck = {
  name: "shell-output-encoding",
  guards:
    "Windows 에서 셸 출력(ping·echo 한글·dir 오류)이 OEM 코드 페이지라 UTF-8 로 읽혀 깨지던 것 — Bash 포그라운드·백그라운드·훅 셋 다 — 과, 그걸 줄마다 가르며 생길 것(조각 경계 의존·until/idle·kill 뒤 꼬리)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const sod = await import("../../core/shell-output-decoder.js");
    const W = (label = "euc-kr") => sod.createShellOutputDecoder({ platform: "win32", oemLabel: label });
    const run = (bufs: Buffer[], label = "euc-kr"): string => { const d = W(label); return bufs.map((b) => d.write(b)).join("") + d.end(); };
    /** 둘로 나누는 모든 자리(긴 것은 표본) + 셋으로(짧은 것만) — 한 번에 넣은 것과 다르면 그 자리를 돌려준다. */
    const splitInvariant = (b: Buffer, label = "euc-kr", sample?: number[]): { ok: boolean; whole: string; at?: string } => {
      const whole = run([b], label);
      const cuts = sample ?? Array.from({ length: b.length + 1 }, (_, i) => i);
      for (const i of cuts) if (run([b.subarray(0, i), b.subarray(i)], label) !== whole) return { ok: false, whole, at: `${i}` };
      if (sample === undefined && b.length <= 80) {
        for (let i = 1; i < b.length; i += 1) for (let j = i + 1; j < b.length; j += 1) {
          if (run([b.subarray(0, i), b.subarray(i, j), b.subarray(j)], label) !== whole) return { ok: false, whole, at: `${i},${j}` };
        }
      }
      return { ok: true, whole };
    };

    // ── ① 판정부 ────────────────────────────────────────────────────────
    const mixed = Buffer.concat([cp949("한글테스트\r\n"), Buffer.from("노드한글\n", "utf8"), cp949("Ping 127.0.0.1 32바이트 데이터 사용:\r\n"), Buffer.from("progress 50%\r", "utf8"), cp949("진행 가\r"), Buffer.from("노드 완료\n", "utf8")]);
    const m = splitInvariant(mixed);
    out.push(assert("★★섞인 출력(CP949 줄 · UTF-8 줄 · \\r 진행 줄 · \\r 로만 갈린 CP949/UTF-8)이 줄마다 맞게 풀리고, 둘·셋으로 어디서 나눠 받아도 같다",
      m.ok && m.whole === "한글테스트\r\n노드한글\nPing 127.0.0.1 32바이트 데이터 사용:\r\nprogress 50%\r진행 가\r노드 완료\n", m));
    const r1 = splitInvariant(Buffer.from([0xc2, 0xa1, 0xb0, 0xa1, 0x0a]));
    out.push(assert("★R1 반례 `C2 A1 B0 A1 0A`(CP949 «징가») — 앞 두 바이트가 우연히 UTF-8 이어도 어떤 분할에서든 «징가\\n»", r1.ok && r1.whole === "징가\n", r1));
    const sj = splitInvariant(Buffer.from([0x1a, 0x82, 0xa0, 0x0a]), "shift_jis");
    const sjEarly = W("shift_jis").write(Buffer.from([0x41, 0x1a, 0x82, 0xa0]));
    out.push(assert("★CP932 `1A 82 A0 0A` — shift_jis 는 0x1A 를 UTF-8 과 다르게 푼다: 안전 바이트가 아니라 미리 안 내고, 어떤 분할에서든 «\\u001cあ\\n»",
      sj.ok && sj.whole === "\u001cあ\n" && sjEarly === "A", { ...sj, sjEarly }));
    const r4 = Buffer.concat([...Array.from({ length: 2048 }, () => Buffer.from([0xc2, 0xa1])), Buffer.from([0xb0, 0xa1, 0x0a])]);
    const r4s = splitInvariant(r4, "euc-kr", [0, 1, 2, 4095, 4096, 4097, 4098, 4099, 4100]);
    out.push(assert("4KB 잠금은 바이트 위치로 — `(C2 A1)×2048+B0 A1+0A` 는 첫 4096바이트(온전한 UTF-8)로 정해져 분할과 무관하게 같은 결과(알려진 한계 — 접두 오판정)",
      r4s.ok && r4s.whole.endsWith("¡��\n"), { ok: r4s.ok, tail: JSON.stringify(r4s.whole.slice(-4)), at: r4s.at }));
    const longKo = cp949(`${"가".repeat(3000)}\n`);
    const lk = splitInvariant(longKo, "euc-kr", [1, 4095, 4096, 4097, 4098, 5999]);
    out.push(assert("긴 CP949 줄(6000바이트) — 잠금 뒤 스트림 디코더라 4096 경계에 걸친 글자도 안 깨진다", lk.ok && lk.whole === `${"가".repeat(3000)}\n`, { ok: lk.ok, at: lk.at, len: lk.whole.length }));
    const ed = W();
    const early = ed.write(Buffer.concat([Buffer.from("abc "), cp949("계속하려면")]));
    const pend = ed.pending();
    const e1 = ed.end();
    const e2 = ed.end();
    const after = ed.write(Buffer.concat([cp949("다음"), Buffer.from("\n")]));
    out.push(assert("안전 바이트(ASCII 머리)는 바로 · 그 뒤 CP949 미완 줄은 잡아 두고 `pending()` 이 잠정 해석 · `end()` 가 확정·멱등 · 그 뒤 `write` 도 잃지 않는다",
      early === "abc " && pend === "계속하려면" && e1 === "계속하려면" && e2 === "" && after === "다음\n", { early, pend, e1, e2, after }));
    const noOem = sod.createShellOutputDecoder({ platform: "win32", oemLabel: null });
    const noOemText = noOem.write(Buffer.from("노드\n", "utf8")) + noOem.write(cp949("한글\n")) + noOem.end();
    out.push(assert("OEM 을 모르면(65001·미지원) 지금 동작 — UTF-8 그대로, OEM 바이트는 U+FFFD", noOemText.startsWith("노드\n") && noOemText.includes("�"), JSON.stringify(noOemText)));
    const u = Buffer.from("한글", "utf8");
    const mac = Array.from({ length: u.length + 1 }, (_, i) => { const d = sod.createShellOutputDecoder({ platform: "darwin" }); return d.write(u.subarray(0, i)) + d.write(u.subarray(i)) + d.end(); });
    out.push(assert("비 Windows — UTF-8 그대로, 조각 경계에서 잘린 멀티바이트만 다음 조각까지 잡는다(형제 결함)", mac.every((x) => x === "한글"), mac));
    // U+FEFF(BOM) 보존 — 종전 `toString("utf8")` 과 같게(GPT R1). 맥 스트림 · Windows 짧은 줄 · 잠금 줄(안전 바이트 뒤) · 분할 수신
    const bomMac = (() => { const d = sod.createShellOutputDecoder({ platform: "darwin" }); const b = Buffer.from("\uFEFFhello\n"); return d.write(b.subarray(0, 1)) + d.write(b.subarray(1)) + d.end(); })();
    const bomShort = run([Buffer.from("\uFEFF한글\n")]);
    const bomPend = (() => { const d = W(); d.write(Buffer.from("\uFEFFhello")); return d.pending(); })(); // 줄바꿈 없는 UTF-8 — 잠정 해석도(until 이 본다)
    const bomLong = Buffer.from(`prefix\uFEFF${"x".repeat(4097)}\n`);
    const bomLongS = splitInvariant(bomLong, "euc-kr", [3, 6, 7, 8, 9, 4100, 4103, 4104]);
    out.push(assert("U+FEFF 보존 — 맥 스트림(분할) · Windows 짧은 줄 · 잠정 해석(`pending()`) · 4KB 잠금 줄(안전 바이트 뒤) 모두 종전 `toString(\"utf8\")` 과 같다",
      bomMac === "\uFEFFhello\n" && bomShort === "\uFEFF한글\n" && bomPend === "\uFEFFhello" && bomLongS.ok && bomLongS.whole === `prefix\uFEFF${"x".repeat(4097)}\n`,
      { bomMac: JSON.stringify(bomMac.slice(0, 3)), bomShort: JSON.stringify(bomShort.slice(0, 3)), long: bomLongS.ok && bomLongS.whole.slice(0, 8) }));
    const labels = Object.fromEntries([932, 936, 949, 950, 866, 874, 1252, 437, 850, 65001].map((c) => [c, sod.oemDecoderLabel(c)]));
    out.push(assert("코드 페이지 → 이 기계의 `TextDecoder` 가 받는 이름 — 932·936(gbk)·949·950·866·874·1252 있음 · 437·850·65001 없음",
      labels[932] === "shift_jis" && labels[936] === "gbk" && labels[949] === "euc-kr" && labels[950] === "big5" && labels[866] === "ibm866" &&
        labels[874] === "windows-874" && labels[1252] === "windows-1252" && labels[437] === null && labels[850] === null && labels[65001] === null,
      labels));

    // ── ② 진짜 셸 경로 — Windows 판정 주입 ───────────────────────────────────
    sod.__forceShellDecoderForTest({ platform: "win32", oemLabel: "euc-kr" });
    const fx = mkdtempSync(path.join(tmpdir(), "shell-enc-"));
    const { createFileOpsMcpServer } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    const exited: string[] = [];
    const unsub = getEventBus().subscribe((e) => {
      if (e.type === "shell.exited") exited.push(String((e.payload as { shellId?: unknown }).shellId));
    });
    try {
      const tools = (createFileOpsMcpServer(fx, "regr:shell-enc", {}) as unknown as { instance?: { _registeredTools?: Tools } }).instance?._registeredTools ?? {};
      const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
        ((await tools[name]!.handler!(args, {})).content ?? []).map((c) => c.text ?? "").join("\n");
      /** 스크립트 파일로 띄운다(따옴표 규칙을 안 지난다). */
      const nodeCmd = (name: string, js: string): string => {
        const f = path.join(fx, `${name}.cjs`);
        writeFileSync(f, js);
        return `"${process.execPath}" "${f}"`;
      };
      const hx = (s: string): string => cp949(s).toString("hex");
      const mixedJs = `process.stdout.write(Buffer.from("${hx("한글테스트\r\n")}","hex"));process.stdout.write("노드한글\\n");process.stderr.write(Buffer.from("${hx("파일을 찾을 수 없습니다.\r\n")}","hex"));process.stdout.write(Buffer.from("${hx("끝 꼬리")}","hex"));`;
      const fg = await call("Bash", { command: nodeCmd("fg", mixedJs) });
      out.push(assert("★★Bash 포그라운드 — CP949 stdout·stderr 와 UTF-8 이 섞여도, 줄바꿈 없이 끝나는 꼬리까지 한글로(U+FFFD 0)",
        fg.includes("한글테스트") && fg.includes("노드한글") && fg.includes("파일을 찾을 수 없습니다.") && fg.includes("끝 꼬리") && !fg.includes("�"), fg.slice(0, 300)));
      const idOf = (r: string): string => /bash_[0-9a-f]{8}/.exec(r)?.[0] ?? "";
      const bgId = idOf(await call("Bash", { command: nodeCmd("bg", mixedJs), run_in_background: true }));
      const bg = await call("BashOutput", { bash_id: bgId, wait_seconds: 15 });
      out.push(assert("★★Bash 백그라운드 → BashOutput — 같은 출력이 꼬리까지 한글로(U+FFFD 0)",
        bg.includes("한글테스트") && bg.includes("노드한글") && bg.includes("파일을 찾을 수 없습니다.") && bg.includes("끝 꼬리") && !bg.includes("�"), bg.slice(0, 300)));
      // until — 줄바꿈 없는 CP949 프롬프트(디코더가 잡아 둔다)로도 바로 깬다(잠정 해석 · 약한 계약)
      const prId = idOf(await call("Bash", { command: nodeCmd("prompt", `process.stdout.write(Buffer.from("${hx("계속하려면 아무 키나")}","hex"));setTimeout(()=>{},8000);`), run_in_background: true }));
      const t0 = Date.now();
      const pr = await call("BashOutput", { bash_id: prId, wait_seconds: 10, until: "계속하려면" });
      const prMs = Date.now() - t0;
      // 이미 와 있던 보류분 — 대기 등록 때 훑는 자리도 잠정 해석을 본다
      await sleep(300);
      const t1 = Date.now();
      const pr2 = await call("BashOutput", { bash_id: prId, wait_seconds: 10, until: "아무 키나" });
      const pr2Ms = Date.now() - t1;
      out.push(assert("★보류 중인 CP949 프롬프트(줄바꿈 없음)로 `until` 이 바로 깬다 — 조각이 들어올 때도 · 이미 와 있던 것을 대기 등록 때 훑을 때도",
        /찾던|가 나옴/.test(pr) && prMs < 5000 && /가 나옴/.test(pr2) && pr2Ms < 3000, { pr: pr.split("\n")[0], prMs, pr2: pr2.split("\n")[0], pr2Ms }));
      // stderr 로 **기다리는 도중에** 도착한 보류 프롬프트(2026-10-23 변이 사냥 H: 도착 때 stderr 잠정 해석을 빼도 초록이었다 — 위 두 경우는 stdout 뿐)
      const erId = idOf(await call("Bash", { command: nodeCmd("errprompt", `setTimeout(()=>process.stderr.write(Buffer.from("${hx("계속하려면 엔터")}","hex")),600);setTimeout(()=>{},8000);`), run_in_background: true }));
      const te = Date.now();
      const er = await call("BashOutput", { bash_id: erId, wait_seconds: 6, until: "계속하려면" });
      const erMs = Date.now() - te;
      await call("KillShell", { shell_id: erId, bash_id: erId });
      out.push(assert("★stderr 로 기다리는 도중에 온 보류 CP949 프롬프트(줄바꿈 없음)로도 `until` 이 바로 깬다",
        /찾던|가 나옴/.test(er) && erMs < 4000, { er: er.split("\n")[0], erMs }));
      // kill — 그 직후 «끝남» 과 함께 잡아 둔 꼬리
      await call("KillShell", { shell_id: prId, bash_id: prId });
      const afterKill = await call("BashOutput", { bash_id: prId });
      out.push(assert("★보류분이 있는 셸을 kill → 그 직후 BashOutput 이 끝난 상태와 함께 그 꼬리를 돌려준다(끝을 보이기 전에 확정)",
        /status: killed/.test(afterKill) && afterKill.includes("계속하려면 아무 키나"), afterKill.slice(0, 300)));
      // idle — 줄바꿈 없는 CP949 를 계속 내면 바이트가 오는 동안은 «새 출력 없음» 으로 안 깬다
      const drip = idOf(await call("Bash", { command: nodeCmd("drip", `let n=0;const t=setInterval(()=>{process.stdout.write(Buffer.from("${hx("가")}","hex"));if(++n>=12){clearInterval(t);}},200);`), run_in_background: true }));
      const dr = await call("BashOutput", { bash_id: drip, wait_seconds: 10, idle_seconds: 1 });
      out.push(assert("★줄바꿈 없이 CP949 를 200ms 마다 내는 셸 — `idle_seconds:1` 로 안 깨고(진전 = 원바이트) 끝까지 기다려 한글로",
        /깨운 이유: 끝남/.test(dr) && dr.includes("가".repeat(12)) && !/새 출력 없음 — 멈췄을/.test(dr), dr.split("\n").slice(0, 4)));
      if (process.platform !== "win32") {
        // `run:` 결과 — 셸은 끝났는데 손자가 파이프를 쥐면 `close` 대신 «exit + 200ms» 로 결과를 낸다: 그 순간 잡아 둔 꼬리까지 `recent` 에(GPT R1)
        const { startBackgroundShell } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
        const runCmd = nodeCmd("runexit", `const {spawn}=require("child_process");spawn(process.execPath,["-e","setTimeout(()=>{},4000)"],{detached:true,stdio:["ignore","inherit","inherit"]}).unref();process.stdout.write(Buffer.from("${hx("한글 결과")}","hex"));`);
        const st = await startBackgroundShell(runCmd, fx, "regr:shell-enc");
        const res = await Promise.race([st.done, sleep(3000).then(() => ({ status: "timeout", exitCode: null, recent: "" }))]);
        out.push(assert("★`run:` 결과(«exit + 200ms» 로 먼저 낼 때) — 줄바꿈 없는 CP949 꼬리까지 `recent` 에 한글로",
          res.status === "completed" && res.recent.includes("한글 결과") && !res.recent.includes("\uFFFD"), res));
        await call("KillShell", { shell_id: st.shellId, bash_id: st.shellId });
        // kill 뒤 늦게 온 꼬리 — 새 세션 손자가 파이프를 쥐고 kill 뒤에 «나» 를 쓰고 끝난다 → close 에서 확정(상태 가드 밖)
        const lateId = idOf(await call("Bash", {
          command: nodeCmd("late", `const {spawn}=require("child_process");spawn(process.execPath,["-e",'setTimeout(()=>process.stdout.write(Buffer.from("${hx("나")}","hex")),900)'],{detached:true,stdio:["ignore","inherit","inherit"]});process.stdout.write(Buffer.from("${hx("가")}","hex"));setInterval(()=>{},1000);`),
          run_in_background: true,
        }));
        await call("BashOutput", { bash_id: lateId, wait_seconds: 5, until: "가" });
        await call("KillShell", { shell_id: lateId, bash_id: lateId });
        const lk1 = await call("BashOutput", { bash_id: lateId });
        await sleep(1800);
        const lk2 = await call("BashOutput", { bash_id: lateId });
        out.push(assert("★kill 뒤 늦게 와 다시 잡힌 CP949 꼬리도 `close` 에서 확정된다 — 다시 물으면 나온다 · 종료 이벤트는 한 번",
          lk1.includes("가") && lk2.includes("나") && exited.filter((x) => x === lateId).length === 1, { lk1: lk1.split("\n").slice(0, 4), lk2: lk2.split("\n").slice(0, 4), exited: exited.filter((x) => x === lateId).length }));
      }
    } finally {
      unsub();
      sod.__forceShellDecoderForTest(undefined);
      const { killAllBgShells } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
      await killAllBgShells();
      rmSync(fx, { recursive: true, force: true });
    }

    // ── ③ 훅 ──────────────────────────────────────────────────────────────
    const home = mkdtempSync(path.join(tmpdir(), "shell-enc-hook-"));
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", HOOK_CHILD], {
        encoding: "utf8", timeout: 60_000,
        env: { ...process.env, TIGUCLAW_HOME: home, REASON_HEX: cp949("정책상 금지된 도구입니다").toString("hex"), CTX_HEX: cp949("맥락 한글").toString("hex") },
      });
      let got: { block?: boolean; reason?: string; context?: string } = {};
      try { got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as typeof got; } catch { got = {}; }
      out.push(assert("★훅(`cmd /c` 자리) — CP949 로 쓴 차단 사유(stderr·exit 2)와 줄바꿈 없는 맥락(stdout → additionalContext)이 한글로 읽힌다",
        got.block === true && (got.reason ?? "").includes("정책상 금지된 도구입니다") && (got.context ?? "").includes("맥락 한글") && !(got.reason ?? "").includes("�"), { got, err: (r.stderr ?? "").slice(-300) }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    return out;
  },
};

export default check;
