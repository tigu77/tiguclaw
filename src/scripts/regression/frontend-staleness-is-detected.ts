/**
 * 회귀: **새 프런트가 나오면 화면이 스스로 갱신한다** (2026-08-28).
 *
 * ★실사용 신고에서 나왔다: *"위젯이 한 번 나왔어"* — 그 뒤로 안 나왔다. 서버는 정상으로
 *  카드를 붙이고 있었는데, **브라우저가 아침 JS 를 그대로 들고 있었다.**
 *
 * ★뿌리: 새로고침 판정이 `version` 만 봤다. 그런데 **sync 배포는 버전을 안 올린다** —
 *  실측으로 그날 데몬을 **28번** 재시작하는 동안 `0.41.0` 이 한 번도 안 바뀌었고, 그
 *  사이 새로 만든 위젯 호스트(`widget-host.js`)가 사용자 화면엔 **아예 없었다.**
 *  릴리스 때만 버전이 오르므로, 이건 개발 중만의 문제가 아니라 **sync 로 업데이트받는
 *  사용자에게도 그대로 일어난다.**
 *
 * ★고침은 손 번호가 아니라 **내용 지문**이다 — 이 레포가 아이콘에 이미 쓰던 규칙을 JS·CSS
 *  로 넓혔다. 그 주석이 이유를 이미 적어놨다: *"손 번호를 쓰지 않는다: 파일을 고치고 번호를
 *  안 올리면 조용히 안 바뀌고, 그 목록은 반드시 드리프트한다."*
 *
 * 등급: **동작 검사** — 지문 판정을 실제로 부른다(내용이 바뀌면 바뀌고, 같으면 같다).
 * 배선(health 가 싣나·화면이 비교하나)만 소스 대조.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetFingerprintOf } from "../../core/asset-fingerprint.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const b = (s: string): Uint8Array => new TextEncoder().encode(s);

export const check: RegressionCheck = {
  name: "frontend-staleness-is-detected",
  guards:
    "새 프런트를 서빙하는데 브라우저가 옛 JS 를 계속 쓰던 것 — 새로고침 판정이 version 만 봤고 sync 배포는 버전을 안 올린다(28번 재시작하는 동안 사용자 화면엔 새 위젯 호스트가 아예 없었다)",
  run: async (): Promise<Assertion[]> => {
    const one = assetFingerprintOf([b("a"), b("b")]);
    const same = assetFingerprintOf([b("a"), b("b")]);
    const changed = assetFingerprintOf([b("a"), b("b2")]);
    const reordered = assetFingerprintOf([b("b"), b("a")]);
    const empty = assetFingerprintOf([]);

    const dash = readFileSync(path.join(REPO, "packages/dashboard/index.ts"), "utf8");
    const act = readFileSync(path.join(REPO, "packages/dashboard/js/activity.js"), "utf8");

    return [
      assert(
        "★★내용이 같으면 지문도 같다(안 그러면 매 폴링마다 새로고침한다)",
        one === same && one !== "",
        `${one} vs ${same}`,
      ),
      assert(
        "★★내용이 바뀌면 지문도 바뀐다(이게 안 되면 화면이 영영 안 갱신된다)",
        changed !== one,
        `${one} → ${changed}`,
      ),
      assert(
        "★순서가 바뀌어도 다른 것으로 본다(로드 순서가 바뀌면 다른 화면이다)",
        reordered !== one,
        `${one} vs ${reordered}`,
      ),
      assert(
        "★잴 게 없으면 **빈 값**이다(억지 지문을 만들지 않는다 — 호출자가 종전 동작으로 떨어진다)",
        empty === "",
        JSON.stringify(empty),
      ),
      // ── 배선 ──
      assert(
        "★★`/api/health` 가 지문을 싣는다(화면이 판단할 재료가 거기밖에 없다)",
        /assets: assetFingerprint/.test(dash) && /assetFingerprintOf\(/.test(dash),
        `싣는다=${/assets: assetFingerprint/.test(dash)}`,
      ),
      assert(
        "★지문은 **매니페스트에 실린 js 전부 + html + css** 를 잰다(한 파일만 재면 나머지 변경을 놓친다)",
        /"index\.html", "app\.css", \.\.\.\[\.\.\.jsWhitelist\]/.test(dash),
        (dash.match(/assetFingerprintOf\(\s*\[[^\]]*\]/) ?? ["★못 찾음"])[0]
          .replace(/\s+/g, " ")
          .slice(0, 90),
      ),
      assert(
        "★★화면이 **버전과 지문 둘 다** 본다(버전만 보면 sync 배포에서 영영 안 바뀐다)",
        /const verChanged =/.test(act) && /const assetsChanged =/.test(act) &&
          /if \(h && \(verChanged \|\| assetsChanged\)\)/.test(act),
        `버전=${/verChanged/.test(act)} · 지문=${/assetsChanged/.test(act)}`,
      ),
      assert(
        "★첫 연결엔 새로고침하지 않는다(비교 대상이 없다 — 무한 새로고침 방지)",
        /appAssets !== ""/.test(act) && /if \(appVersion === ""\) return;/.test(act),
        `지문 초기가드=${/appAssets !== ""/.test(act)} · 버전 초기가드=${/if \(appVersion === ""\) return;/.test(act)}`,
      ),
    ];
  },
};
