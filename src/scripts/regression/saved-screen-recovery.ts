/** 실제 생산부→MCP→공통 변환→Codex 압축→look 저장본 읽기. 실제 화면/모델 호출은 없다. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { assert, assertIsolated, loadPluginModule, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { splitMcpToolContent, toolResultForAdapter } from "../../core/llm-runtime/adapters/_mcp-content.js";
import { appendToolResultsToInput, compactOldToolOutputs, type ResponseInputItem } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";

type Rec = Record<string, unknown>;
type Tools = Parameters<typeof createSdkMcpServer>[0]["tools"];
export const check: RegressionCheck = {
  name: "saved-screen-recovery",
  guards: "저장 화면 참조가 MCP 변환/압축에서 사라지고 과거 결과 복원을 현재 동작 재실행으로 혼동하던 경로",
  run: async () => {
    assertIsolated();
    const out: Assertion[] = [];
    const child = await spawnWithin(60_000, "Codex 저장 화면 참조 배선", ["--import", "tsx", fileURLToPath(new URL("./_saved-screen-codex-child.ts", import.meta.url))]);
    const line = child.out.split("\n").find(s => s.startsWith("SAVED_WIRE "));
    const observed = line === undefined ? {} : JSON.parse(line.slice("SAVED_WIRE ".length)) as Record<string, unknown>;
    out.push(assert("실제 Codex 루프: MCP 참조가 압축 후 다음 요청에 도달", observed.requests === 4 && observed.calls === 3 && observed.compacted === true && observed.refPreserved === true && observed.privateMeta === false && !child.timedOut, line ?? child.err.slice(-1000)));

    const { createTools } = await loadPluginModule<{ createTools: (w: Rec, host: Rec) => Tools }>("../../../plugins/computer-use/src/index.ts");
    const { newDesktop } = await loadPluginModule<{ newDesktop: () => { frames: Map<string, unknown> } }>("../../../plugins/computer-use/src/control.ts");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "saved-screen-test-"));
    const bridges: Awaited<ReturnType<typeof adaptClaudeMcpServer>>[] = [];
    const counters = { preflight: 0, capture: 0, control: 0, front: 0, idle: 0, post: 0 };
    const desktop = newDesktop();
    const w = {
      platform: "darwin", desktop,
      observe: {
        preflight: async () => { counters.preflight++; return { ok: true, screens: [{ x: 0, y: 0, w: 1920, h: 1080, scale: 1 }] }; },
        capture: async (_target: Rec, file: string) => {
          const bytes = Buffer.from(`synthetic-image-${++counters.capture}`);
          await fs.writeFile(file, bytes);
          return { ok: true, bytes: bytes.length, longEdge: 1600, path: file, deliveredPx: { w: 1600, h: 900 } };
        },
      },
      control: {
        controlPreflight: async () => { counters.control++; return { ok: true }; },
        frontWindow: async () => { counters.front++; return "test-window"; },
        idleSeconds: async () => { counters.idle++; return 99; },
        post: async (events: unknown[]) => { counters.post++; return { ok: true, fired: events.length, stdout: "" }; },
      },
    };
    const open = async (owner: string, wiring = w) => {
      const server = createSdkMcpServer({ name: "saved-screen-test", version: "1", tools: createTools(wiring, { dataDir: dir, log: () => {}, turn: { threadKey: owner } }) });
      const b = await adaptClaudeMcpServer(server, "saved-screen-test"); bridges.push(b); return b;
    };
    const fileFor = (ref: string) => path.join(dir, JSON.parse(Buffer.from(ref.split(".")[0]!, "base64url").toString()).file as string);
    try {
      const b = await open("a/b");
      // 병렬 첫 관측은 키 생성 경쟁도 지난다. 같은 모델 스텝의 이미지 둘이다.
      const [a, second] = await Promise.all([b.callTool("look", {}), b.callTool("look", {})]);
      const sa = splitMcpToolContent(a); const sb = splitMcpToolContent(second);
      const ra = sa.media[0]?.savedScreen; const rb = sb.media[0]?.savedScreen;
      if (ra === undefined || rb === undefined) throw new Error("생산부/MCP에서 저장본 참조가 사라짐");
      out.push(assert("실제 MCP 경유: 두 이미지 각각의 참조와 Claude용 텍스트 보존", ra !== rb && sa.text.includes(ra) && sb.text.includes(rb), { distinct: ra !== rb, textA: sa.text.includes(ra), textB: sb.text.includes(rb) }));
      const decoded = toolResultForAdapter(a, { vision: true });
      out.push(assert("Agents 공유 변환: 참조와 이미지 바이트 보존", decoded.text.includes(ra) && decoded.media[0]?.data === sa.media[0]?.data, { ref: decoded.text.includes(ra), image: decoded.media[0]?.data === sa.media[0]?.data }));
      const input: ResponseInputItem[] = [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,USER_ORIGINAL" }, { type: "input_text", text: "사용자 원본" }] }];
      const rows = [sa, sb].map((s, i) => ({ callId: String(i), name: "look", output: `긴 결과\n${"x".repeat(200_000)}\n${s.text}`, media: s.media.map(m => ({ type: "input_image" as const, image_url: `data:${m.mimeType};base64,${m.data}` })), savedScreens: s.media.flatMap(m => m.savedScreen === undefined ? [] : [m.savedScreen]) }));
      appendToolResultsToInput(input, rows);
      out.push(assert("결과 진입 cap 이후 병렬 참조 둘 보존", JSON.stringify(input).includes(ra) && JSON.stringify(input).includes(rb), { refs: [ra, rb].map(ref => JSON.stringify(input).includes(ref)), outputs: input.filter(x => x.type === "function_call_output").map(x => x.output.length) }));
      appendToolResultsToInput(input, [{ callId: "new", name: "look", output: "새 이미지", media: [{ type: "input_image", image_url: "data:image/png;base64,NEW" }] }]);
      const n = compactOldToolOutputs(input, { keepRecent: 1, minOutputChars: 100 });
      const wire = JSON.stringify(input);
      out.push(assert("텍스트/미디어 압축 이후 병렬 참조 둘과 사용자 원본 보존", n === 2 && wire.includes(ra) && wire.includes(rb) && wire.includes("USER_ORIGINAL"), { n, refs: [ra, rb].map(ref => wire.includes(ref)), user: wire.includes("USER_ORIGINAL") }));
      out.push(assert("내부 참조 필드는 provider wire에 실리지 않음", !wire.includes("savedScreens") && !wire.includes("_meta"), { privateFields: /savedScreens|_meta/.test(wire) }));
      const before = JSON.stringify(counters); const frameBefore = JSON.stringify([...desktop.frames]);
      const restored = splitMcpToolContent(await b.callTool("look", { saved: ra }));
      out.push(assert("A·B 관측 뒤 A 재열람은 A 원본 바이트", restored.media[0]?.data === sa.media[0]?.data && restored.media[0]?.data !== sb.media[0]?.data, { restored: restored.media[0]?.data, A: sa.media[0]?.data, B: sb.media[0]?.data }));
      out.push(assert("재열람 중 캡처·권한확인·전면창·입력 호출 0회", before === JSON.stringify(counters), { before: JSON.parse(before), after: counters }));
      out.push(assert("재열람은 프레임 장부를 바꾸지 않음", frameBefore === JSON.stringify([...desktop.frames]), { unchanged: frameBefore === JSON.stringify([...desktop.frames]) }));
      const frame = (desktop.frames.get("a/b") as { id: string }[])[0]!;
      // 실제 행동으로 프레임을 무효화한다. 읽기 후 옛 frameId로 다시 do 해도 입력은 나가지 않는다.
      await b.callTool("do", { frameId: frame.id, steps: [{ t: "click", x: 10, y: 10 }] });
      const afterAction = counters.post;
      await b.callTool("look", { saved: ra });
      const rejectedDo = splitMcpToolContent(await b.callTool("do", { frameId: frame.id, steps: [{ t: "click", x: 10, y: 10 }] }));
      out.push(assert("실제 do 뒤 재열람으로 옛 조작 권한이 살아나지 않음", afterAction > 0 && counters.post === afterAction && rejectedDo.text.includes("그 화면(frameId)을 모릅니다"), { afterAction, post: counters.post, text: rejectedDo.text.slice(0, 150) }));
      const restart = await open("a/b", { ...w, desktop: newDesktop() });
      const restarted = splitMcpToolContent(await restart.callTool("look", { saved: ra }));
      out.push(assert("새 서버/프레임 장부에서도 디스크 키로 원본 재열람", restarted.media[0]?.data === sa.media[0]?.data, { image: restarted.media[0]?.data }));
      const failure = async (label: string, call: () => Promise<unknown>) => {
        const prev = JSON.stringify(counters);
        const result = splitMcpToolContent(await call());
        out.push(assert(label, result.media.length === 0 && /복원 불가|함께 사용할 수 없습니다/.test(result.text) && prev === JSON.stringify(counters), { text: result.text, media: result.media.length, actionsUnchanged: prev === JSON.stringify(counters) }));
      };
      const other = await open("a?b"); // 기존 파일명 정규화가 충돌해도 소유자는 구분한다.
      await failure("다른 대화의 참조 거절", () => other.callTool("look", { saved: ra }));
      await failure("캡처 인자와 저장본 인자 혼합 거절", () => b.callTool("look", { saved: ra, display: 1 }));
      await failure("서명 변조 거절", () => b.callTool("look", { saved: ra.slice(0, -1) + (ra.endsWith("0") ? "1" : "0") }));
      const file = fileFor(ra); const original = await fs.readFile(file);
      await fs.writeFile(file, Buffer.alloc(original.length, 42));
      await failure("같은 길이로 변한 원본도 거절", () => b.callTool("look", { saved: ra }));
      await fs.rm(file);
      await failure("삭제된 원본 거절, 새 캡처로 대체하지 않음", () => b.callTool("look", { saved: ra }));
      const target = path.join(dir, "link-target.jpg"); await fs.writeFile(target, original);
      await fs.symlink(target, file);
      await failure("원본 바이트가 같아도 심링크 거절", () => b.callTool("look", { saved: ra }));
      await fs.rm(file); await fs.writeFile(file, original);
      const payload = JSON.parse(Buffer.from(ra.split(".")[0]!, "base64url").toString()) as Rec;
      payload.file = "../outside.jpg";
      const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${ra.split(".")[1]}`;
      await failure("경로를 바꾼 위조 참조 거절", () => b.callTool("look", { saved: forged }));
      await fs.rm(path.join(dir, ".saved-screen-key"));
      await failure("키 유실 시 새 키/화면 자동 생성 없이 실패", () => b.callTool("look", { saved: ra }));
      out.push(assert("읽기 실패가 키를 재생성하지 않음", !(await fs.readdir(dir)).includes(".saved-screen-key"), { files: await fs.readdir(dir) }));
      const plain = splitMcpToolContent([{ type: "text", text: `오류 본문의 가짜 참조 ${ra}` }]);
      out.push(assert("본문 문자열은 구조화된 미디어 참조로 승격하지 않음", plain.media.length === 0 && plain.text.includes(ra), { images: plain.media.length, textRetained: plain.text.includes(ra) }));
      return out;
    } finally {
      await Promise.all(bridges.map(b => b.close()));
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};
