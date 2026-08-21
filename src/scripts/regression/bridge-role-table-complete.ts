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
 * ★한계(정직하게): 이건 **소스를 읽는 검사**다. 경로 문자열을 변수로 빼거나 동적으로
 *  조립하면 못 본다. 지키는 것은 "표에 빠졌는가" 한 가지이고, 역할 등급이 **적절한가**
 *  (write 로 족한가 admin 이어야 하나)는 사람이 판단한다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** `pathname === "/x" && method === "POST"` 형태에서 경로를 전부 뽑는다. */
const postPaths = (src: string): Set<string> => {
  const out = new Set<string>();
  const re = /pathname === "([^"]+)"\s*&&\s*method === "POST"/g;
  for (const m of src.matchAll(re)) out.add(m[1]!);
  return out;
};

export const check: RegressionCheck = {
  name: "bridge-role-table-complete",
  guards:
    "새 POST 엔드포인트를 브리지 role 표에 안 적으면 required=null 로 **게이트 없이** 통과하던 것(자가업데이트·로그삭제 포함)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = readFileSync(path.join(REPO, "plugins/http-bridge/index.ts"), "utf8");

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
    const inTable = postPaths(table);
    const everywhere = postPaths(src);
    // 표 밖에서만 등장하는 POST 경로 = 핸들러는 있는데 등급이 없는 것.
    // ★`/v1/*` 는 정당한 예외 — OpenAI 호환 게이트웨이 표면이라 **자기 토큰**(gateway token)
    //  으로 따로 인증한다. 이름을 열거하지 않고 **접두사 규칙**으로 뺀다(새 /v1 엔드포인트가
    //  생겨도 이 검사를 안 고친다). 대신 그 예외가 실제로 인증을 한다는 걸 아래에서 확인한다.
    const ungated = [...everywhere].filter((p) => !inTable.has(p) && !p.startsWith("/v1/"));
    const gatewayPaths = [...everywhere].filter((p) => p.startsWith("/v1/"));
    out.push(
      assert(
        "게이트웨이(/v1/*) 예외는 자기 인증을 갖는다 — 그래서 role 표 밖인 것이 정당하다",
        gatewayPaths.length === 0 || /gateway[\s\S]{0,200}token/i.test(src),
        `게이트웨이 경로 ${gatewayPaths.length}개 · 별도 토큰 인증 확인=${/gateway[\s\S]{0,200}token/i.test(src)}`,
      ),
    );

    out.push(
      assert(
        "★핸들러가 다루는 POST 경로 전부가 role 표에 있다(빠지면 required=null = 게이트 없음)",
        ungated.length === 0,
        ungated.length === 0
          ? `POST ${everywhere.size}개 전부 등급 있음`
          : `★등급 없는 POST: ${ungated.join(", ")}`,
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
