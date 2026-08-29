/**
 * 회귀: **깨진 설정 파일 위에는 쓰지 않는다** (2026-08-29, 적대 검토 A-F1/F3).
 *
 * 사고의 형상: 쓰기 함수들이 `JSON.parse` 실패를 **삼키고 `{}` 에서 시작**해, 그 `{}` 를
 * 파일에 **원자 교체**로 덮었다. 원자성이 오히려 해로웠다 — 반쪽이 아니라 **완전하게 텅 빈**
 * 파일이 남는다. 실측(격리 홈):
 *
 * ```
 * 전: {"models":{"profiles":{...}},"theme":"dusk",     ← 콤마로 끝나 파싱 불가
 * 후: { "dashboard": { "home": { "widgets": [...] } } }   ← 나머지 전부 소실
 * ```
 *
 * 되돌릴 수 없고(백업이 없으면 끝), 전 사용자에게 열려 있었고, **성공 메시지와 함께**
 * 조용했다. 세 조건이 겹치므로 P5 였다.
 *
 * ★**같은 관용구가 9곳**이었다(코어 7 + 홈 위젯 + 플러그인 설정). 그래서 검사도 호출부를
 *  하나씩 세지 않는다 — **판정을 파는 두 함수**(`readSettingsRootForWrite` / `...Lenient`)를
 *  직접 실행하고, 그 위에 얹힌 실제 쓰기 경로 셋을 **격리 홈에서 돌려** 파일을 확인한다
 *  ([[feedback_hand_maintained_lists]]).
 *
 * ★**읽기가 관대한 것도 성질이다.** 깨진 파일 하나로 화면·조회가 죽으면 사용자는 고칠 수단까지
 *  잃는다. 그래서 "쓰기는 거부, 읽기는 통과" 를 **둘 다** 검사한다 — 한쪽만 보면 다음 사람이
 *  "일관성" 이라며 읽기까지 던지게 만든다.
 *
 * 등급: 전부 **동작** — 임시 홈에 진짜 파일을 두고 진짜 함수를 돌려 바이트를 확인한다.
 */
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeHomeWidgets, readHomeWidgets } from "../../core/home-widgets.js";
import { __resetPathsCache } from "../../core/paths.js";
import {
  SettingsFileCorruptError,
  readSettingsRootForWrite,
  readSettingsRootLenient,
} from "../../core/settings-file.js";
import { effectiveSettings, writePluginSetting } from "../../core/plugins/settings.js";
import { getPaths } from "../../core/paths.js";
import { setDefaultProfile, setEgressChannels } from "../../core/settings.js";
import { writeSettingsRootAtomic } from "../../core/settings-file.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 한 번의 격리 홈 안에서 무언가를 돌린다. `TIGUCLAW_HOME` 은 반드시 되돌린다. */
const inHome = <T,>(settingsText: string | undefined, fn: (file: string) => T): T => {
  const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-settings-"));
  const before = process.env.TIGUCLAW_HOME;
  process.env.TIGUCLAW_HOME = dir;
  __resetPathsCache();
  const file = path.join(dir, "settings.json");
  if (settingsText !== undefined) writeFileSync(file, settingsText, "utf8");
  try {
    return fn(file);
  } finally {
    if (before === undefined) delete process.env.TIGUCLAW_HOME;
    else process.env.TIGUCLAW_HOME = before;
    __resetPathsCache();
    rmSync(dir, { recursive: true, force: true });
  }
};

/** 사용자가 손으로 고치다 만 실제 모양 — 끝 콤마. */
const BROKEN = '{"models":{"default":"high","profiles":{"high":{"pool":[]}}},"theme":"dusk",\n';
const GOOD = '{"models":{"default":"high"},"theme":"dusk"}\n';

export const check: RegressionCheck = {
  name: "settings-write-refuses-corrupt",
  guards:
    "깨진 settings.json 위에 쓰기가 성공해 모델 프로파일·테마·gateway 가 통째로 사라지던 것(원자 교체라 완전하게 텅 빈 파일이 남았다) + 그걸 고치다 읽기까지 던지게 만들어 사용자가 고칠 수단을 잃는 것 + 파일이 아예 없을 때 첫 설치가 못 쓰게 되는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 판정 두 함수 (순수 실행) ─────────────────────────────────────────
    const cases: Array<[string, string]> = [
      ["끝 콤마(손으로 고치다 만 것)", BROKEN],
      ["최상위가 배열", "[1,2,3]\n"],
      ["최상위가 스칼라", '"dusk"\n'],
      ["쓰레기", "not json at all\n"],
    ];
    const escaped: string[] = [];
    for (const [label, text] of cases) {
      const threw = inHome(text, (file) => {
        try {
          readSettingsRootForWrite(file);
          return false;
        } catch (e) {
          return e instanceof SettingsFileCorruptError;
        }
      });
      if (!threw) escaped.push(label);
    }
    out.push(
      assert(
        `★★쓰기 전 읽기는 깨진 파일 ${String(cases.length)}종에 **전부 던진다** — 여기서 \`{}\` 를 돌려주면 호출부가 그걸 덮고, 그 순간 사용자의 다른 설정이 사라진다`,
        escaped.length === 0,
        escaped.length === 0 ? `${String(cases.length)}종 전부 거부` : `★통과시킴: ${escaped.join(", ")}`,
      ),
    );
    const lenient = inHome(BROKEN, (file) => JSON.stringify(readSettingsRootLenient(file)));
    out.push(
      assert(
        "★★같은 파일을 **읽기**로는 통과시킨다(빈 설정) — 깨진 파일 하나로 화면·조회가 죽으면 사용자는 고칠 수단까지 잃는다. 쓰기만 막는 게 요점이다",
        lenient === "{}",
        `관대한 읽기 → ${lenient}`,
      ),
    );
    const fresh = inHome(undefined, (file) => {
      const absent = JSON.stringify(readSettingsRootForWrite(file));
      writeFileSync(file, "", "utf8");
      return `부재→${absent} · 빈파일→${JSON.stringify(readSettingsRootForWrite(file))}`;
    });
    out.push(
      assert(
        "★**없다**와 **비었다**는 깨진 게 아니다 — `{}` 로 정상 진행한다(첫 설치가 이 경로다. 여기서 던지면 새 사용자가 아무것도 못 쓴다)",
        fresh === "부재→{} · 빈파일→{}",
        fresh,
      ),
    );

    // ── ② 실제 쓰기 경로 — 파일 바이트로 확인 ───────────────────────────────
    // ★셋을 고른 이유: 서로 **다른 모듈**이다(home-widgets / settings.ts 의 두 갈래).
    //  한 곳만 보면 다음에 추가되는 쓰기 함수가 옛 관용구로 돌아가도 안 보인다.
    const PLUGIN = "regr-settings-probe";
    /** 이 writer 가 실제로 건드리는 파일. 플러그인 설정은 홈 루트가 아니다. */
    const targetOf = (label: string, home: string): string =>
      label === "writePluginSetting"
        ? path.join(home, "plugins", PLUGIN, "settings.json")
        : path.join(home, "settings.json");
    const writers: Array<[string, () => void]> = [
      ["writeHomeWidgets", () => {
        writeHomeWidgets([{ id: "w", type: "weather/forecast", size: "small", config: {} }]);
      }],
      ["setDefaultProfile", () => { setDefaultProfile("low"); }],
      ["setEgressChannels", () => { setEgressChannels(["telegram"]); }],
      // ★**플러그인 설정 모듈**(2026-08-29, 적대 검토 G-1). 처음엔 이 셋에서 빠져 있었는데,
      //  A-F3 로 "고쳤다" 고 선언한 자리가 바로 여기였다 — 수정을 되돌려도 스위트가 초록이었다.
      //  ★파일이 다르다(`<home>/plugins/<name>/settings.json`)므로 아래 루프가 그 경로를 쓴다.
      ["writePluginSetting", () => {
        const r = writePluginSetting(
          PLUGIN,
          [{ key: "units", type: "string", labelKey: "units" }],
          "units",
          "metric",
        );
        if (!r.ok) throw new Error(r.error ?? "쓰기 거부");
      }],
    ];
    const overwrote: string[] = [];
    const lostOnGood: string[] = [];
    for (const [label, write] of writers) {
      // 깨진 파일 → 거부 + 파일이 **한 바이트도** 안 바뀐다.
      const survived = inHome(undefined, (root) => {
        const file = targetOf(label, path.dirname(root));
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, BROKEN, "utf8");
        try {
          write();
          return false; // 던지지 않았다 = 덮었다
        } catch {
          return readFileSync(file, "utf8") === BROKEN;
        }
      });
      if (!survived) overwrote.push(label);
      // 멀쩡한 파일 → 정상적으로 쓰고, **다른 키는 그대로**.
      const kept = inHome(undefined, (root) => {
        const file = targetOf(label, path.dirname(root));
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, GOOD, "utf8");
        write();
        const obj = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        return obj.theme === "dusk";
      });
      if (!kept) lostOnGood.push(label);
    }
    out.push(
      assert(
        `★★쓰기 경로 ${String(writers.length)}종이 깨진 파일 위에서 **멈추고, 파일을 건드리지 않는다** — 실측으로 \`models\`·\`theme\` 가 통째로 사라졌던 자리다(원자 교체라 반쪽이 아니라 완전하게 텅 빈 파일이 남는다)`,
        overwrote.length === 0,
        overwrote.length === 0 ? `${String(writers.length)}종 전부 거부·원본 보존` : `★덮어씀: ${overwrote.join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★정상 파일에서는 평소대로 쓰고 **다른 키를 안 지운다** — 거부만 하고 쓰기가 죽으면 그건 고친 게 아니다",
        lostOnGood.length === 0,
        lostOnGood.length === 0 ? "3종 전부 theme 보존" : `★다른 키 소실: ${lostOnGood.join(", ")}`,
      ),
    );

    // ── ③ 사유가 사람에게 닿는다 ───────────────────────────────────────────
    const msg = inHome(BROKEN, () => {
      try {
        writeHomeWidgets([]);
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    out.push(
      assert(
        "★던지는 사유에 **파일 경로와 무엇이 위험한지**가 들어 있다 — `Unexpected token` 만 나가면 사용자는 무엇을 고쳐야 하는지 모른다([[feedback_logs_must_stand_alone]])",
        msg.includes("settings.json") && msg.includes("사라집니다"),
        msg.split("\n")[0] ?? "(없음)",
      ),
    );
    // 읽기 경로는 여전히 산다 — 위 ①과 짝. 여기선 **홈 위젯 읽기**로 확인한다(실사용 경로).
    const readBack = inHome(BROKEN, () => {
      const r = readHomeWidgets(new Set(["weather"]));
      return `위젯 ${String(r.widgets.length)}개 · 떨어뜨림 ${String(r.rejected.length)}건`;
    });
    out.push(
      assert(
        "깨진 파일에서도 홈 배치 **읽기**는 빈 목록으로 산다(화면이 안 죽는다)",
        readBack === "위젯 0개 · 떨어뜨림 0건",
        readBack,
      ),
    );

    // ── ③b 플러그인 설정 **읽기**는 깨져도 산다 (2026-08-29, 적대 검토 G-1) ──────
    // ★쓰기를 엄격하게 만들면서 읽기까지 같이 조이고 싶어진다("일관성"). 그런데 이 읽기는
    //  **부팅 배선**(`wire.ts` → `createPluginHost`)과 데이터 라우트가 탄다 — 여기서 던지면
    //  깨진 플러그인 설정 하나가 **데몬을 못 뜨게** 한다. 폭발 반경은 그 플러그인까지다.
    const pluginRead = inHome(undefined, (root) => {
      const f = path.join(path.dirname(root), "plugins", PLUGIN, "settings.json");
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, BROKEN, "utf8");
      try {
        const eff = effectiveSettings(PLUGIN, [
          { key: "units", type: "string", default: "metric" },
        ]);
        return `기본값으로 삶: units=${String(eff.units)}`;
      } catch (e) {
        return `★던짐: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      }
    });
    out.push(
      assert(
        "★★깨진 **플러그인** 설정은 그 플러그인만 기본값으로 떨어뜨린다 — 여기서 던지면 부팅 배선이 타는 경로라 플러그인 하나가 데몬을 못 뜨게 한다(쓰기만 엄격해야 하는 이유)",
        pluginRead === "기본값으로 삶: units=metric",
        pluginRead,
      ),
    );

    // ── ④ 원자 교체 (2026-08-29, 적대 검토 G-3) ─────────────────────────────
    // ★이 축은 **한 번 사라졌었다.** 종전엔 `egress` 회귀가 소스에서 `renameSync(tmp, file)`
    //  라는 글자를 봤는데, 그 검사를 실행형으로 옮기면서 "원자적인가" 를 같이 안 옮겼다.
    //  글자로 돌아가지 않고 **성질로** 본다: `rename` 은 파일을 **갈아끼우므로 inode 가
    //  바뀌고**, 제자리 쓰기는 inode 가 그대로다. 이러면 구현을 바꿔도 성질만 지키면 산다.
    const atomic = inHome(GOOD, (file) => {
      const before = statSync(file).ino;
      writeSettingsRootAtomic(file, { theme: "dusk", extra: 1 });
      const after = statSync(file).ino;
      const residue = readFileSync(file, "utf8").includes("extra");
      return `inode ${before === after ? "그대로(제자리 쓰기)" : "바뀜(갈아끼움)"} · 내용반영=${String(residue)}`;
    });
    out.push(
      assert(
        "★★설정 쓰기는 **갈아끼운다**(임시 파일 + rename) — 제자리로 쓰면 도중에 죽었을 때 반쪽 JSON 이 남고, 그 파일은 다음 부팅에서 '깨졌다' 로 읽힌다",
        atomic.startsWith("inode 바뀜") && atomic.endsWith("내용반영=true"),
        atomic,
      ),
    );
    const leftover = inHome(GOOD, (file) => {
      writeSettingsRootAtomic(file, { theme: "dusk" });
      return readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-"));
    });
    out.push(
      assert(
        "임시 파일이 남지 않는다 — 남으면 홈이 조용히 불어난다",
        leftover.length === 0,
        leftover.length === 0 ? "잔재 0" : `★남음: ${leftover.join(", ")}`,
      ),
    );

    // ── ⑤ 읽기 자체가 실패하는 갈래 (2026-08-29, 적대 검토 G-4) ──────────────
    // ★`existsSync` 는 통과인데 `readFileSync` 가 던지는 경우(권한 없음·디렉터리). 이걸
    //  삼키면 **읽을 수 없는 파일을 빈 파일로 덮는다** — 이번에 고친 사고와 결과가 같다.
    //  파싱 실패 표본만으론 이 갈래를 한 번도 안 밟는다.
    const unreadable = inHome(GOOD, (file) => {
      chmodSync(file, 0o000);
      try {
        readSettingsRootForWrite(file);
        return "★읽었다(삼킴)";
      } catch (e) {
        return e instanceof SettingsFileCorruptError ? "거부" : `다른 예외: ${String(e)}`;
      } finally {
        chmodSync(file, 0o600);
      }
    });
    out.push(
      assert(
        "★★파일을 **열 수 없을 때도** 쓰기를 거부한다(권한 없음) — 파싱 실패만 막으면, 못 읽는 파일을 빈 파일로 덮는 같은 사고가 다른 문으로 들어온다",
        unreadable === "거부",
        unreadable,
      ),
    );

    return out;
  },
};
