/**
 * 회귀: **자가성장은 매 턴 비용이 0이고, 자기 카운터를 올리지 않는다** (2026-09-05 재구성).
 *
 * 사용자 질문(*"자가성장 교훈 시스템이 잘 되어 있나 · 메모리 적재도 꼭 필요할까?"*)에서
 * DB 를 열어 나온 것 둘:
 *
 * ①**자기부풀림.** `bumpAccess` 의 호출처는 **단 하나**(`getMemory`)인데, self-growth 가
 *   «이미 박았나?» 를 묻는 **멱등 검사 12곳**에서 그 문을 썼다. 그래서 자기가 쓴 메모리의
 *   `access_count` 를 자기가 올렸다 — 실측 상위 769·455·450회. 인덱스 정렬이 **hot-first**
 *   라 그 부풀림이 곧 **자기 산출물을 인덱스 상석에 올리는 힘**이 됐다(캡 25.6KB 의 84% 가
 *   찬 자리에서 사람이 쓴 규범을 밀어냈다). 판정은 판정이어야 한다 — 세는 행위가 재는
 *   대상을 바꾸면 그건 계측이 아니다.
 *
 * ②**자리.** 제안은 «한 번 닿으면 되는 것» 인데 «매 턴 실리는 자리» 에 있었다. 실측:
 *   살아있는 성장 메모리 24건 = 3,568B = 인덱스 원재료의 **16.5%**, 그 상태로 4개월간
 *   확정 지침 **0건**. 이 레포가 두 번 적어둔 규칙이 정확히 여기다 — *"자리는 중요도가
 *   아니라 «매 턴 필요한가» 로 정한다"* · *"캡 있는 자리에 반드시 도달해야 할 것을 두지
 *   마라"*([[project_hotpath_bound_preserve_record]]).
 *
 * ★2026-08-02 의 «재발 시 갱신으로 인덱스에 남긴다» 는 증상 처방이었다(캡 있는 자리에
 *  계속 두면서 들어가게 만들었다). 이 검사는 **그 되돌림을 막는다** — 다시 인덱스로
 *  올리려면 이 단언들을 먼저 지워야 한다.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEntrySource } from "./_wiring.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = path.join(REPO, "plugins/self-growth/src");

export const check: RegressionCheck = {
  name: "growth-costs-nothing-per-turn",
  guards:
    "자가성장이 자기 멱등 검사로 자기 access 를 올려 인덱스 상석을 차지하던 것 + 제안이 매 턴 실리는 캡 있는 자리를 16.5% 먹던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ── ① 계측이 계측을 바꾸지 않는다 ─────────────────────────────────────────
    const store = readFileSync(path.join(REPO, "src/store/memory.ts"), "utf8");
    // 정의는 `const bumpAccess = (` 라 아래 패턴에 안 걸린다 — 호출만 센다.
    const bumpSites = [...store.matchAll(/\bbumpAccess\(db/g)].length;
    out.push(
      assert(
        "access 를 올리는 문은 여전히 하나다(늘면 어디서 세는지 추적이 끊긴다)",
        bumpSites === 1,
        `bumpAccess 호출 ${bumpSites}곳`,
      ),
    );
    out.push(
      assert(
        "세지 않고 보는 문이 있다(peekMemory)",
        /export const peekMemory/.test(store),
        /export const peekMemory/.test(store) ? "있음" : "★없음",
      ),
    );

    const files = readdirSync(PLUGIN).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(PLUGIN, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
      if (/\bgetMemory\(/.test(src)) offenders.push(f);
    }
    out.push(
      assert(
        "★★자가성장은 자기 산출물을 셀 때 access 를 올리지 않는다(멱등 검사=peek)",
        offenders.length === 0,
        offenders.length === 0
          ? `${files.length}파일 전부 peekMemory`
          : `★getMemory 를 쓰는 파일: ${offenders.join(", ")} — 자기 카운터를 자기가 올린다`,
      ),
    );

    // ── ② 산출물은 매 턴 실리는 자리에 두지 않는다 ────────────────────────────
    // ★**주석을 코드로 세지 않는다** — 첫 판이 그랬고, `archiveMemory` 를 주석 처리하는
    //  변이가 **초록으로 통과했다**(이 레포가 이미 두 번 당한 부류:
    //  [[feedback_gate_must_actually_run]]). 걷어내고 본다.
    const analysis = readFileSync(path.join(PLUGIN, "analysis.ts"), "utf8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const door = analysis.slice(analysis.indexOf("export const upsertReflection"));
    out.push(
      assert(
        "★박는 문이 곧 내리는 문이다(upsertReflection 이 archive 까지 한다)",
        /archiveMemory\(input\.name\)/.test(door.slice(0, 1200)),
        /archiveMemory\(input\.name\)/.test(door.slice(0, 1200))
          ? "박자마자 인덱스에서 내림"
          : "★인덱스에 남는다 — 캡 있는 자리를 먹는다",
      ),
    );
    // 쓰기가 그 문 밖으로 새면 위 보장이 무의미하다 — 문을 하나로 유지한다.
    const rawWrites: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(PLUGIN, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
      const n = [...src.matchAll(/\baddMemory\(\{/g)].length;
      if (n > 0 && f !== "analysis.ts") rawWrites.push(`${f}(${n})`);
    }
    out.push(
      assert(
        "★쓰기가 그 문 하나로 모인다(직접 addMemory 하면 인덱스로 새어 나간다)",
        rawWrites.length === 0,
        rawWrites.length === 0 ? "직접 쓰기 0" : `★문 밖 쓰기: ${rawWrites.join(", ")}`,
      ),
    );

    // ── ③ 도달은 «매 턴» 이 아니라 «한 번» 이다 ───────────────────────────────
    // 진입 경로 전체(진입점 + core/entry) — `/status` 본문이 옮겨갔다(구조 감사 ③).
    const index = readEntrySource();
    out.push(
      assert(
        "★내려둔 것이 쌓이면 `/status` 가 한 번 말한다(안 실리는 대신 도달은 남긴다)",
        /countArchivedMemories\(\)/.test(index) && /미열람/.test(index),
        /countArchivedMemories\(\)/.test(index) ? "status 줄 있음" : "★도달 경로가 없다",
      ),
    );
    out.push(
      assert(
        "그 줄은 이름을 모른다(코어가 플러그인 이름을 하드코딩하지 않는다 — §0 단방향)",
        !/countArchivedMemories[\s\S]{0,400}feedback_growth/.test(index),
        `countArchivedMemories 주변 400자에 growth 접두=${/countArchivedMemories[\s\S]{0,400}feedback_growth/.test(index)}`,
      ),
    );

    // ── ④ 가리키는 것이 이미 옆에 있으면 포인터를 두지 않는다 ─────────────────
    out.push(
      assert(
        "SELF_GROWTH.md 포인터 메모가 없다(지침 본문이 이미 시스템 슬롯으로 실린다)",
        !files.some((f) =>
          /ensureDirectivePointer|POINTER_MEMO_NAME/.test(readFileSync(path.join(PLUGIN, f), "utf8")),
        ),
        `포인터 흔적 있는 파일=${files.filter((f) => /ensureDirectivePointer|POINTER_MEMO_NAME/.test(readFileSync(path.join(PLUGIN, f), "utf8"))).join(", ") || "없음"}`,
      ),
    );

    // ── ⑤ 원인을 모르면 안 남긴다 ────────────────────────────────────────────
    const failure = readFileSync(path.join(PLUGIN, "failure.ts"), "utf8");
    out.push(
      assert(
        "★원인·처방이 둘 다 비면 실패 반성을 만들지 않는다(실측 12건 중 8건이 빈칸이었다)",
        /const hasCause =[\s\S]{0,200}if \(!hasCause\) return null;/.test(failure),
        /if \(!hasCause\) return null;/.test(failure) ? "빈칸 미기록" : "★빈칸도 기록한다",
      ),
    );

    return out;
  },
};
export default check;
