/**
 * 회귀: **점검은 판정하지 않는다 — 증거를 모아 소환자에게 넘긴다** (2026-08-22 사용자 결정).
 *
 * 이 자리는 하루에 세 번 뒤집혔고, 마지막 형태만 남긴다.
 *  ① 원래: wall-clock **kill**(2시간이면 죽인다).
 *  ② 사용자: *"시간제한을 걸으라는 건 소환자가 소환 대상이 별문제가 없는지 확인해보는
 *     시간이면 어떨까. 이걸 그냥 냅다 끊는 건 좀 아닌 것 같아서"* → 죽이지 말고 보고.
 *  ③ 그런데 그것도 **코어가 판정**하고 있었다(`침묵 2회 = 죽인다`). 사용자가 소환자에게
 *     맡기라고 한 판단을 정적 규칙이 가로챈 것이다([[feedback_capability_not_routing]]).
 *     *"재개는 소환자가 선택"* · *"감사 주체는 언제나 소환자"*.
 *
 * ★그리고 **침묵은 '잘 돌고 있는지' 의 답이 아니다.** 양방향으로 틀린다:
 *   · 3시간짜리 정상 도구 → 조용하다 → 정체로 오판 (여기 ③ 케이스)
 *   · 같은 일을 반복하는 런어웨이 → 시끄럽다 → 건강하다고 오판
 *  그래서 판정을 빼고 **증거**를 넘긴다: 도구/텍스트 건수, 진행 중인 도구와 그 경과,
 *  마지막 활동. 긴 도구 오판이 휴리스틱 면제 없이 사라진다 — 증거에 "진행 중" 이 실린다.
 *
 * 앞선 사고 (같은 날 실측): 백그라운드 서브에이전트는 상한에 걸려도 통지가 **0건**이고
 * 잡이 영원히 `running` 으로 굳었다(매니저 레인엔 하드 백스톱이 있는데 이쪽만 없었다).
 * 즉 종전 시스템은 *죽이기는 하는데 알려주지는 않았다* — 정확히 반대였다.
 *
 * 여기서 지키는 것:
 *  ① 주기가 되면 **점검이 나간다** — 모르는 채로 방치되지 않는다
 *  ② 점검엔 **증거**가 실린다(판정 문장이 아니라 사실)
 *  ③ 소환자가 도는 매니저면 **그쪽으로** 간다 — 사용자에게 남의 집 사정이 안 간다
 *  ④ 긴 도구 하나로 조용한 잡을 **안 죽인다**(진행 중 도구가 증거에 있다)
 *  ⑤ 자동 종료는 **아무도 판단할 수 없을 때만**(완전 침묵 + 소환자 없음 + 2주기)
 *  ⑥ 기본 설정에서 시계가 정상 작업을 죽이지 않는다
 *
 * 등급: **동작 검사**(자식 프로세스 5회). 모델 호출 0, 네트워크 0, 라이브 데몬 0.
 * 주기는 모듈 상수라 env 로만 바뀌므로 자식이 필요하다(`_data-safety-child` 동형).
 */
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "_job-checkin-child.ts",
);

type Probe = Record<string, unknown>;

const runChild = (mode: string, env: Record<string, string>): { got: Probe; tail: string } => {
  const home = mkdtempSync(path.join(tmpdir(), `job-checkin-${mode}-`));
  const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, TIGUCLAW_HOME: home, PROBE_MODE: mode, ...env },
  });
  let got: Probe = {};
  try {
    got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Probe;
  } catch {
    got = {};
  }
  return { got, tail: (r.stderr ?? "").trim().slice(-200) };
};

/** 짧은 주기로 돌려 실제 시간을 안 기다린다(판정 로직은 동일 — 값만 작다). */
const FAST = { JOB_CHECKIN_INTERVAL_MS: "400" };

export const check: RegressionCheck = {
  name: "job-checkin-reports",
  guards:
    "잡이 상한에 걸리면 조용히 죽던 것(서브에이전트는 죽지도 알리지도 않고 영원히 running) + 그걸 고치며 코어가 '침묵=정체' 로 판정해 긴 도구 하나짜리 정상 작업을 죽이려던 것 — 이제 점검은 증거만 모아 소환자에게 넘기고, 자동 종료는 판단할 소환자가 없을 때만",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 점검이 나가고 **증거**가 실린다 ───────────────────────────────────────
    {
      const { got, tail } = runChild("stall", FAST);
      const ran = typeof got.firstReports === "number";
      const sample = String(got.sample);
      out.push(
        assert(
          "점검 프로브가 실제로 돌았다(빈손 통과 금지)",
          ran,
          ran ? `주기=${String(got.checkinInterval)}ms` : `★프로브 실패: ${tail}`,
        ),
        assert(
          "★주기가 되면 점검이 나간다(모르는 채로 방치 0)",
          typeof got.firstReports === "number" && got.firstReports > 0,
          `1회차 ${String(got.firstReports)}건`,
        ),
        assert(
          "★점검에 **증거**가 실린다(판정 문장이 아니라 사실)",
          sample.includes("도구 이벤트") &&
            sample.includes("마지막 활동") &&
            sample.includes("시작 이후"),
          sample.slice(0, 160),
        ),
        assert(
          "판단 선택지를 소환자에게 준다(계속·지시·중지)",
          sample.includes("cancel_worker") && sample.includes("판단"),
          sample.slice(0, 120),
        ),
        // ── ⑤ 완전 침묵 + 판단할 소환자 없음 + 2주기 → 그때만 자동 종료 ──────────
        assert(
          "★1회차엔 안 죽인다(소환자에게 넘긴 뒤 기다린다)",
          got.afterFirst === "running",
          `1회차 후=${String(got.afterFirst)}`,
        ),
        assert(
          // ★"아무도 판단할 수 없다" = 메인 핸들러조차 없어 raw 로 직행한 경우다.
          //  소환자가 메인 비서면(=거의 항상) 이 분기로 안 온다 — 아래 `judged` 참조.
          "★정말 아무도 못 받는 잡만 2주기 뒤 종료하고 **종료했다고 알린다**",
          got.afterSecond === "cancelled" && got.killNotice === true,
          `2회차 후=${String(got.afterSecond)} 통지=${String(got.killNotice)}`,
        ),
      );
    }

    // ── ④ ★긴 도구 하나로 조용한 잡을 죽이지 않는다 ─────────────────────────────
    //  이게 '침묵=정체' 판정을 버린 이유다. 도구는 start/end 만 내고 그 사이엔 조용하다.
    {
      const { got, tail } = runChild("longtool", FAST);
      const sample = String(got.sample);
      out.push(
        assert(
          "긴 도구 프로브가 실제로 돌았다(빈손 통과 금지)",
          typeof got.firstReports === "number",
          typeof got.firstReports === "number" ? "돌았다" : `★프로브 실패: ${tail}`,
        ),
        assert(
          "★진행 중인 도구가 증거에 실린다('멈춤' 과 '하는 중' 을 구별)",
          sample.includes("진행 중인 도구"),
          sample.slice(0, 200),
        ),
        assert(
          "★도구 하나가 주기를 넘겨도 **안 죽인다**(2주기 지나도 살아 있다)",
          got.afterSecond === "running",
          `2주기 후=${String(got.afterSecond)}`,
        ),
      );
    }

    // ── ③ 소환자가 도는 매니저면 **그쪽으로** 간다 ──────────────────────────────
    {
      const { got, tail } = runChild("managed", FAST);
      out.push(
        assert(
          "매니저 소환 프로브가 실제로 돌았다(빈손 통과 금지)",
          typeof got.parentGot === "number",
          typeof got.parentGot === "number" ? "돌았다" : `★프로브 실패: ${tail}`,
        ),
        assert(
          "★점검이 소환자 매니저의 steering 큐로 간다(감사 주체 = 소환자)",
          typeof got.parentGot === "number" && got.parentGot > 0,
          `매니저 수신 ${String(got.parentGot)}건 · ${String(got.parentSample).slice(0, 100)}`,
        ),
        assert(
          // 부모 매니저 **자신의** 점검은 소환자가 세션이라 사용자에게 가는 게 맞다.
          // 여기서 0이어야 하는 것은 **자식의** 점검이다(그건 매니저가 판단한다).
          "★자식 점검이 사용자에게 새지 않는다(남의 집 사정 0)",
          got.userGotChild === 0,
          `자식 건 사용자 수신 ${String(got.userGotChild)}건(전체 ${String(got.userGotAny)}건) — 0이어야 한다`,
        ),
        assert(
          // ★설계의 핵심. 코어가 "침묵 2주기 = 종료" 로 되돌아가면 여기서 걸린다 —
          //  판단할 소환자가 있는데도 코드가 먼저 죽이는 것이 이 시스템을 뒤집은 이유다.
          "★판단할 소환자가 살아 있으면 완전 침묵 2주기여도 **안 죽인다**",
          got.childAfterTwoRounds === "running",
          `자식 2주기 후=${String(got.childAfterTwoRounds)} (소환자=${String(got.parentAfterTwoRounds)})`,
        ),
      );
    }

    // ── ★소환자가 메인 비서면 코어는 안 죽인다 (2026-08-23 적대 검토 F3) ──────────
    //  사용자가 직접 시킨 백그라운드 작업은 부모가 세션이라 소환자가 **메인 비서**다
    //  (`run_in_background` 를 부른 게 그 비서다). 종전엔 이 경로가 raw 로 사용자에게
    //  직행해 소환자를 건너뛰었고, 그래서 "판단을 넘길 소환자도 없었습니다" 라며
    //  **방금 물어본 상대에게** 거짓말을 하고 죽였다.
    {
      const { got, tail } = runChild("judged", FAST);
      out.push(
        assert(
          "판단자 프로브가 실제로 돌았다(빈손 통과 금지)",
          typeof got.toMain === "number",
          typeof got.toMain === "number" ? "돌았다" : `★프로브 실패: ${tail}`,
        ),
        assert(
          "★점검이 소환자(메인 비서)에게 재주입된다 — 사용자에게 raw 직행 아님",
          typeof got.toMain === "number" && got.toMain > 0 && got.rawToUser === 0,
          `메인 ${String(got.toMain)}건 · raw ${String(got.rawToUser)}건`,
        ),
        assert(
          "★소환자가 받는 동안 코어는 안 죽인다(3주기 조용해도 running)",
          got.statusAfter3 === "running",
          `3주기 후=${String(got.statusAfter3)}`,
        ),
      );
    }

    // ── ★건강하면 점검이 **아예 안 나간다** (2026-08-23) ────────────────────────
    //  마감을 **마지막 활동**에 앵커하므로 활동이 있으면 계속 밀린다. 종전엔 점검 시점에
    //  앵커해서 잘 돌고 있는 잡도 주기마다 깨웠고, 소환자가 매니저면 그 보고가 steering
    //  큐로 들어가 **하던 일을 끊었다**(알림이 아니라 개입).
    {
      const { got, tail } = runChild("alive", FAST);
      out.push(
        assert(
          "활동 프로브가 실제로 돌았다(빈손 통과 금지)",
          typeof got.aliveReports === "number",
          typeof got.aliveReports === "number" ? "돌았다" : `★프로브 실패: ${tail}`,
        ),
        assert(
          "★활동이 계속 있으면 점검이 한 번도 안 나간다(정상 흐름을 안 끊는다)",
          got.aliveReports === 0,
          `점검 ${String(got.aliveReports)}건 — 0이어야 한다`,
        ),
      );
    }

    // ── ★끝난 잡의 증거를 지운다(무한증가 0) ────────────────────────────────────
    //  정리 시점이 `stopCheckinScanner` 의 clear() 뿐이면 잡이 끊이지 않는 인스턴스에서
    //  영영 안 온다. 그래서 **돌고 있는 잡을 남겨 둔 채** 센다 — clear() 로 가려지지 않게.
    {
      const { got, tail } = runChild("leak", FAST);
      out.push(
        assert(
          "누수 프로브가 실제로 돌았다(빈손 통과 금지)",
          typeof got.evidenceAfter === "number" && got.runningJobs === 1,
          typeof got.evidenceAfter === "number"
            ? `running ${String(got.runningJobs)}건`
            : `★프로브 실패: ${tail}`,
        ),
        assert(
          "★끝난 잡 5건의 증거가 안 남는다(돌고 있는 잡 1건만)",
          got.evidenceAfter === 1,
          `증거 ${String(got.evidenceAfter)}건 — running 1건과 같아야 한다`,
        ),
      );
    }

    // ── ⑥ 기본 설정에서 시계가 정상 작업을 안 죽인다 ────────────────────────────
    {
      const { got, tail } = runChild("nokill", {});
      out.push(
        assert(
          "기본 점검 주기가 2시간이다(사용자 결정 2026-08-22)",
          got.checkinInterval === String(2 * 60 * 60_000),
          `주기=${String(got.checkinInterval)}` + (got.checkinInterval === undefined ? ` · ${tail}` : ""),
        ),
        assert(
          "★기본 설정에 wall-clock kill 이 없다(시계가 작업을 안 자른다)",
          got.workerTimeout === "Infinity",
          `WORKER_TIMEOUT_MS=${String(got.workerTimeout)}`,
        ),
        assert(
          "★정상 작업이 시계에 즉시 죽지 않는다(Infinity → 1ms 클램프 방지)",
          got.status === "done" && String(got.result).includes("정상 결과"),
          `${String(got.elapsedMs)}ms · 상태=${String(got.status)} · ${String(got.result)}`,
        ),
      );
    }

    // ── ⑦ ★재주입이 **인바운드 계약을 지킨다** (2026-08-23 2라운드 F1/F1b) ──────
    //  종전엔 `{channel, channelUserId, threadKey, text}` 넉 장만 넘기고 `as never` 로
    //  컴파일러를 눌렀다. 라이브 귀결: 점검 전문이 chat_log 에 "사용자가 친 말"로 남고,
    //  LLM 턴이 돈 뒤 `msg.reply` 가 없어 TypeError → **모델의 판단이 통째로 버려지고**,
    //  자동 종료는 여전히 무장한 채 두 주기 뒤 잡을 죽였다. 알림이 세 번 갔다.
    //  ★텍스트만 보는 검사는 이걸 못 본다 — **모양**을 본다.
    {
      const { got, tail } = runChild("contract", FAST);
      const shapes = Array.isArray(got.shapes)
        ? (got.shapes as Array<Record<string, unknown>>)
        : [];
      const first = shapes[0];
      out.push(
        assert(
          "점검이 메인 비서로 재주입된다",
          shapes.length > 0,
          shapes.length > 0 ? `${shapes.length}건 재주입` : `★재주입 0건 · ${tail}`,
        ),
        assert(
          "★재주입 메시지에 `reply` 가 있다(없으면 턴 끝에서 모델의 판단이 버려진다)",
          first?.hasReply === true,
          first === undefined ? "재주입 없음" : `hasReply=${String(first.hasReply)}`,
        ),
        assert(
          "★`synthetic: true` — 가짜 '나' 버블 차단 + 진행 중 턴에 끼어들지 않는다",
          first?.synthetic === true,
          first === undefined ? "재주입 없음" : `synthetic=${String(first.synthetic)}`,
        ),
        assert(
          "`receivedAt` 이 실린다(IncomingMessage 필수 필드)",
          first?.hasReceivedAt === true,
          first === undefined ? "재주입 없음" : `hasReceivedAt=${String(first.hasReceivedAt)}`,
        ),
      );
    }

    // ── ⑧ ★시스템 자신의 점검 배달이 부모 시계를 되돌리지 않는다 (2R F2) ────────
    {
      const { got, tail } = runChild("parentclock", FAST);
      const stalls = Array.isArray(got.parentStalls)
        ? (got.parentStalls as number[])
        : [];
      const toParent = Number(got.childCheckinsToParent ?? 0);
      const climbs = stalls.length >= 2 && Math.max(...stalls) >= 2;
      out.push(
        assert(
          "자식 점검이 실제로 부모에게 배달된다(이 검사가 헛돌지 않는지)",
          toParent > 0,
          `부모 steering 큐 수신=${toParent}건`,
        ),
        assert(
          "★그 배달이 부모의 무활동 카운터를 되돌리지 않는다(시스템 독백은 판단이 아니다)",
          climbs,
          stalls.length === 0
            ? `★측정 실패 · ${tail}`
            : `부모 stallReports 추이=[${stalls.join(", ")}]` +
              (climbs
                ? ""
                : " — ★0/1 에 고정: 자식이 붙어 있으면 굳은 매니저가 영원히 안 죽는다"),
        ),
      );
    }

    return out;
  },
};
