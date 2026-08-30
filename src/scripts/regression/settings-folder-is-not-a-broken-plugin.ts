/**
 * 회귀: **설정·데이터 폴더는 「깨진 플러그인」이 아니다** (2026-08-31).
 *
 * ★사고: 부팅할 때마다 `[error] [plugin-loader] weather load: ENOENT … package.json` 이
 *  찍혔다. `weather` 는 멀쩡했다 — 코어가 **설정을 그 자리에 쓴다.**
 *  `settingsFile`·`dataDir` 가 둘 다 `<home>/plugins/<이름>/` 이라, 설정을 한 번 바꾸기만
 *  해도 그 폴더가 생기고 로더가 그걸 플러그인으로 읽으려다 실패한다.
 *
 * ★같은 질문에 답이 둘이었다 — `scanPluginManifests` 는 `package.json` 부재를
 *  *"플러그인 아님"* 으로 조용히 넘기고, `loadPlugins` 의 바로 다음 가지(`마커 부재`)도
 *  그렇게 넘기는데, **오직 ENOENT 만** `[error]` 였다.
 *
 * ★그런데 **조용히 넘기는 것도 답이 아니다.** `index.js` 만 넣고 `package.json` 을 빠뜨린
 *  설치는 진짜 실수이고 흔적이 있어야 한다. 없앨 것은 **`[error]` 라는 거짓말**이지
 *  신호가 아니다 — 그래서 이 검사는 **양쪽**을 본다(가짜 에러 0 · 흔적은 남음).
 *
 * 등급: **동작** — 실제로 `loadPlugins` 를 돌리고 콘솔·이벤트를 관측한다.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlugins } from "../../core/plugins/loader.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** console.error / console.log 를 같이 걷는다 — 어느 등급으로 찍혔는지가 판정이다. */
const capture = async <T>(fn: () => Promise<T>): Promise<[T, string[], string[]]> => {
  const errs: string[] = [];
  const logs: string[] = [];
  const oe = console.error;
  const ol = console.log;
  console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
  console.log = (...a: unknown[]): void => void logs.push(a.map(String).join(" "));
  try {
    return [await fn(), errs, logs];
  } finally {
    console.error = oe;
    console.log = ol;
  }
};

export const check: RegressionCheck = {
  name: "settings-folder-is-not-a-broken-plugin",
  guards:
    "코어가 설정·데이터를 <home>/plugins/<이름>/ 에 쓰는데 로더가 그 폴더를 플러그인으로 읽으려다 실패해, 멀쩡한 플러그인이 매 부팅 [error] 로 찍히던 것 — 가짜 에러는 로그가 1차 진단면인 곳에서 진짜를 묻는다",
  run: async (): Promise<Assertion[]> => {
    const root = await mkdtemp(path.join(tmpdir(), "tigu-settings-folder-"));

    // ① 코어가 만드는 모양 — 설정만 있는 폴더.
    await mkdir(path.join(root, "weather"), { recursive: true });
    await writeFile(path.join(root, "weather", "settings.json"), '{"units":"c"}');
    // ② 사람이 실수한 모양 — 코드는 있는데 package.json 이 없다.
    await mkdir(path.join(root, "halfbaked"), { recursive: true });
    await writeFile(path.join(root, "halfbaked", "index.js"), "export default class X {}\n");
    // ③ 반대 방향 — 멀쩡한 플러그인은 그대로 뜬다(전부 걸러버리면 그것도 결함이다).
    await mkdir(path.join(root, "real"), { recursive: true });
    await writeFile(
      path.join(root, "real", "package.json"),
      JSON.stringify({
        name: "real",
        type: "module",
        tiguclaw: { schemaVersion: 1, kind: ["service"], name: "real", entry: "./index.mjs" },
      }),
    );
    await writeFile(path.join(root, "real", "index.mjs"), "export default class R {};\n");

    const [loaded, errs, logs] = await capture(() => loadPlugins(root));
    const mentions = (lines: string[], name: string): boolean =>
      lines.some((l) => l.includes(name));

    return [
      assert(
        "★★설정 폴더가 **에러로 안 찍힌다** — `weather` 는 멀쩡한데 매 부팅 `[error] weather load: ENOENT` 가 나왔다. 로그가 1차 진단면인 곳에서 가짜 에러는 진짜를 묻는다",
        !mentions(errs, "weather"),
        errs.length === 0 ? "console.error 0줄" : `★${errs.join(" · ")}`,
      ),
      assert(
        "★★그래도 **흔적은 남는다** — `package.json` 을 빠뜨린 설치는 진짜 실수다. 없앨 것은 `[error]` 라는 거짓말이지 신호가 아니다(조용히 넘기면 반대편으로 뚫린다)",
        mentions(logs, "halfbaked"),
        mentions(logs, "halfbaked") ? "한 줄 남음" : `★흔적 0 — logs=${JSON.stringify(logs)}`,
      ),
      assert(
        "★반대 방향 — **멀쩡한 플러그인은 그대로 뜬다**(전부 걸러버리면 그것도 결함이다)",
        loaded.map((p) => p.manifest.name).includes("real"),
        `로드 ${String(loaded.length)}개: ${loaded.map((p) => p.manifest.name).join(", ") || "(없음)"}`,
      ),
    ];
  },
};
