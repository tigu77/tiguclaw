/**
 * 회귀: **언어는 파일 하나로 늘어나고, 반만 번역해도 화면이 안 깨진다** (2026-08-25 사용자 요청).
 *
 * 요구 셋:
 *  ① 언어를 **바꿀 수 있다**(`settings.json` 의 `locale`)
 *  ② 언어를 **쉽게 추가**할 수 있다 — `<home>/locales/<lang>.json` 을 놓으면 끝, **코드 변경 0**
 *  ③ **LLM 이 만드는 말은 제외**하고 시스템이 보여주는 것은 전부(UI + 서버 통지)
 *
 * ★②의 전제는 **부분 번역이 안전한 것**이다. 사람이 처음부터 완역할 리 없다 — 몇 줄만 옮겨
 *  보고, 쓰면서 늘린다. 그때 빠진 키가 **빈 문자열**로 나오면 버튼이 사라지고 화면이 깨진다.
 *  그러면 아무도 두 번째 줄을 안 옮긴다. 그래서 폴백이 이 기능의 **핵심**이다:
 *  **사용자 언어 → 기본 언어 → 키 자체.** 빈 문자열은 절대 안 낸다.
 *
 * ★그리고 **목록을 손으로 관리하지 않는다** — 설치된 언어는 `locales/` 의 파일이 곧 목록이다
 *  ([[feedback_hand_maintained_lists]]: 이름 열거를 만들려는 순간 멈추고 판정 기준으로 바꾼다).
 *
 * ★등급: **행동 게이트**. 격리된 홈에 실제로 파일을 놓고 자식 프로세스로 돌린다 —
 *  `getPaths()` 가 첫 호출에 홈을 얼려서 같은 프로세스에선 홈을 못 바꾼다
 *  ([[project_self_observation_sweep]] 의 initStore 함정과 같은 부류).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const pathJoin = path.join;
const readFileText = (rel: string): Promise<string> =>
  readFile(new URL(rel, import.meta.url), "utf8");
import { execFileSync } from "node:child_process";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = new URL("./_i18n-child.ts", import.meta.url).pathname;

const runIn = (home: string, argv: string[] = []): Record<string, unknown> => {
  const out = execFileSync(process.execPath, ["--import", "tsx", CHILD, ...argv], {
    env: { ...process.env, TIGUCLAW_HOME: home },
    encoding: "utf8",
    timeout: 60_000,
  });
  const line = out.split("\n").find((l) => l.startsWith("{"));
  return line === undefined ? {} : (JSON.parse(line) as Record<string, unknown>);
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "i18n-"));
  try {
    mkdirSync(path.join(home, "locales"), { recursive: true });

    // ── ① 기본 상태 — 아무것도 안 놓으면 기본 언어 ──────────────────────────
    writeFileSync(path.join(home, "settings.json"), "{}\n", "utf8");
    const base = runIn(home);
    out.push(
      assert(
        "설정이 없으면 기본 언어(ko)로 돈다",
        base.locale === "ko" && typeof base.send === "string" && base.send !== "",
        `locale=${String(base.locale)} send=${JSON.stringify(base.send)}`,
      ),
    );

    // ── ② 파일 하나로 언어가 는다 — **코드 변경 0** ─────────────────────────
    //  일부러 **반만** 번역한다. 그게 실제 사용자가 하는 일이다.
    writeFileSync(
      path.join(home, "locales", "en.json"),
      JSON.stringify({
        "chat.send": "Send",
        "compact.running": "Summarizing the previous {turns} turns…",
      }) + "\n",
      "utf8",
    );
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "en" }) + "\n", "utf8");
    const en = runIn(home);
    out.push(
      assert(
        "★홈에 `locales/en.json` 을 놓으면 그 언어가 목록에 뜨고 선택된다(코드 변경 0)",
        Array.isArray(en.locales) && (en.locales as string[]).includes("en") && en.locale === "en",
        `목록=${JSON.stringify(en.locales)} 고름=${String(en.locale)}`,
      ),
      assert(
        "번역한 키는 그 언어로 나온다",
        en.send === "Send",
        JSON.stringify(en.send),
      ),
      assert(
        "★**반만 번역해도** 나머지는 기본 언어로 나온다(화면이 안 깨진다)",
        en.settingsLabel === "설정",
        `안 번역한 키 → ${JSON.stringify(en.settingsLabel)} (기대: 기본 언어 문구)`,
      ),
      assert(
        "★어떤 키도 **빈 문자열**을 내지 않는다(빈 버튼은 없는 버튼이다)",
        en.missing !== "" && typeof en.missing === "string",
        `없는 키 → ${JSON.stringify(en.missing)}`,
      ),
      assert(
        "없는 키는 **키 자체**로 나온다(무엇이 빠졌는지 화면에서 보이게)",
        en.missing === "nope.missing.key",
        JSON.stringify(en.missing),
      ),
      assert(
        "값이 끼어드는 문장도 번역된다(`{turns}` 자리표시자)",
        typeof en.interpolated === "string" && (en.interpolated as string).includes("12"),
        JSON.stringify(en.interpolated),
      ),
      assert(
        "★값을 안 주면 자리표시자가 **남는다**(지우면 문장이 조용히 이상해진다)",
        typeof en.missingParam === "string" &&
          (en.missingParam as string).includes("{turns}") &&
          // 빈칸으로 지우면 "previous  turns" 처럼 조용히 이상해진다 — 그 형상도 직접 막는다.
          !/previous\s{2,}turns/.test(en.missingParam as string),
        JSON.stringify(en.missingParam),
      ),
    );

    // ── ③ 설정 오타가 화면을 죽이지 않는다 ──────────────────────────────────
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "xx" }) + "\n", "utf8");
    const bad = runIn(home);
    out.push(
      assert(
        "★설치 안 된 언어를 고르면 조용히 기본으로 떨어진다(오타가 화면을 안 죽인다)",
        bad.locale === "ko" && bad.send !== "" && typeof bad.send === "string",
        `locale=${String(bad.locale)} send=${JSON.stringify(bad.send)}`,
      ),
    );

    // ── ④ 깨진 언어 파일이 데몬을 죽이지 않는다 ─────────────────────────────
    writeFileSync(path.join(home, "locales", "broken.json"), "{ 이건 JSON 이 아니다", "utf8");
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ locale: "broken" }) + "\n",
      "utf8",
    );
    const broken = runIn(home);
    out.push(
      assert(
        "★깨진 언어 파일이 있어도 살아서 기본 언어로 돈다(언어 파일 하나가 데몬을 죽이면 안 된다)",
        broken.send !== "" && typeof broken.send === "string",
        `send=${JSON.stringify(broken.send)} locale=${String(broken.locale)}`,
      ),
    );

    // ── ⑤ 목록은 **파일이 정한다**(손 목록 0) ───────────────────────────────
    writeFileSync(path.join(home, "locales", "ja.json"), JSON.stringify({ "chat.send": "送信" }) + "\n", "utf8");
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "ja" }) + "\n", "utf8");
    const ja = runIn(home);
    out.push(
      assert(
        "★언어를 하나 더 놓으면 그것도 바로 뜬다(이름 목록을 코드에 안 적는다)",
        Array.isArray(ja.locales) &&
          ["ko", "en", "ja"].every((l) => (ja.locales as string[]).includes(l)) &&
          ja.send === "送信",
        `목록=${JSON.stringify(ja.locales)} send=${JSON.stringify(ja.send)}`,
      ),
      // ★목록이 **파일에서만** 오는지 — 코드에 이름을 적으면 파일 없는 언어가 뜬다.
      //  "있는 게 뜨나" 만 보면 손 목록 변이가 그대로 통과한다(실제로 통과했다).
      assert(
        "★파일이 **없는** 언어는 목록에 안 뜬다(손 목록이 아니라 파일이 정한다)",
        Array.isArray(ja.locales) &&
          (ja.locales as string[]).every((l) => ["ko", "en", "ja", "broken"].includes(l)),
        `목록=${JSON.stringify(ja.locales)} — 파일에 없는 이름이 섞였다`,
      ),
    );

    // ── ⑥ 언어를 **바꾸는 경로**(요구 ①) — 쓰고 나서 실제로 반영되는가 ──────────
    //  ★캐시를 안 비우면 "바꿨는데 그대로" 가 된다. 그걸 자식 프로세스 두 번으로 확인한다
    //   (같은 프로세스 안에서 보면 캐시 무효화 여부를 못 가른다).
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "ko" }) + "\n", "utf8");
    const beforeSwitch = runIn(home);
    const switched = runIn(home, ["--set-locale", "en"]);
    const afterSwitch = runIn(home);
    out.push(
      assert(
        "★`setLocale` 로 언어를 바꾸면 그 뒤로 그 언어가 나온다(요구 ①)",
        beforeSwitch.send === "전송" && switched.setLocaleOk === true && afterSwitch.send === "Send",
        `전=${JSON.stringify(beforeSwitch.send)} 쓰기=${String(switched.setLocaleOk)} 후=${JSON.stringify(afterSwitch.send)}`,
      ),
      assert(
        "★바꾼 **직후 같은 프로세스**에서도 새 언어가 나온다",
        switched.afterSetInSameProcess === "Send",
        `직후=${JSON.stringify(switched.afterSetInSameProcess)} (기대: 새 언어)`,
      ),
      // ★캐시가 실제로 지키는 것은 **파일 편집**이다(언어 전환 땐 새 언어가 캐시에 없어
      //  애초에 문제가 안 된다 — 첫 판에 그걸 잘못 짚어 변이가 통과했다).
      assert(
        "★언어 파일을 고치면 **재시작 없이** 반영된다(데이터는 매 턴 fresh)",
        runIn(home, ["--edit-catalog", "en", "Ship it"]).afterFileEdit === "Ship it",
        `편집 후=${JSON.stringify(runIn(home, ["--edit-catalog", "en", "Ship it"]).afterFileEdit)}`,
      ),
      assert(
        "★설치 안 된 언어로는 **안 바꾼다**(조용히 기본으로 떨어지면 '바꿨는데 왜 그대로지'가 된다)",
        (runIn(home, ["--set-locale", "zz"]).setLocaleOk as boolean) === false,
        "거절 확인",
      ),
    );

    // ── ⑦ 배포·배선 함정 둘 (2026-08-25 실제로 밟았다) ─────────────────────────
    //  등급: 소스/파일 대조. 둘 다 "코드는 맞는데 자산이 안 가거나 경로가 다르게 풀리는"
    //  부류라 실행 검사로는 안 잡히고, 밟으면 화면이 통째로 기본값으로 굳는다.
    {
      const { existsSync: ex } = await import("node:fs");
      const { appRoot } = await import("../../core/paths.js");
      out.push(
        assert(
          "★기본 카탈로그가 **배포 자산**이다(dist 에 실려야 배포본에서 문구가 나온다)",
          ex(pathJoin(appRoot(), "locales", "ko.json")),
          `${pathJoin(appRoot(), "locales", "ko.json")} — 없으면 화면이 키(nav.settings)로 뜬다`,
        ),
      );
      const copyAssets = await readFileText("../../../bin/copy-dist-assets.mjs");
      out.push(
        assert(
          "★`copy-dist-assets` 가 `locales` 를 복사한다(skills·agents 와 같은 자산이다)",
          /copyTree\("locales"\)/.test(copyAssets),
          /copyTree\("locales"\)/.test(copyAssets) ? "복사 확인" : "★빠졌다 — 배포본에 기본 문구가 없다",
        ),
      );
      const dashPlugin = await readFileText("../../../plugins/dashboard/index.ts");
      out.push(
        assert(
          "★대시보드 자식에 홈을 **절대경로로** 넘긴다(자식 cwd 가 dist 라 상대경로는 어긋난다)",
          /childEnv\.TIGUCLAW_HOME = getPaths\(\)\.home/.test(dashPlugin),
          /TIGUCLAW_HOME/.test(dashPlugin)
            ? "절대경로 확인"
            : "★안 넘긴다 — `./tiguclaw-dev` 가 `dist/tiguclaw-dev` 로 풀려 홈을 못 찾는다",
        ),
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return out;
};

export const check: RegressionCheck = {
  name: "i18n-user-extensible",
  guards:
    "화면 언어를 바꿀 수 없고 늘릴 수 없던 것 — 그리고 늘릴 수 있게 만들 때 반쯤 번역한 파일이 빈 문자열로 화면을 깨뜨리는 것(그러면 아무도 두 번째 줄을 안 옮긴다)",
  run,
};
export default check;
