/**
 * `schedule-list-pages` 의 자식 — **새 설치(빈 DB)의 첫 예약**(id 1)이 인자 없는 목록 첫 페이지에 나오는가(독립 변이 사냥 M04: 첫 페이지 시작점을
 *  1 로 밀어도 초록이었다 — 공유 DB 에선 id 가 1 이 아니라 안 보였다). 격리 홈 · 네트워크 0. 출력: `FIRST_ID_RESULT <json>`.
 */
import { assertIsolated, loadPluginModule } from "./_framework.js";
assertIsolated();
const { initStore } = await import("../../store/sessions.js");
const { addSchedule } = await import("../../store/schedules.js");
initStore();
const row = addSchedule({ label: "첫 예약", cronExpr: "0 8 * * *", timezone: "Asia/Seoul", prompt: "첫 지시문", destChannel: "http-bridge", destTarget: null });
const mcp = await loadPluginModule<{ createSchedulerMcpServer: (h?: unknown) => { instance: unknown } }>("../../../plugins/scheduler/src/mcp.js");
type Tool = { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> };
const tools = (mcp.createSchedulerMcpServer({ turnSession: () => null }).instance as { _registeredTools: Record<string, Tool> })._registeredTools;
const page = JSON.parse((await tools.list_schedules!.handler({}, {})).content[0]!.text) as { items?: { id: number }[]; complete?: boolean; total?: number };
process.stdout.write("FIRST_ID_RESULT " + JSON.stringify({ id: row.id, ids: (page.items ?? []).map((r) => r.id), complete: page.complete, total: page.total }) + "\n", () => process.exit(0));
