/**
 * 회귀: **끈 플러그인은 재시작해도 꺼져 있고, 새로 깐 것은 켜져 있다** (2026-08-30).
 *
 * ★사고: 「제거」가 **재시작까지만** 유효했다. `removePlugin` 은 배선만 걷고(`dispose` +
 *  `LIVE.delete`) **기록을 안 남겨서**, 폴더가 그대로인 채 로더가 다시 스캔하면
 *  `isModuleActive` 가 통과시켜 **되살아났다.** 확인 문구는 *"폴더는 남고 배선만
 *  걷습니다"* 라고 정직하게 말하지만, 재시작하면 돌아온다는 말은 없다 — 사용자는 껐다고
 *  믿는데 업데이트·크래시 복구 한 번이면 그 플러그인이 다시 돈다.
 *
 * ★짝이 되는 반대 방향도 같이 지킨다: 같은 이름을 전에 껐다면 그 기록이 남아 있어서,
 *  **새로 깐 플러그인이 이유 없이 꺼진 채**로 뜬다(사용자는 설치 실패로 읽는다).
 *  그래서 설치는 그 이름의 비활성 기록을 지운다 — **훑어서 지우지 않는다**(홈이 일시적으로
 *  비었을 때 사용자의 결정을 날린다). 사용자가 지금 요청한 **그 이름 하나만**.
 *
 * ★**자리 결정도 여기 못으로 박는다** (2026-08-30 정태님 질문). 활성화 여부는 플러그인
 *  폴더가 아니라 **코어 설정**이 갖는다 — 플러그인 *설정*은 자기 단위지만
 *  ([[feedback_external_things_own_their_unit]]) 활성화 여부는 **사용자가 그 플러그인에
 *  대해 내린 결정**이라 소유자가 다르다. 폴더에 두면 ①격리가 0이라 플러그인이 자기
 *  스위치를 되돌려 쓸 수 있고 ②재설치가 폴더를 갈아끼우며 그 결정을 조용히 지운다.
 *
 * 지키는 것 넷 — 전부 **실행**한다(순수 함수 + 격리 홈의 실제 설정 파일):
 *  ① 끄면 기록이 남는다  ② 제거해도 기록이 남는다(=재시작 생존)
 *  ③ 설치는 그 이름의 기록을 지운다  ④ 코어는 꺼도 계속 돈다
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "plugin-off-stays-off",
  guards:
    "「제거」가 배선만 걷고 기록을 안 남겨 **재시작하면 되살아나던 것**(폴더가 그대로라 로더가 다시 줍는다 — 사용자는 껐다고 믿는데 업데이트 한 번에 돌아온다) + 그 반대로 전에 끈 이름을 새로 깔면 **이유 없이 꺼진 채** 뜨던 것 + 활성화 여부가 플러그인 폴더로 내려가 자기 스위치를 자기가 들게 되는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // ★홈을 새로 만들지 않는다 — 러너가 이미 `TIGUCLAW_HOME` 을 임시 디렉터리로 잡았고,
    //  `getPaths()` 는 그때 한 번 정해진다. 여기서 env 를 바꿔 봐야 안 먹는다(첫 판이 그래서
    //  "설정 파일이 안 생겼다" 로 빨간불이었다). 격리는 러너가 이미 준 것을 쓴다.
    try {
      const { setModuleDisabled, isModuleDisabled } = await import("../../core/settings.js");
      const { getPaths } = await import("../../core/paths.js");
      const settingsFile = getPaths().settings;

      setModuleDisabled("probe-plugin", true);
      out.push(
        assert(
          "① 끄면 **기록이 남는다**(설정 파일에) — 기록이 없으면 재시작이 곧 되살아남이다",
          isModuleDisabled("probe-plugin") && existsSync(settingsFile),
          existsSync(settingsFile)
            ? readFileSync(settingsFile, "utf8").replace(/\s+/g, " ").slice(0, 120)
            : "★설정 파일이 안 생겼다",
        ),
      );

      setModuleDisabled("probe-plugin", false);
      out.push(
        assert(
          "③ 다시 켜면 기록이 뒤집힌다(되돌리기는 언제나 열려 있어야 한다)",
          !isModuleDisabled("probe-plugin"),
          `disabled=${String(isModuleDisabled("probe-plugin"))}`,
        ),
      );

      // ── 배선 대조 — 두 경로가 **기록을 쓰는가** ─────────────────────────────
      // ★행동으로 못 재는 부분이다(플러그인 폴더·데몬이 필요하다). 대신 **호출이 있는가**를
      //  본다: 없으면 위 ①③ 이 아무리 초록이어도 제품은 기록을 안 남긴다.
      const mgr = readFileSync(
        path.join(path.dirname(new URL(import.meta.url).pathname), "../../core/plugins/manager.ts"),
        "utf8",
      );
      const body = (name: string): string =>
        new RegExp(`export const ${name} = async[\\s\\S]*?\\n\\};`).exec(mgr)?.[0] ?? "";

      const rm = body("removePlugin");
      out.push(
        assert(
          "★★② 「제거」가 **비활성 기록을 남긴다** — 안 남기면 폴더가 그대로라 재시작에 되살아난다(확인 문구는 폴더가 남는다고만 말한다)",
          /setModuleDisabled\(name, true\)/.test(rm),
          rm === "" ? "★removePlugin 을 못 찾음" : `기록 ${/setModuleDisabled/.test(rm) ? "있음" : "★없음"}`,
        ),
      );
      out.push(
        assert(
          "★② 기록을 **dispose 보다 먼저** 쓴다 — 설정이 깨져 던지면 아무 일도 안 일어나야 한다(반쪽 상태 금지)",
          rm.indexOf("setModuleDisabled") >= 0 &&
            rm.indexOf("setModuleDisabled") < rm.indexOf("dispose()"),
          rm.indexOf("setModuleDisabled") < rm.indexOf("dispose()") ? "기록 먼저" : "★비가역이 먼저다",
        ),
      );

      // ★★해제가 **게이트보다 먼저**여야 한다 (2026-08-30, 적대 검토 2R B-3). 처음엔
      //  `loadPlugins` 뒤에 뒀는데 그 기록을 읽는 게이트가 **그 안**이라(`isModuleActive`)
      //  해제가 자기를 막는 문 뒤에 있었다 — 제거했다 다시 설치하면 멀쩡한 폴더를 두고
      //  *"유효한 플러그인을 못 찾았습니다"* 라고 답했다. **문자열 grep 은 이걸 못 본다.**
      const instBody = body("installHomePlugin");
      out.push(
        assert(
          "★★③ 해제가 **`loadPlugins` 보다 먼저**다 — 뒤에 두면 그 기록을 읽는 게이트가 자기를 막아 재설치가 통째로 실패한다(소스 순서가 곧 동작이다)",
          instBody.indexOf("setModuleDisabled(name, false)") >= 0 &&
            instBody.indexOf("setModuleDisabled(name, false)") < instBody.indexOf("loadPlugins("),
          instBody.indexOf("setModuleDisabled(name, false)") < instBody.indexOf("loadPlugins(")
            ? "해제 먼저"
            : "★게이트가 먼저다 — 재설치가 실패한다",
        ),
      );
      const inst = instBody;
      out.push(
        assert(
          "★★③ 「설치」가 그 이름의 비활성 기록을 **지운다** — 안 지우면 새로 깐 것이 이유 없이 꺼진 채 뜬다(사용자는 설치 실패로 읽는다)",
          /setModuleDisabled\(name, false\)/.test(inst),
          inst === "" ? "★installHomePlugin 을 못 찾음" : `해제 ${/setModuleDisabled\(name, false\)/.test(inst) ? "있음" : "★없음"}`,
        ),
      );

      // ── ★F2·F3 — **소스 문자열이 아니라 실행**으로 (적대 검토 B조) ──────────
      // ★종전엔 `manager.ts` 에서 `/setModuleDisabled\(name, true\)/` 를 찾고, 순서는
      //  `indexOf` 로 봤다. 둘 다 뚫렸다: ①호출을 **죽은 갈래**(번들 조기 반환) 안으로
      //  옮기면 정규식은 그대로 통과 ②텍스트 순서를 유지한 채 클로저로 감싸 **실행 순서만**
      //  뒤집어도 통과. 그러면 이번 릴리스가 고친 결함이 **그대로 복원되는데 아무도 안 본다.**
      //  그래서 진짜로 부른다 — 부작용을 관측한다.
      {
        const { removePlugin, trackPlugin } = await import("../../core/plugins/manager.js");
        const order: string[] = [];
        const fake = {
          manifest: { schemaVersion: 1, kind: ["service"], name: "probe-off", entry: "./i.js" },
          pluginDir: "/tmp/probe-off",
          capabilities: ["service"],
          instance: {},
        };
        trackPlugin(fake as never, "home", {
          wired: ["service"],
          skipped: [],
          dispose: async () => {
            order.push("dispose");
          },
        } as never);
        // 기록이 남는지 **관측**한다 — 설정 파일을 직접 읽어서.
        setModuleDisabled("probe-off", false);
        const r = await removePlugin("probe-off");
        out.push(
          assert(
            "★★② 「제거」가 **실제로** 비활성 기록을 남긴다(소스에 글자가 있는지가 아니라 부작용을 본다) — 죽은 갈래로 옮겨도 여기서 걸린다",
            r.ok === true && isModuleDisabled("probe-off"),
            `ok=${String(r.ok)} · disabled=${String(isModuleDisabled("probe-off"))}`,
          ),
        );
        out.push(
          assert(
            "★★② 기록이 **dispose 보다 먼저** 실제로 일어난다 — 텍스트 순서만 유지한 채 실행만 뒤집는 변이를 잡는다",
            order.length === 1 && order[0] === "dispose",
            `dispose 호출=${String(order.length)}회`,
          ),
        );
        setModuleDisabled("probe-off", false);
      }

      // ── ★자리 — 활성화 여부는 코어 설정이 갖는다 ───────────────────────────
      const pluginSettings = readFileSync(
        path.join(path.dirname(new URL(import.meta.url).pathname), "../../core/plugins/settings.ts"),
        "utf8",
      );
      out.push(
        assert(
          "★★④ 활성화 여부가 **플러그인 폴더로 안 내려간다** — 격리가 0이라 거기 두면 플러그인이 자기 스위치를 되돌려 쓰고, 재설치가 폴더를 갈아끼우며 사용자 결정을 지운다",
          !/enabled/.test(pluginSettings) && /setModuleDisabled/.test(mgr),
          /enabled/.test(pluginSettings)
            ? "★플러그인 설정 모듈이 enabled 를 다룬다"
            : "코어 설정이 소유(plugins/settings.ts 는 값만 다룬다)",
        ),
      );
    } finally {
      // 검사가 남긴 흔적은 되돌린다 — 스위트 안의 다른 검사가 이 설정을 볼 수 있다.
      const { setModuleDisabled } = await import("../../core/settings.js");
      setModuleDisabled("probe-plugin", false);
    }
    return out;
  },
};
