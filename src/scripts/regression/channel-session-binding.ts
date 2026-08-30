/**
 * 회귀: 채널→세션 바인딩이 실제로 인입 경로를 바꾸고, 셀렉터 채널은 건드리지 않는다
 * (2026-07-28 신규 기능 — `/sessions`).
 *
 * 지키는 계약:
 *  1. 바인딩이 없으면 기존 그대로 기본 세션(회귀 0 — 이게 깨지면 전 채널이 엉뚱한 데로 간다).
 *  2. 바인딩이 있으면 그 세션으로 간다(대화방 단위 — DM/그룹이 각각).
 *  3. **explicit 세션(대시보드 탭)이 언제나 이긴다** — 셀렉터 있는 채널은 바인딩 무관.
 *     이게 뒤집히면 대시보드에서 탭을 골라도 딴 세션에 쌓인다.
 *  4. 해제하면 기본 세션으로 돌아온다.
 */
import {
  resolveSessionId,
  setChannelSessionBindingLookup,
  DEFAULT_SESSION_ID,
} from "../../core/threadkey.js";
import {
  getChannelSessionBinding,
  setChannelSessionBinding,
  clearChannelSessionBinding,
  clearBindingsForSession,
  setSessionArchived,
} from "../../store/channel-session.js";
import { listThreads, getDb, setThreadArchived, deleteSession } from "../../store/sessions.js";
import { readSource } from "./_wiring.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "telegram";
const DM = "chat-dm-1";
const GROUP = "chat-group-1";
const S1 = "dashboard:regression-session-1";
const S2 = "dashboard:regression-session-2";

export const check: RegressionCheck = {
  name: "channel-session-binding",
  guards: "셀렉터 없는 채널의 세션 고정 — 바인딩 무시/역전 시 대화가 엉뚱한 세션에 쌓임",
  run: async (): Promise<Assertion[]> => {
    assertIsolated(); // 라이브 DB 접촉 차단(러너 밖 실행 방지).
    // 부팅(index.ts)이 하는 등록을 여기서도 한다 — 미등록이면 바인딩이 **조용히 무시**되므로
    // 그 상태를 통과로 오판하지 않게 등록 후/전을 모두 확인한다.
    setChannelSessionBindingLookup(null);
    const beforeRegister = resolveSessionId(CH, DM);
    setChannelSessionBindingLookup((c, a) => getChannelSessionBinding(c, a));

    clearChannelSessionBinding(CH, DM);
    clearChannelSessionBinding(CH, GROUP);
    const out: Assertion[] = [
      assert("미등록이면 기본 세션(안전 degrade)", beforeRegister === DEFAULT_SESSION_ID, beforeRegister),
      assert("바인딩 없으면 기본 세션(회귀 0)", resolveSessionId(CH, DM) === DEFAULT_SESSION_ID, resolveSessionId(CH, DM)),
    ];

    setChannelSessionBinding(CH, DM, S1);
    out.push(assert("바인딩하면 그 세션으로", resolveSessionId(CH, DM) === S1, resolveSessionId(CH, DM)));
    out.push(
      assert(
        "다른 대화방은 영향 없음(방 단위)",
        resolveSessionId(CH, GROUP) === DEFAULT_SESSION_ID,
        resolveSessionId(CH, GROUP),
      ),
    );

    setChannelSessionBinding(CH, GROUP, S2);
    out.push(
      assert(
        "DM·그룹이 각각 다른 세션",
        resolveSessionId(CH, DM) === S1 && resolveSessionId(CH, GROUP) === S2,
        `${resolveSessionId(CH, DM)} / ${resolveSessionId(CH, GROUP)}`,
      ),
    );

    // ★가장 중요한 계약 — 셀렉터(대시보드 탭)가 언제나 이긴다.
    out.push(
      assert(
        "explicit 세션이 바인딩을 이긴다(대시보드 무영향)",
        resolveSessionId(CH, DM, "dashboard:explicit-tab") === "dashboard:explicit-tab",
        resolveSessionId(CH, DM, "dashboard:explicit-tab"),
      ),
    );

    clearChannelSessionBinding(CH, DM);
    out.push(assert("해제하면 기본 세션으로", resolveSessionId(CH, DM) === DEFAULT_SESSION_ID, resolveSessionId(CH, DM)));

    clearChannelSessionBinding(CH, GROUP);

    // ── 프로브 흔적 필터 (2026-07-28) — 사용자에게 보이는 세션 목록에 검증 찌꺼기가 섞이던 것.
    //  실측: 찌꺼기는 전부 "무명 + 왕복 1회(메시지 2건)". 이름을 붙였으면 실사용 증거다.
    const db = getDb();
    const ins = db.prepare(
      `INSERT OR REPLACE INTO threads (channel, channel_thread_id, claude_session_id, model, system_prompt_hash, last_used_at, created_at, name)
       VALUES ('http-bridge', ?, '', NULL, NULL, ?, ?, ?)`,
    );
    const msg = db.prepare(
      `INSERT INTO chat_log (thread_key, channel, role, text, ts) VALUES (?, 'http-bridge', 'user', 'x', ?)`,
    );
    const now = Date.now();
    ins.run("probe:regression-junk", now, now, null); // 무명 + 메시지 2건 = 프로브
    msg.run("probe:regression-junk", now);
    msg.run("probe:regression-junk", now + 1);
    ins.run("probe:regression-named", now, now, "이름있는세션"); // 이름 있으면 메시지 적어도 통과
    msg.run("probe:regression-named", now);
    const listed = listThreads({ excludeInternal: true, limit: 200 }).map(
      (t) => t.threadKey,
    );
    // ★2026-08-09 뒤집힘 — 종전엔 "무명 + 왕복1회는 제외" 를 지켰다. 그 규칙이 실제로 막던 건
    //  **우리 테스트 산물**이었고(dev 12건 전부 `test:`·`verify:`·`cr-e2e-*`), 대신 갓 시작한
    //  진짜 대화를 같이 삼켰다 — 비서가 만든 세션이 목록에 없어 사용자가 못 봤다.
    //  이제 사용자 대면 세션은 **길이와 무관하게 전부** 보인다. 숨김은 보관(archive)이 한다.
    out.push(
      assert(
        "★짧고 무명이어도 목록에 나온다(갓 시작한 대화가 사라지지 않게)",
        listed.includes("probe:regression-junk"),
        `${listed.length}건 중 포함=${listed.includes("probe:regression-junk")}`,
      ),
    );
    out.push(
      assert(
        "이름 있는 세션도 그대로 표시",
        listed.includes("probe:regression-named"),
        `포함=${listed.includes("probe:regression-named")}`,
      ),
    );
    out.push(
      assert(
        "★내부 파생 스레드는 **여전히** 배제(세션이 아니라 잡 — dev 실측 310건 중 285건)",
        // ★**제품이 쓰는 호출 형태**로도 확인한다(limit 미지정). 종전엔 `limit: 200` 으로만
        //  검사해서, 배제를 limit 유무와 결합시키는 변이가 통과했다(적대 검토 M42).
        !listed.some((k) => /^(worker|agent|endpoint|gateway|scheduler):/.test(k)) &&
          !listThreads({ excludeInternal: true })
            .map((x) => x.threadKey)
            .some((k) => /^(worker|agent|endpoint|gateway|scheduler):/.test(k)),
        `파생 혼입=${listed.filter((k) => /^(worker|agent|endpoint|gateway|scheduler):/.test(k)).length}건`,
      ),
    );
    // ── 세션 보관 (2026-07-29) — 삭제가 아니라 숨김. 기록은 남아야 한다.
    const AK = "probe:regression-named";
    setThreadArchived(AK, Date.now());
    const afterArchive = listThreads({ excludeInternal: true, limit: 200 })
      .map((t) => t.threadKey);
    const msgsKept = (
      getDb().prepare(`SELECT count(*) n FROM chat_log WHERE thread_key = ?`).get(AK) as { n: number }
    ).n;
    out.push(assert("보관하면 목록에서 빠진다", !afterArchive.includes(AK), `포함=${afterArchive.includes(AK)}`));
    out.push(assert("★보관은 삭제가 아니다 — 대화 기록 보존", msgsKept > 0, `메시지 ${msgsKept}건`));
    const archivedOnly = listThreads({ excludeInternal: true, onlyArchived: true, limit: 200 })
      .map((t) => t.threadKey);
    out.push(assert("보관 목록에서는 보인다(복원 가능)", archivedOnly.includes(AK), `${archivedOnly.length}건`));
    setThreadArchived(AK, null);
    const afterRestore = listThreads({ excludeInternal: true, limit: 200 })
      .map((t) => t.threadKey);
    out.push(assert("복원하면 목록에 다시 나온다", afterRestore.includes(AK), `포함=${afterRestore.includes(AK)}`));

    // ── 2026-07-29 검토 반영 — 배포된 /sessions 의 실기능 결함들 ──────────────
    // ① 보관하면 **모든 방**의 바인딩이 풀려야 한다(명령 보낸 방 하나가 아니라).
    const R1 = "probe:regression-multi";
    ins.run(R1, now, now, "여러방세션");
    setChannelSessionBinding("telegram", "roomA", R1);
    setChannelSessionBinding("telegram", "roomB", R1);
    // ★**제품 함수를 부른다** (2026-08-19). 종전엔 이 검사가 `setThreadArchived` 와
    //  `clearBindingsForSession` 을 **자기 손으로 조립**해서 봤다 — 그래서 제품 경로가
    //  그 조립을 빠뜨려도 초록이었고, 실제로 엔드포인트(대시보드 탭 닫기가 오는 주 경로)가
    //  바인딩을 안 풀고 있었다. 부품이 옳은지가 아니라 **제품이 옳은지**를 봐야 한다.
    const { changed, unboundRooms: freed } = setSessionArchived(R1, true);
    out.push(
      assert(
        "★보관 시 그 세션을 가리키던 모든 방이 풀린다(제품 함수 실행)",
        changed === 1 &&
          freed === 2 &&
          resolveSessionId("telegram", "roomB") === DEFAULT_SESSION_ID,
        `변경 ${changed} · 해제 ${freed}곳 / roomB=${resolveSessionId("telegram", "roomB")}`,
      ),
    );
    out.push(
      assert(
        "보관은 비파괴 — 복원하면 목록에 돌아온다(대화는 그대로)",
        setSessionArchived(R1, false).changed === 1 &&
          listThreads({ excludeInternal: true }).some((t) => t.threadKey === R1),
        "복원 확인",
      ),
    );
    setSessionArchived(R1, true); // 뒤 판정에 영향 없게 다시 숨김.

    // ② 세션 삭제(/reset)도 바인딩을 지워야 한다 — 안 지우면 삭제된 id 로 계속 인입된다.
    const R2 = "probe:regression-deleted";
    ins.run(R2, now, now, "지울세션");
    setChannelSessionBinding("telegram", "roomC", R2);
    deleteSession("http-bridge", R2);
    out.push(
      assert(
        "세션 삭제 시 바인딩도 사라진다(유령 인입 차단)",
        resolveSessionId("telegram", "roomC") === DEFAULT_SESSION_ID,
        resolveSessionId("telegram", "roomC"),
      ),
    );

    db.prepare(`DELETE FROM threads WHERE channel_thread_id LIKE 'probe:regression-%'`).run();
    db.prepare(`DELETE FROM channel_session_binding WHERE channel='telegram' AND channel_address IN ('roomA','roomB','roomC')`).run();
    db.prepare(`DELETE FROM chat_log WHERE thread_key LIKE 'probe:regression-%'`).run();
    // ★소비처 전수 — 회귀는 `listThreads` 를 **직접** 부르므로, 제품 호출부가 옵션을 잃어도
    //  못 본다(적대 검토 M11: `/sessions` 에서 excludeInternal 유실 → worker:/agent: 잡이
    //  사용자 세션 목록·탭바로 쏟아짐). 사용자 대면 목록을 만드는 자리 전수를 본다.
    {
      const files: Array<[string, RegExp]> = [
        // ★**핸들러 함수** 기준으로 본다 (2026-08-30). 종전엔 `pathname === "/sessions"` 부터
        //  900자 안을 봤는데, 라우트 본문이 `routes-sessions.ts` 로 갈리면서 조건과 본문이
        //  **다른 파일**이 됐다. 원래 묻고 싶던 것은 *"그 핸들러가 내부 파생을 배제하나"* 이지
        //  *"조건 근처에 그 호출이 있나"* 가 아니었다 — 자리보다 판정이 정확해졌다.
        ["../../../plugins/http-bridge", /handleSessions = async[\s\S]{0,900}listThreads\(\{ excludeInternal: true/],
        ["../../../src/core/llm-runtime/capabilities/session-tools-mcp.ts", /listThreads\(\{ excludeInternal: true/],
        ["../../../src/index.ts", /listThreads\(\{ excludeInternal: true/],
      ];
      const missing: string[] = [];
      for (const [rel, re] of files) {
        const body = await readSource(rel);
        if (!re.test(body)) missing.push(rel.split("/").pop() ?? rel);
      }
      out.push(
        assert(
          "★사용자 대면 목록을 만드는 **모든 호출부**가 내부 파생을 배제한다",
          missing.length === 0,
          missing.length === 0 ? "http-bridge · session-tools-mcp · index" : `★누락: ${missing.join(" · ")}`,
        ),
      );
    }
    return out;
  },
};
