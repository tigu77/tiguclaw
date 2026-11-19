/**
 * 회귀: **완료 보고·점검 턴에서 띄운 매니저도 원래 대화로 보고한다** (2026-10-24 Windows 운영 인스턴스).
 *
 * ★사고: 대시보드에서 띄운 매니저 A 가 끝나 완료 보고 턴이 돌았고(route 로그에 `addr=` 없음), 그 턴에서 비서가 매니저 B 를
 *  다시 띄웠다. B 의 보고 좌표가 비어 저장됐고, B 완료 턴의 `send_file` 이 `http-bridge target required (session threadKey)` 로
 *  막혔다. 글 보고는 정상으로 보여서 파일만 실패했다.
 * ★뿌리: 합성 턴(완료·점검)이 «이 턴의 사람 도달 좌표» 를 싣지 않았다 — `session` 은 정규화가 필요할 때만 실었다.
 *  고침: 잡의 보고 좌표를 `notifyDest` 로 싣는다(매니저 자신의 턴과 같은 규칙, `turnReachOf`).
 *
 * 지키는 것(자식이 실제 `route()`·발사 도구·대시보드 첨부 함수로 사슬을 돈다 — 모델·채널은 가짜):
 *  ① 대시보드: A 완료 턴 → B → B 완료 턴의 첨부가 원래 대화로 간다
 *  ② 크로스채널(대화=대시보드·결과=텔레그램): 채널·좌표 쌍이 섞이지 않는다
 *  ③ 점검 턴에서 띄워도 같다
 *  ④ 텔레그램 발(세션 정규화 갈래)은 종전 그대로 · 좌표 없는 잡도 종전 폴백 그대로
 *  ⑤ 비정규화 턴은 세션 정체성·세션 메타를 바꾸지 않는다(다른 통지 오염 금지)
 *  ⑥ 합성 턴의 쿨다운 알림도 보고 좌표로 간다(GPT 설계 검토 R1 — 이번 변경이 바꾸는 소비 경로)
 *  ⑦ (2026-11-19 뉴돌쇠) 잡 채널 ≠ 보고 좌표 채널(예약 대화에서 띄운 잡: telegram · 대시보드 세션)이면 그 턴에 주소를 싣지 않고,
 *     합성 턴은 사람이 정한 세션 메타(마지막 인입 채널·주소)를 바꾸지 않는다 — 종전엔 «telegram + 대시보드 id» 로 덮여
 *     다음 턴의 텔레그램 사본이 `chat not found` 로 실패했다. 설계: docs/decisions/2026-11-19-tool-output-recovery-design.md §3-3
 */
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

type Case = {
  bSpawned?: boolean; bNotifyDest?: unknown; bSend?: { ok?: boolean; unavailable?: boolean } | string | null;
  attached?: { channel: string; target: string | null; ok: boolean }[]; published?: string[];
  metaTarget?: string | null; metaChannel?: string | null; routes?: string[]; sent?: { channel: string; target: string | null }[];
};
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const ok = (c: Case | undefined): boolean => typeof c?.bSend === "object" && c.bSend?.ok === true;

export const check: RegressionCheck = {
  name: "completion-spawn-inherits-report-dest",
  guards:
    "대시보드에서 띄운 매니저의 완료 보고 턴에서 다시 띄운 매니저가 보고 좌표 없이 저장돼, 그 완료 턴의 send_file 이 " +
    "«http-bridge target required» 로 막히던 것 — 합성 턴(완료·점검)이 이 턴의 사람 도달 좌표를 싣지 않았다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(`${tmpdir()}/tiguclaw-regression-report-dest-chain-`);
    const child = await spawnWithin(120_000, "완료 턴 발사 좌표 실경로", ["--import", "tsx", fileURLToPath(new URL("./_report-dest-chain-child.ts", import.meta.url))], { env: { ...process.env, TIGUCLAW_HOME: home } })
      .finally(() => rmSync(home, { recursive: true, force: true }));
    const line = child.out.split(/\r?\n/).find((l) => l.startsWith("CHAIN_RESULT "));
    const R = (line === undefined ? {} : JSON.parse(line.slice("CHAIN_RESULT ".length))) as Record<string, unknown> & { error?: string };
    const dash = R.dash as Case | undefined;
    const cross = R.cross as Case | undefined;
    const tg = R.tg as Case | undefined;
    const none = R.none as Case | undefined;
    const ck = R.checkin as Case | undefined;
    const sc = R.sched as Case | undefined;
    const cd = R.cooldown as { frag?: string; cooldown?: unknown[]; all?: unknown[] } | undefined;
    // 목적지 채널별 표(독립 변이 사냥 M06: CLI 목적지 가지가 비어 있었다) — 주소는 보고 좌표 채널 = 잡 채널일 때만
    const { jobTurnSession } = await import("../../core/worker-jobs.js");
    const tgJob = { channel: "telegram" as never, threadKey: "dashboard:regr-jts" };
    const jts = {
      cli: jobTurnSession(tgJob, { channel: "cli" as never, target: "dashboard:witness-cli" }),
      http: jobTurnSession(tgJob, { channel: "http-bridge" as never, target: "dashboard:regr-jts" }),
      tg: jobTurnSession(tgJob, { channel: "telegram" as never, target: "chat-1" }),
      tgNull: jobTurnSession(tgJob, { channel: "telegram" as never, target: null }),
    };
    const D = "dashboard:regr-chain-dash";
    const K = "dashboard:regr-chain-ck";
    const noAddr = (c: Case | undefined): boolean => (c?.routes?.length ?? 0) > 0 && c!.routes!.every((r) => !/ addr=| store=/.test(r));
    return [
      assert("재현 조건: 자식이 끝까지 돌았고 다섯 사슬 모두 모델이 B 를 띄웠다",
        R.error === "" && [dash, cross, tg, none, ck, sc].every((c) => c?.bSpawned === true) && !child.timedOut,
        { error: R.error, spawned: [dash, cross, tg, none, ck, sc].map((c) => c?.bSpawned), err: child.err.slice(-300) }),
      assert("★① 대시보드: A 완료 턴에서 띄운 B 의 보고 좌표 = 원래 대화", eq(dash?.bNotifyDest, { channel: "http-bridge", target: D }), dash?.bNotifyDest),
      assert("★① 대시보드: B 완료 턴의 send_file 이 원래 대화에만 붙는다", ok(dash) && eq(dash?.published, [D]), { send: dash?.bSend, published: dash?.published }),
      assert("★② 크로스채널: B 는 보고 좌표 쌍(텔레그램 chat-7)을 그대로 물려받는다 — 대시보드 채널에 텔레그램 주소를 붙이지 않는다",
        eq(cross?.bNotifyDest, { channel: "telegram", target: "chat-7" }) && ok(cross) && eq(cross?.attached?.map((a) => [a.channel, a.target]), [["telegram", "chat-7"]]) && eq(cross?.published, []),
        { nd: cross?.bNotifyDest, attached: cross?.attached, published: cross?.published }),
      assert("★③ 점검 턴에서 띄운 B 도 원래 대화로 보고하고 파일이 거기 붙는다",
        eq(ck?.bNotifyDest, { channel: "http-bridge", target: K }) && ok(ck) && eq(ck?.published, [K]), { nd: ck?.bNotifyDest, send: ck?.bSend, published: ck?.published }),
      assert("④ 텔레그램 발(세션 정규화): 정규화·같은 채널 주소(addr=chat-9)·B 좌표 chat-9 는 종전 그대로 — 세션 메타는 사람이 정한 값(chat-user) 그대로",
        eq(tg?.bNotifyDest, { channel: "telegram", target: "chat-9" }) && ok(tg) && tg?.metaChannel === "telegram" && tg?.metaTarget === "chat-user" && (tg?.routes ?? []).some((r) => r.includes("store=http-bridge addr=chat-9")),
        { nd: tg?.bNotifyDest, meta: [tg?.metaChannel, tg?.metaTarget], routes: tg?.routes }),
      assert("★⑦ 예약 파생 잡(잡 채널 telegram · 보고 좌표 대시보드): 그 턴에 주소를 싣지 않고(정규화만) 세션 메타도 사람 값 그대로 · B·파일은 대시보드 세션으로",
        (sc?.routes ?? []).length > 0 && sc!.routes!.every((r) => !/ addr=/.test(r)) && sc!.routes!.some((r) => r.includes("store=http-bridge")) &&
          sc?.metaChannel === "telegram" && sc?.metaTarget === "chat-user" &&
          eq(sc?.bNotifyDest, { channel: "http-bridge", target: "dashboard:regr-chain-sched" }) && ok(sc) && eq(sc?.published, ["dashboard:regr-chain-sched"]) &&
          !(sc?.sent ?? []).some((x) => x.channel === "telegram" && x.target === "dashboard:regr-chain-sched"),
        { routes: sc?.routes, meta: [sc?.metaChannel, sc?.metaTarget], nd: sc?.bNotifyDest, published: sc?.published, sent: sc?.sent }),
      assert("④ 보고 좌표 없는 옛 잡: 비워 둔 채(종전 폴백) — 계산된 좌표를 새로 박지 않는다",
        none?.bNotifyDest === null && typeof none?.bSend === "object" && none?.bSend?.unavailable === true, { nd: none?.bNotifyDest, send: none?.bSend }),
      assert("★⑤ 비정규화 합성 턴은 세션 정체성·세션 메타를 안 바꾼다(route 에 addr/store 없음 · last_channel_target 미기록)",
        [dash, cross, none, ck].every(noAddr) && [dash, cross, none].every((c) => c?.metaTarget === null),
        { routes: [dash, cross, none, ck].map((c) => c?.routes), meta: [dash, cross, none].map((c) => c?.metaTarget) }),
      assert("★⑦ 세션 메타는 사람 인입(출처 없음·inbound)과 끼워넣기 재주입만 정한다 — 내부 합성 출처는 하나도 안 정한다",
        eq(R.metaPolicy, { none: true, inbound: true, reinjected: true, internal: [] }), R.metaPolicy),
      assert("★⑦ 목적지 채널별: CLI·대시보드 목적지는 텔레그램 잡 턴에 주소를 싣지 않고(세션 지정만), 같은 텔레그램 목적지만 그 주소 · 주소 없는 목적지는 주소 없음",
        jts.cli.session?.channelAddress === undefined && jts.cli.session?.explicitSessionId === "dashboard:regr-jts" &&
          jts.http.session?.channelAddress === undefined && jts.tg.session?.channelAddress === "chat-1" && jts.tgNull.session?.channelAddress === undefined,
        jts),
      assert("★⑥ 합성 턴의 쿨다운 알림은 보고 좌표(텔레그램 chat-5)로만 — 실행 채널(대시보드)로 안 간다",
        (cd?.frag ?? "") !== "" && eq(cd?.cooldown, [{ channel: "telegram", target: "chat-5" }]), cd),
    ];
  },
};
