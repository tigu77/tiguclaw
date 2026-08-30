/**
 * 회귀: **파일 열기가 안전 경계 안에서만 일어난다** (2026-08-02).
 *
 * 편집 카드에서 파일을 열 수 있게 하면서 `/open-path` 의 화이트리스트를 "등록 프로젝트
 * **정확일치**" 에서 "**루트 하위**" 로 넓혔다. 넓힌 만큼 세 가지를 닫아야 한다 —
 * 하나라도 빠지면 브라우저 클릭 하나가 임의 실행이 된다.
 *
 *   ①**CSRF** — 대시보드 프록시는 `/api/*` 에 **브리지 토큰을 서버 쪽에서 붙여** 보낸다.
 *     토큰이 브라우저에 노출 안 되는 건 맞지만 프록시가 대신 붙여주므로, 사용자가 방문한
 *     아무 페이지나 `127.0.0.1:<port>/api/open-path` 로 POST 하면 부작용이 그대로 난다.
 *     `Content-Type: text/plain` 이면 프리플라이트도 없다(단순 요청) — 응답을 못 읽을 뿐
 *     **부작용은 이미 났다**. ★실측으로 확인했다: `Origin: https://evil.example` 로 쏘니
 *     그대로 처리됐다(403 은 경로 화이트리스트 덕이지 CSRF 방어가 아니었다).
 *   ②**심링크 탈출** — `resolve` 만으론 `<proj>/link → /etc` 를 못 막는다. `realpath` 로
 *     실제 대상을 푼 뒤 **다시** 루트 하위인지 봐야 한다.
 *   ③**실행** — macOS `open` 은 `.app`·실행권한 파일을 **실행**한다. 소스를 *보려는* 것이
 *     목적이므로 실행권한이 있으면 거부한다.
 */
import { readFileSync } from "node:fs";
import { readSourceSync } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** ★공용 리더 — 디렉터리를 주면 그 아래 `.ts` 를 전부 본다(브리지가 여러 파일이다). */
const read = (rel: string): string => readSourceSync(rel);

export const check: RegressionCheck = {
  name: "open-path-safety",
  guards:
    "대시보드 프록시가 cross-site POST 를 그대로 중계하던 것 + 파일 열기의 심링크 탈출·실행권한 파일",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const proxy = read("packages/dashboard/index.ts");
    const bridge = read("plugins/http-bridge");

    // ★① CSRF — 이름 열거가 아니라 **부작용 있는 메서드 전부**를 막아야 한다.
    const guardBlock =
      /if \(method !== "GET" && method !== "HEAD"\)[\s\S]{0,900}res\.writeHead\(403/.test(proxy);
    out.push(
      assert(
        "★GET·HEAD 외 모든 요청에 same-origin 가드가 걸린다(경로 열거 아님)",
        guardBlock,
        guardBlock ? "메서드 판정 확인" : "★특정 경로만 막거나 가드 없음 — 새 POST 가 샌다",
      ),
    );
    // 가드가 **분기보다 앞**이어야 한다 — 뒤면 앞선 핸들러가 이미 부작용을 낸다.
    const guardAt = proxy.search(/if \(method !== "GET" && method !== "HEAD"\)/);
    const firstRoute = proxy.search(/if \(\(pathname === "\/" \|\| pathname === "\/index\.html"\)/);
    out.push(
      assert(
        "★가드가 첫 라우트 분기보다 먼저 있다(뒤면 이미 늦었다)",
        guardAt > 0 && firstRoute > 0 && guardAt < firstRoute,
        `가드 ${guardAt}자 · 첫 라우트 ${firstRoute}자`,
      ),
    );
    // Sec-Fetch-Site 우선, 없으면 Origin — 둘 다 없으면 브라우저가 아니다(로컬 도구 허용).
    out.push(
      assert(
        "Sec-Fetch-Site 와 Origin 을 모두 본다(한쪽만 보면 우회된다)",
        /sec-fetch-site/.test(proxy) && /headers\["origin"\]/.test(proxy),
        "두 헤더 확인",
      ),
    );

    // ★② 심링크 탈출 — realpath 후 재검사인가.
    const realpathed =
      /nodeFs\.realpathSync\(abs\)/.test(bridge) &&
      /real === r \|\| real\.startsWith\(r \+ nodePath\.sep\)/.test(bridge);
    out.push(
      assert(
        "★realpath 로 푼 뒤 루트 하위인지 다시 본다(심링크 탈출 0)",
        realpathed,
        realpathed ? "realpath + prefix 확인" : "★resolve 만으로 판정 — 링크로 밖을 열 수 있다",
      ),
    );
    // 루트도 realpath 로 — 한쪽만 풀면 비교가 어긋난다.
    out.push(
      assert(
        "루트도 같은 기준(realpath)으로 푼다",
        /return nodeFs\.realpathSync\(r\);/.test(bridge),
        "양쪽 동일 기준",
      ),
    );

    // ★③ 실행 차단 — 실행권한 파일은 열지 않는다.
    out.push(
      assert(
        "★실행 권한이 있는 파일은 거부한다(open 이 .app·스크립트를 실행한다)",
        /st\.isFile\(\) && \(st\.mode & 0o111\) !== 0/.test(bridge),
        /0o111/.test(bridge) ? "실행권한 검사 확인" : "★실행 위험 열림",
      ),
    );
    // 일반 파일·디렉터리만 — 소켓·디바이스 등은 대상이 아니다.
    out.push(
      assert(
        "일반 파일·디렉터리만 연다",
        /!st\.isFile\(\) && !st\.isDirectory\(\)/.test(bridge),
        "타입 제한 확인",
      ),
    );
    // 셸 인젝션 — execFile 배열 인자 유지(shell:true 로 바뀌면 경로가 명령이 된다).
    out.push(
      assert(
        "execFile 배열 인자 유지(no shell)",
        /execFile\(opener, \[match\.path\]/.test(bridge) && !/shell:\s*true/.test(bridge),
        "no shell 확인",
      ),
    );

    // ★④ 프런트 — 열기 버튼이 그 엔드포인트를 쓰고, 실패 사유를 보여주는가.
    const vis = read("packages/dashboard/js/virtualization.js");
    out.push(
      assert(
        "열기 버튼이 /api/open-path 를 호출하고 실패 사유를 표시한다",
        /fetch\("\/api\/open-path"/.test(vis) && /showToast\(\(d && d\.error\)/.test(vis),
        "호출 + 사유 표시 확인",
      ),
    );
    // 경로는 끝까지 보여야 한다 — 잘리면 파일명·줄(정보가 있는 뒤쪽)이 사라진다.
    const css = read("packages/dashboard/app.css");
    out.push(
      assert(
        "★경로가 잘리지 않는다(ellipsis·max-width 제거, 줄바꿈 허용)",
        /\.act-diff-path \{[^}]*white-space:normal/.test(css) &&
          !/\.act-diff-path \{[^}]*text-overflow:ellipsis/.test(css),
        "전체 표시 확인",
      ),
    );
  // ── ★첨부 서빙도 **심링크를 푼다** (2026-08-17, 전체검토 C-L1 실증) ─────────────
  //  사고: `/attachments/` 는 `path.resolve` + 접두 비교만 해서 `..` 는 막았지만
  //  **심링크는 못 막았다**. 첨부 디렉터리 안의 링크 하나로 홈 밖 파일이 **200 으로**
  //  나갔다(실측: `GET /attachments/link.txt` → 홈 밖 내용, 로그 0줄).
  //  ★같은 파일의 `/open-path` 는 이미 realpath 로 풀고 이 검사가 그걸 강제한다 —
  //   두 경로가 같은 파일 안에서 비대칭이었고 하필 **파일 내용을 밖으로 내보내는 쪽**이
  //   약했다. 강한 쪽만 지키는 검사는 반쪽이다.
  {
    const pats: [string, RegExp][] = [
      // 첨부 분기 안에서 realpath 로 풀고,
      // ★**핸들러 함수**를 앵커로 (2026-08-30). 종전엔 라우트 **조건**부터 봤는데, 조건은
      //  `index.ts` 에 남고 본문은 `routes-files.ts` 로 갔다 — 정규식이 파일 경계를 넘어
      //  못 맞았다. 묻고 싶던 건 *"첨부 서빙이 심링크를 푸나"* 이지 *"조건 근처에 그 줄이
      //  있나"* 가 아니다.
      ["realpath 로 푼다", /handleAttachmentServe = async[\s\S]{0,1200}?real = nodeFs\.realpathSync\(abs\)/],
      // **푼 값으로** 경계를 비교하고,
      ["푼 값으로 경계 비교", /real === realDir \|\| real\.startsWith\(realDir \+ path\.sep\)/],
      // **푼 경로로 읽는다**(원래 경로로 읽으면 위 검사가 무의미하다).
      ["푼 경로로 읽는다", /fs\.readFile\(real\)/],
    ];
    const missingAttach = pats.filter(([, re]) => !re.test(bridge)).map(([n]) => n);
    out.push(
      assert(
        "★첨부 서빙이 심링크를 풀고 경계를 다시 검사한다(홈 밖 유출 차단)",
        missingAttach.length === 0,
        missingAttach.length === 0 ? "realpath 배선 3개 확인" : `누락: ${missingAttach.join(", ")}`,
      ),
    );
  }

    return out;
  },
};
