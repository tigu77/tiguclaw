/**
 * 회귀: **플러그인 경계가 실제로 선다** — 적대 검토 A 가 실측으로 깬 셋 (2026-08-29).
 *
 * 77개 변이 중 51개가 살아남은 검토였다. 그중 제품에 닿는 셋:
 *
 * **① `needs.tools` 가 정반대로 작동했다.** `toolPolicyFor` 는 `{mode:"allow", names}` 를
 *  만드는데 **그 `names` 를 읽는 코드가 레포에 0곳**이고, 세 어댑터는 `mode === "none"` 한
 *  줄만 보고 그 외엔 **전체 도구**로 안전 degrade 한다. 게다가 `host.ask` 가 깊이를 안
 *  넘겨 `turnKind` 가 `main` 이었다 — 사다리 최상단(`update_self`·`model-settings`)까지.
 *
 *      needs: { llm: true }               → 도구 0개      (의도대로)
 *      needs: { llm: true, tools: [...] } → **전체 도구**  (정반대)
 *
 *  **좁히려고 적은 사람이 가장 넓게 열렸다.** 그리고 설치 화면엔 "모델 호출(도구 Read)"
 *  라고 **거짓 권한**이 찍혔다. → `tools` 키를 뺐다(집행 없는 선언 금지) + `ask` 를
 *  서브에이전트 층으로.
 *
 * **② 끄면 안 멈췄다.** `trigger`·`observer` 는 `stop()` 이 `undo` 에 안 걸려 있었다.
 *  번들 `scheduler`·`file-watch` 가 둘 다 `trigger` 이고 `stop()` 을 구현해 뒀는데 한 번도
 *  안 불렸다 — 대시보드에서 끄면 *"끔"* 이 뜨고 목록에서 사라지는데 **cron 은 계속 발화**
 *  (실측: dispose 전 tick 4 → 후 9).
 *
 * **③ 이름이 좌표를 넘었다.** `name:"dashboard"` 인 플러그인의 `ask` 가 **사용자의 실제
 *  메인 대화**(`dashboard:default`)를 가리켰고, `name:"../../.ssh"` 는 `~/.ssh` 로 나갔다.
 *  ★고침을 **이름 단속이 아니라 좌표 생성**에 뒀다 — 예약어 목록을 만들었더니 그게 번들
 *  플러그인의 실제 이름(`cli`·`dashboard`·`telegram`)이라 전부 로드에 실패했다.
 *
 * 등급: 전부 **동작**(순수 함수 실행 + 진짜 `wirePlugin` 배선).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidPluginName } from "../../core/plugins/loader.js";
import {
  KNOWN_NEED_KEYS,
  describeNeeds,
  pluginThreadKey,
  readNeeds,
  toolPolicyFor,
} from "../../core/plugins/host.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "plugin-boundaries-hold",
  guards:
    "needs.tools 가 도구를 좁히는 대신 전량 열던 것(allow 를 읽는 코드가 0곳 + ask 가 main 턴 = update_self 까지) 그리고 설치 화면에 거짓 권한이 찍히던 것 + trigger·observer 플러그인을 꺼도 stop() 이 안 불려 cron 이 계속 발화하던 것 + 플러그인 이름이 검증 없이 대화 좌표와 파일 경로가 되던 것(dashboard 라는 이름이 사용자 메인 대화를 가리켰다)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 도구는 언제나 0개 ────────────────────────────────────────────────
    out.push(
      assert(
        "★★`ask` 의 도구 정책이 **언제나 `none`** 이다 — `allow` 는 세 어댑터가 아무도 안 읽어서 *전체 도구*로 degrade 한다. 구현 없는 모드를 주면 좁히려는 선언이 정반대로 작동한다",
        toolPolicyFor({ llm: true }).mode === "none" &&
          toolPolicyFor({} as never).mode === "none",
        `llm만=${JSON.stringify(toolPolicyFor({ llm: true }))}`,
      ),
    );
    out.push(
      assert(
        "★★`tools` 는 **권한 키가 아니다** — 집행이 없으면 키도 없다(`KNOWN_NEED_KEYS` 의 하드 규칙). 남겨두면 다음 사람이 다시 `allow` 를 만들고 같은 함정을 판다",
        !KNOWN_NEED_KEYS.has("tools") && readNeeds({ tools: ["Read"] }).problems.length === 1,
        `키 있음=${String(KNOWN_NEED_KEYS.has("tools"))} · 거부 ${String(readNeeds({ tools: ["Read"] }).problems.length)}건`,
      ),
    );
    out.push(
      assert(
        "★★설치 화면의 권한 문장이 **참이다** — 종전엔 `모델 호출(도구 Read)` 이라 찍었는데 실제로는 전체 도구였다(사람이 그걸 보고 설치를 결정한다)",
        describeNeeds(readNeeds({ llm: true }).needs).includes("모델 호출(도구 없음)"),
        describeNeeds(readNeeds({ llm: true }).needs),
      ),
    );

    // ── ③ 좌표가 이름공간을 안 넘는다 ───────────────────────────────────────
    out.push(
      assert(
        "★★플러그인 대화 좌표가 **`plugin:` 접두사**를 갖는다 — 없으면 `dashboard` 라는 이름의 플러그인이 사용자의 실제 메인 대화(`dashboard:default`)에 끼어든다(실측)",
        pluginThreadKey("dashboard") === "plugin:dashboard:default" &&
          pluginThreadKey("worker", "1a9b") === "plugin:worker:1a9b",
        `${pluginThreadKey("dashboard")} · ${pluginThreadKey("worker", "1a9b")}`,
      ),
    );
    const badNames = ["../../.ssh", "a/b", "A", "has space", "with:colon", "", "-lead"];
    const goodNames = ["cli", "dashboard", "telegram", "file-watch", "running-work", "map"];
    const leaked = badNames.filter((n) => isValidPluginName(n));
    const broke = goodNames.filter((n) => !isValidPluginName(n));
    out.push(
      assert(
        "★★이름이 **경로 문자를 못 담는다** — 이 값이 `<home>/plugins/<name>` 이 되므로, 자유로우면 `../../.ssh` 가 홈 밖으로 나간다(실측)",
        leaked.length === 0,
        leaked.length === 0 ? `${String(badNames.length)}종 전부 거부` : `★통과: ${leaked.join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★★**번들 플러그인 이름이 전부 통과한다** — 예약어 목록을 만들었다가 `cli`·`dashboard`·`telegram` 이 실제 이름이라 전부 죽였다(첫 실행에서 잡혔다). 가드를 달면 도달 입력 전수를 봐야 한다",
        broke.length === 0,
        broke.length === 0 ? goodNames.join(", ") : `★거부됨: ${broke.join(", ")}`,
      ),
    );

    // ── ④ 가드가 **이름이 쓰이는 곳**에 걸려 있다 (2R P-1 · 3R G-3) ─────────
    // ★종전엔 `loader.ts` 에 `isValidPluginName(m.name)` 이라는 **글자가 두 번 나오나**를
    //  셌다. 그래서 가드는 두고 `continue` 만 지우거나, 같은 조건을 두 번 쓰는 것만으로도
    //  통과했다(3라운드 실측). 이제 **진짜로 스캔해 본다** — 임시 루트에 나쁜 이름 매니페스트를
    //  두고 `scanPluginManifests` 가 그걸 안 주는지.
    const dir = mkdtempSync(path.join(tmpdir(), "regr-name-"));
    const put = (folder: string, name: string): void => {
      const d = path.join(dir, folder);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({
          name: folder,
          version: "1.0.0",
          tiguclaw: { schemaVersion: 1, kind: "service", name, entry: "index.js" },
        }),
      );
      writeFileSync(path.join(d, "index.js"), "export default class {}");
    };
    put("escape", "../../ESCAPED");
    put("upper", "BadName");
    put("good", "good-one");
    const { scanPluginManifests } = await import("../../core/plugins/loader.js");
    const scanned = (await scanPluginManifests(dir)).map((x) => x.manifest.name).sort();
    rmSync(dir, { recursive: true, force: true });
    out.push(
      assert(
        "★★나쁜 이름은 **스캔 단계에서** 안 나온다 — 대시보드 목록과 설정 쓰기가 이 결과를 그대로 쓴다. 실측으로 `../../ESCAPED` 가 목록에 뜨고 **홈 밖에 settings.json 을 만들었다**",
        scanned.join(",") === "good-one",
        `스캔 결과 [${scanned.join(", ")}] (기대 [good-one])`,
      ),
    );

    return out;
  },
};
