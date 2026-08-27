/**
 * 회귀: **대화의 도구 스텝은 레코드다 — 정리 대상이 아니다** (2026-08-27).
 *
 * ★사고(사용자 관측): *"시간이 지난 옛날 대화들에서 도구 사용이 사라졌어"*. 실측으로
 *  갈렸다 — 같은 DB 에서 대화 **텍스트는 63일치**(`chat_log`, 무한)인데 **도구 스텝은
 *  8일치**(`events`, 5,000 캡)뿐이었다. 옛 대화를 열면 말은 있고 도구 카드만 없다.
 *
 * ★뿌리는 `llm.activity` **하나가 두 일을 겸한 것**이다:
 *   - 대화의 도구 스텝 = 화면에 보이는 **레코드**(`/chat-history` 가 이걸로 복원한다)
 *   - 잡·게이트웨이 스텝 = 진짜 **휘발성 텔레메트리**(읽는 쪽이 애초에 제외한다) — 양의 70%
 *  2026-07-09 는 *"events 에 이미 있으니 쓰자"* 로 복원을 얹었고, 사흘 뒤 유지보수 ADR 은
 *  *"events = 휘발성, 삭제 YES"* 로 굳혔다. 두 판단이 서로를 몰랐다.
 *
 * ★**희귀 타입 보호는 이 캡의 일이 아니다.** 2026-07-30 타입별 쿼터 이후 희귀 타입은 별도
 *  DELETE 로 자기 몫을 받으므로, `llm.activity` 가 커져도 못 밀어낸다 — 그래서 레코드 축을
 *  남겨도 그 보호는 그대로다. 이 검사가 **셋을 한 번에** 보는 이유가 그것이다.
 *
 * ★**깨진 payload 한 행이 프루닝을 멈추지 않는가**도 본다 (2026-08-27 적대 검토 M2).
 *  라이브 DB 에 실측 **1건** 있다(잘린 payload). `json_valid` 가드가 없으면 `json_extract`
 *  가 통째로 throw 하고, `runPrune` 이 그걸 삼켜 **정리가 영구 정지**한다 — 게다가 그 행은
 *  이제 안 지워지므로 **자가복구도 안 된다**. 소스로는 안 보이고 "돌아가는가" 로만 보인다.
 *
 * 등급: **동작 검사** — 임시 홈에 진짜 DB 를 만들어 `pruneEvents` 를 **실행**한다.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Probe {
  /** 프루닝이 던졌나 — 던지면 정리가 영구 정지한다(깨진 payload 1행이면 충분). */
  threw: string;
  removed: number;
  record: number;
  archived: number;
  scheduler: number;
  noThread: number;
  volatileLeft: number;
  rare: number;
  total: number;
  prunable: number;
}

export const check: RegressionCheck = {
  name: "activity-record-is-not-pruned",
  guards:
    "대화의 도구 스텝이 휘발성 텔레메트리와 한 타입에 묶여 5,000건 캡에 잘려, 옛 대화를 열면 텍스트만 남고 도구 카드가 사라지던 것(텍스트 63일 / 도구 8일) + 그 수정이 유지보수 경보를 영구 오경보로 만드는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tgc-prune-"));
    let p: Probe | undefined;
    try {
      // ★자식 프로세스 — `getPaths()` 가 메모이즈돼 있어 이 프로세스 안에서 홈을 바꾸면
      //  **단독 실행은 초록, 스위트 안에선 빨강**인 순서 의존 검사가 된다(같은 함정에
      //  2026-08-27 에 이미 한 번 빠졌다). `tsx -e` 는 cjs 라 최상위 await 이 안 된다.
      const KEEP = 100; // perType = 50 — 레코드 200건이 캡을 넘도록 일부러 작게.
      // ★**넣는 순서가 판별력이다.** 레코드가 잡 행보다 **나중**(= 더 큰 id)이어야
      //  `id NOT IN (최신 N)` 의 **안쪽 목록**을 축으로 좁혔는지가 드러난다. 반대로 넣으면
      //  최신 N 이 어차피 전부 잡 행이라, 안쪽 스코프를 지워도 결과가 같아 변이가 통과한다
      //  (첫 판이 정확히 그랬다 — 변이 3종 중 하나가 안 잡혔다).
      const probe = `void (async () => {
        const { initStore, getDb } = await import(${JSON.stringify(path.join(REPO, "src/store/sessions.ts"))});
        const ev = await import(${JSON.stringify(path.join(REPO, "src/store/events.ts"))});
        initStore();
        const db = getDb();
        db.prepare("DELETE FROM events").run();
        db.prepare("DELETE FROM threads").run();
        // ★판정이 접두가 아니라 **세션 존재**로 바뀌었다(2026-08-27 적대 검토 F1) — 픽스처도
        //  실제 모양을 만들어야 한다. 손 목록이 사라진 대가로 픽스처가 조금 커진다.
        const mk = (k, arch) => db.prepare(
          "INSERT INTO threads (channel, channel_thread_id, claude_session_id, last_used_at, created_at, archived_at) VALUES (?,?,?,?,?,?)"
        ).run("dashboard", k, "sid-" + k, 1, 1, arch);
        mk("dashboard:default", null);
        mk("agent:abc", null);          // threads 행이 있어도 **내부 파생**이라 휘발성
        mk("scheduler:1", null);        // ★F1: 종전엔 '대화 레코드' 로 영구 보존되던 것
        mk("dashboard:archived", 5);    // ★보관은 숨기는 것이지 지우는 게 아니다
        for (let i = 0; i < 200; i++)
          ev.insertEvent(1 + i, "llm.activity", JSON.stringify({ threadKey: "worker:abc", kind: "tool", seq: i }));
        for (let i = 0; i < 100; i++)
          ev.insertEvent(201 + i, "llm.activity", JSON.stringify({ threadKey: "scheduler:1", kind: "tool", seq: i }));
        for (let i = 0; i < 100; i++)
          ev.insertEvent(301 + i, "llm.activity", JSON.stringify({ threadKey: "suggest:auto", kind: "tool", seq: i }));
        for (let i = 0; i < 200; i++)
          ev.insertEvent(401 + i, "llm.activity", JSON.stringify({ threadKey: "dashboard:default", kind: "tool", seq: i }));
        for (let i = 0; i < 50; i++)
          ev.insertEvent(701 + i, "llm.activity", JSON.stringify({ threadKey: "dashboard:archived", kind: "tool", seq: i }));
        for (let i = 0; i < 3; i++) ev.insertEvent(1 + i, "llm.turn_error", JSON.stringify({ e: i }));
        // 깨진 JSON 행 — 설명은 이 파일 헤더에(프로브는 템플릿 리터럴이라 백틱을 못 쓴다).
        ev.insertEvent(9999, "llm.activity", '{"threadKey":"dashboard:default","kind":"tool"');
        let threw = "";
        let removed = 0;
        try {
          removed = ev.pruneEvents(${KEEP});
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e);
        }
        // ★검사 쿼리에도 가드가 필요하다 — 일부러 심은 깨진 행 때문에 **검사 자신이** 죽는다
        //  (첫 판이 그랬다: 제품이 아니라 프로브가 malformed JSON 으로 터졌다).
        const q = (w) => db.prepare("SELECT COUNT(*) n FROM events WHERE json_valid(payload) AND " + w).get().n;
        console.log("__J__" + JSON.stringify({
          threw,
          removed,
          record: q("type='llm.activity' AND json_extract(payload,'$.threadKey')='dashboard:default'"),
          archived: q("type='llm.activity' AND json_extract(payload,'$.threadKey')='dashboard:archived'"),
          scheduler: q("type='llm.activity' AND json_extract(payload,'$.threadKey') LIKE 'scheduler:%'"),
          noThread: q("type='llm.activity' AND json_extract(payload,'$.threadKey') LIKE 'suggest:%'"),
          volatileLeft: q("type='llm.activity' AND json_extract(payload,'$.threadKey') LIKE 'worker:%'"),
          rare: q("type='llm.turn_error'"),
          total: ev.countEvents(),
          prunable: ev.countPrunableEvents(),
        }));
      })();`;
      const r = spawnSync(path.join(REPO, "node_modules/.bin/tsx"), ["-e", probe], {
        cwd: tmp,
        env: { ...process.env, TIGUCLAW_HOME: tmp },
        encoding: "utf8",
        timeout: 120_000,
      });
      const line = `${r.stdout ?? ""}`.split("\n").find((l) => l.startsWith("__J__"));
      p = line === undefined ? undefined : (JSON.parse(line.slice(5)) as Probe);
      out.push(
        assert(
          "★프로브가 실제로 돌았다(0이면 아래는 미검사다)",
          p !== undefined,
          p === undefined ? `★실패 — ${`${r.stderr ?? ""}`.slice(-220)}` : JSON.stringify(p),
        ),
      );
      if (p === undefined) return out;

      out.push(
        assert(
          "★대화 도구 스텝은 캡을 넘어도 안 지워진다(옛 대화에 도구가 남는다)",
          p.record === 200,
          `${p.record}/200 — 줄었으면 사용자가 '말만 있고 도구가 없는' 대화를 본다`,
        ),
        assert(
          "★보관된 대화도 레코드다(보관은 숨기는 것이지 지우는 게 아니다)",
          p.archived === 50,
          `${p.archived}/50 — 0이면 보관 해제 시 말만 남는다`,
        ),
        assert(
          "★★내부 파생은 threads 행이 있어도 휘발성이다(F1: scheduler 가 영구 보존되던 것)",
          p.scheduler === 0,
          `scheduler 잔여 ${p.scheduler}(기대 0) — 남으면 손 목록이 정본과 또 갈린 것`,
        ),
        assert(
          "★세션 행이 아예 없는 좌표도 휘발성이다(suggest:·webfetch: 실측)",
          p.noThread <= 50,
          `suggest 잔여 ${p.noThread} — 캡(50) 안이면 자기 몫만 남은 것`,
        ),
        assert(
          "★깨진 payload 한 행이 프루닝을 멈추지 않는다(라이브에 실측 1건 있다)",
          p.threw === "",
          p.threw === "" ? "던지지 않음" : `★throw: ${p.threw} — 정리가 영구 정지한다`,
        ),
        assert(
          "★휘발성이 실제로 잘린다(no-op 아님)",
          p.removed === 350,
          `지운 ${p.removed}(기대 350: worker 200 + scheduler 100 + suggest 100 − 캡 50)`,
        ),
        assert(
          "★희귀 사고 단서는 그대로다(2026-07-30 쿼터가 살아 있다)",
          p.rare === 3,
          `turn_error ${p.rare}/3 — 0이면 활동량이 진단면을 밀어낸 것`,
        ),
        // ★A 를 바꾸면 A 에 의존하던 B 를 본다 — 경보가 총계를 쓰면 영구 오경보가 된다.
        assert(
          "★경보는 **정리 대상만** 센다(레코드가 상한을 밀어올리지 않는다)",
          p.prunable === 53 && p.total === 304,
          `정리대상 ${p.prunable}(기대 53) · 총계 ${p.total}(기대 304: 대화 200 + 보관 50 + 휘발 잔여 50 + 희귀 3 + 깨진행 1)`,
        ),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }

    // 경보가 그 함수를 실제로 쓰는가 — 정의만 있고 안 부르면 오경보가 그대로다.
    const maint = await fs.readFile(path.join(REPO, "src/core/maintenance.ts"), "utf8");
    const code = maint.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    out.push(
      assert(
        "★유지보수 경보가 countPrunableEvents 로 판정한다",
        /boundedStatus\(prunable,/.test(code),
        /countPrunableEvents/.test(code)
          ? "판정에 사용"
          : "★총계로 되돌아갔다 — 레코드가 쌓이면 영구 attention 오경보",
      ),
    );
    return out;
  },
};
