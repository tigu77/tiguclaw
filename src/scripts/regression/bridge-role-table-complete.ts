/**
 * 회귀: **부작용 있는 엔드포인트가 role 표에서 빠지면 게이트 없이 통과한다** (2026-08-21 적대 검토 B-F1).
 *
 * 사고: 브리지 권한은 `const required: BridgeTokenRole | null = …` 하나가 정한다. 그런데
 * 그건 **손으로 관리하는 목록**이라, 새 POST 엔드포인트를 거기 안 적으면 `required = null`
 * 로 떨어져 **아무 게이트도 안 걸린다.** 이 레포는 이미 한 번 당했다 — `set-session-profile`
 * 이 누락돼 read 토큰이 세션 프로파일을 바꿀 수 있었다(그 사고 주석이 지금도 표에 남아 있다).
 *
 * 그런데 그걸 지키는 검사가 **하나도 없었다**: 적대 검토가 `/self-update`·`/log-clear` 를
 * 표에서 통째로 지우는 변이를 심었는데 스위트 1,461건이 초록이었다. `/self-update` 는
 * 재시작이 아니라 **코드를 갈아끼운다** — 게이트 누락의 대가가 다른 등급이다.
 *
 * ★고침은 표를 늘리는 게 아니라 **판정으로 바꾸는 것**이다: "핸들러가 다루는 POST 경로"를
 *  소스에서 뽑아, 그 전부가 role 표에 있어야 한다고 요구한다. 새 엔드포인트가 생기면
 *  적든 안 적든 이 검사가 먼저 운다.
 *
 * ★**GET 을 빼는 것은 게으름이 아니라 전제였다 — 그런데 그 전제가 무방비였다** (2026-08-30
 *  구조 검토). 등급 없는 GET 이 무해한 이유는 딱 하나다: `read` 가 **최하위 등급**이라
 *  `required=null`(검사 없음)과 `required="read"` 가 같은 결과를 낸다. 실제로 지금
 *  `/egress`·`/suggestion` 두 GET 이 표에 없고, `/suggestion` 주석은 *"read 게이트 기본"*
 *  이라고 적혀 있다 — **기본값이 있다고 믿고 쓴 것이다.** 오늘은 맞지만 그건 우연이 아니라
 *  ROLE_RANK 의 성질이고, `read` 아래에 등급이 하나 생기는 순간 **등급 없는 GET 60개가
 *  전부 그 아래로 열린다.** 그래서 아래 ③이 그 전제를 못으로 박는다.
 *
 * ★**메서드를 손으로 적지 않는다** — 종전엔 `"POST"` 가 정규식에 박혀 있어, 누가
 *  `DELETE`·`PUT` 분기를 더하면 이 검사가 **조용히 그것만 안 봤다**. 이제 소스에서
 *  분기하는 메서드를 뽑아 GET 이 아닌 전부를 요구한다([[feedback_hand_maintained_lists]]).
 *
 * ★한계(정직하게): 이건 **소스를 읽는 검사**다. 경로 문자열을 변수로 빼거나 동적으로
 *  조립하면 못 본다. 지키는 것은 "표에 빠졌는가" 한 가지이고, 역할 등급이 **적절한가**
 *  (write 로 족한가 admin 이어야 하나)는 사람이 판단한다.
 */
import { readFileSync } from "node:fs";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 소스가 **실제로 분기하는** 메서드 전부 — 목록을 손으로 안 적는다. */
const dispatchedMethods = (src: string): string[] =>
  [...new Set([...src.matchAll(/method === "([A-Z]+)"/g)].map((m) => m[1]!))].sort();

/** `pathname === "/x" && method === "<M>"` 형태에서 경로를 전부 뽑는다. */
const pathsFor = (src: string, method: string): Set<string> => {
  const out = new Set<string>();
  const re = new RegExp(`pathname === "([^"]+)"\\s*&&\\s*method === "${method}"`, "g");
  for (const m of src.matchAll(re)) out.add(m[1]!);
  return out;
};

export const check: RegressionCheck = {
  name: "bridge-role-table-complete",
  guards:
    "새 엔드포인트를 브리지 role 표에 안 적으면 required=null 로 **게이트 없이** 통과하던 것(자가업데이트·로그삭제 포함) + 검사가 `POST` 를 손으로 박아 새 메서드(DELETE·PUT) 분기를 조용히 안 보던 것 + GET 을 면제해도 되는 근거(`read` 가 최하위라 「등급 없음 ≡ read」)가 아무 데서도 안 지켜지던 것 — `read` 아래 등급이 하나 생기면 등급 없는 GET 60개가 전부 열린다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = readSourceSync("plugins/http-bridge");

    // role 표 = `const required: BridgeTokenRole | null =` 부터 그 문장의 끝(`;`)까지.
    const start = src.indexOf("const required: BridgeTokenRole | null =");
    const end = start < 0 ? -1 : src.indexOf("\n    if (", start);
    out.push(
      assert(
        "브리지 role 표를 찾을 수 있다(못 찾으면 이 검사가 조용히 무의미해진다)",
        start >= 0 && end > start,
        start < 0 ? "★`const required: BridgeTokenRole | null =` 없음" : `${end - start}자`,
      ),
    );
    if (start < 0 || end <= start) return out;

    const table = src.slice(start, end);

    // ── ① 등급이 필요한 메서드 전수 (GET 은 ③이 정당화한다) ─────────────────
    // ★`"POST"` 를 안 적는다 — 소스가 분기하는 메서드에서 파생시킨다. DELETE·PUT 분기가
    //  생기면 이 검사가 **알아서** 따라간다(안 그러면 그것만 조용히 안 보게 된다).
    const methods = dispatchedMethods(src);
    out.push(
      assert(
        "브리지가 분기하는 메서드를 소스에서 뽑는다(손으로 적으면 새 메서드를 조용히 놓친다)",
        methods.length > 0 && methods.includes("GET") && methods.includes("POST"),
        methods.join(", "),
      ),
    );

    const gated = methods.filter((m) => m !== "GET");
    for (const method of gated) {
      const inTable = pathsFor(table, method);
      const everywhere = pathsFor(src, method);
      // ★`/v1/*` 는 정당한 예외 — OpenAI 호환 게이트웨이 표면이라 **자기 토큰**(gateway
      //  token)으로 따로 인증한다. 이름이 아니라 **접두사 규칙**으로 뺀다.
      const ungated = [...everywhere].filter(
        (pth) => !inTable.has(pth) && !pth.startsWith("/v1/"),
      );
      out.push(
        assert(
          `★핸들러가 다루는 ${method} 경로 전부가 role 표에 있다(빠지면 required=null = 게이트 없음)`,
          ungated.length === 0,
          ungated.length === 0
            ? `${method} ${everywhere.size}개 전부 등급 있음`
            : `★등급 없는 ${method}: ${ungated.join(", ")}`,
        ),
      );
    }

    const gatewayPaths = [...pathsFor(src, "POST")].filter((pth) => pth.startsWith("/v1/"));
    out.push(
      assert(
        "게이트웨이(/v1/*) 예외는 자기 인증을 갖는다 — 그래서 role 표 밖인 것이 정당하다",
        gatewayPaths.length === 0 || /gateway[\s\S]{0,200}token/i.test(src),
        `게이트웨이 경로 ${gatewayPaths.length}개 · 별도 토큰 인증 확인=${/gateway[\s\S]{0,200}token/i.test(src)}`,
      ),
    );

    // ── ★게이트 위치 판정은 **뺐다** (2026-08-30, 적대 검토 2R C조) ──────────
    // 1라운드에서 *"role 표에 등급이 있는 라우트는 전부 인증 게이트 뒤"* 판정을 넣었는데,
    // 2라운드가 그 판정에서 **P5 를 셋** 찾았다. 전부 실측 재현이다:
    //
    //  ① `readSourceSync` 가 **주석을 안 벗긴다** → 게이트를 *설명하는* 주석 한 줄이 앞
    //     파일에 있으면 기준점이 거기로 잡혀 **모든 라우트가 "뒤"** 가 된다. 그 상태로
    //     `/sessions` 를 게이트 앞으로 옮기니 **무인증 200** 인데 이 단언은 초록이었다.
    //  ② 판정이 **role 표 안**만 돌아서, 표 밖 GET(`/egress`·`/chat-history`)을 앞으로
    //     옮기면 안 본다 → **대화 전문이 무인증으로** 나왔는데 초록.
    //  ③ 오프셋 비교가 **디렉터리 이어붙이기** 위에서 돌아 판정이 *파일 이름의 함수*가
    //     됐다 — 같은 코드가 파일명 하나로 빨강↔초록을 오갔다.
    //
    // ★**거짓 초록은 없는 것보다 나쁘다.** 지금 자리에서 지킬 수 있는 성질이 아니라
    //  판단해 뺀다 — 제대로 하려면 소스 라우트 **전수** × **파일 단위** × **주석 제거**가
    //  같이 필요하고, 그건 다음 릴리스에서 설계한다(로드맵).

    // ── ③ ★GET 면제를 떠받치는 전제 ────────────────────────────────────────
    // 이 검사가 GET 을 안 보는 것은 게으름이 아니라 **판단**이다: 표에서 빠지면
    // `required=null` 이고, 게이트는 `required !== null` 일 때만 검사하므로, `read` 가
    // 최하위인 한 「등급 없음 ≡ read」다. 그 성질이 깨지면 면제가 통째로 무효가 된다.
    // ★조건부로 쓴다 — 나중에 fallback 을 fail-closed 로 **개선**하면 이 전제는 필요 없어지고,
    //  그때 이 단언이 개선을 막으면 안 된다.
    const failOpen = /:\s*null;/.test(table) && /if \(required !== null/.test(src);
    const rankBlock = /const ROLE_RANK[\s\S]{0,240}?\};/.exec(src)?.[0] ?? "";
    const ranks = [...rankBlock.matchAll(/(\w+):\s*(\d+)/g)].map(
      (m) => [m[1]!, Number(m[2]!)] as const,
    );
    const lowest = ranks.length === 0 ? null : ranks.reduce((a, b) => (b[1] < a[1] ? b : a));
    out.push(
      assert(
        "★★표에서 빠지면 **검사 없음**(fail-open)이고, 그래서 `read` 가 **최하위 등급**이어야 GET 면제가 성립한다 — `read` 아래 등급이 생기면 등급 없는 GET 전부가 그 아래로 열린다",
        !failOpen || (lowest !== null && lowest[0] === "read"),
        failOpen
          ? `fail-open · 최하위=${lowest === null ? "(ROLE_RANK 를 못 읽음)" : `${lowest[0]}(${String(lowest[1])})`} · 등급=${ranks.map(([n, v]) => `${n}:${String(v)}`).join(" ")}`
          : "fail-closed 로 바뀜 — 이 전제는 더 필요 없다",
      ),
    );

    // 되돌릴 수 없는 둘은 **admin** 이어야 한다 — write 로 내리면 이 단언이 운다.
    // (이름을 여기 적는 이유: 이 둘은 "부작용" 이 아니라 **비가역**이라 등급이 다르다.
    //  판정으로 못 바꾸는 부분이고, 둘뿐이라 드리프트 위험보다 명시의 값이 크다.)
    for (const p of ["/self-update", "/log-clear"]) {
      const re = new RegExp(
        `pathname === "${p}" && method === "POST"[\\s\\S]{0,80}?\\?\\s*"(\\w+)"`,
      );
      const role = re.exec(table)?.[1];
      out.push(
        assert(
          `★${p} 은 admin 이다(비가역 — ${p === "/self-update" ? "코드를 갈아끼운다" : "진단면을 지운다"})`,
          role === "admin",
          `등급=${role ?? "(표에 없음)"}`,
        ),
      );
    }

    // ★프록시가 admin 토큰을 대신 붙인다는 사실을 **적어 둔다** — 이 표의 유효 범위가
    //  "브리지를 직접 때리는 경로" 뿐임을 다음 사람이 알아야 한다(적대 검토 실측).
    const proxy = readFileSync(path.join(REPO, "packages/dashboard/index.ts"), "utf8");
    out.push(
      assert(
        "대시보드 프록시가 브리지 토큰을 붙인다는 사실이 코드에 남아 있다(이 표의 유효 범위 경계)",
        /HTTP_BRIDGE_TOKEN/.test(proxy) && /Authorization: `Bearer \$\{TOKEN\}`/.test(proxy),
        "프록시가 토큰을 주입 — 대시보드 경유는 이 표가 아니라 대시보드 접근권이 경계다",
      ),
    );
    return out;
  },
};
