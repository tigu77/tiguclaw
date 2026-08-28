/**
 * 회귀: **플러그인이 안 뜨면 요란하게 안 뜬다** (2026-08-28).
 *
 * ★실제로 겪은 사고다. `weather` 플러그인이 `export default` 를 **객체 리터럴**로 내보내서
 *  로더가 `entry has no default export class` 로 **통째로 건너뛰었다.** 그 결과:
 *   - 도구가 아예 없었고, 모델은 자기 지식으로 답했다(사용자는 "되는 줄" 알았다)
 *   - 데몬 **로그엔 한 줄도 없었다** — 흔적은 DB `events` 행 하나뿐
 *   - 게이트 `verify:plugins` 는 **8/8 초록**이었다(import 만 했으니까)
 *
 * ★세 결함이 겹쳐야 이렇게 조용해진다. 하나씩 막는다:
 *  ① 로드 실패가 **로그에 남는다** — 버스 발행은 대시보드용이고 로그는 진단용이다.
 *     [[feedback_logs_must_stand_alone]]: 원격이 안 되는 기계에선 로그가 유일한 창이다.
 *  ② 게이트가 **인스턴스화까지** 한다 — "로드 OK" 가 "등록 OK" 를 뜻하지 않았다.
 *  ③ dist 미러가 **삭제를 반영한다** — `fs.cp` 는 덮어쓰기만 해서, 지운 플러그인이
 *     빌드본에서 계속 로드됐다(시험용 `_probe` 가 매 부팅 실패로 찍히고 있었다).
 *
 * 등급: **동작 검사** — 임시 트리를 만들어 `loadPlugins` 와 미러 스크립트를 **실제로 돌린다**.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlugins } from "../../core/plugins/loader.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const manifest = (name: string): string =>
  JSON.stringify({
    name,
    private: true,
    type: "module",
    tiguclaw: { schemaVersion: 1, kind: ["observer"], name, entry: "./index.mjs" },
  });

export const check: RegressionCheck = {
  name: "plugin-load-failures-are-loud",
  guards:
    "플러그인이 로드에 실패해도 로그에 한 줄도 안 남아 도구가 통째로 없는 걸 아무도 모르던 것 + 그 게이트가 import 만 해서 8/8 초록이던 것 + dist 미러가 삭제를 반영 안 해 지운 플러그인이 계속 돌던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const root = await mkdtemp(path.join(tmpdir(), "plug-loud-"));
    try {
      // ── ① 로더: 클래스는 뜨고, 객체는 **로그를 남기며** 안 뜬다 ──
      const dir = path.join(root, "plugins");
      await mkdir(path.join(dir, "good"), { recursive: true });
      await mkdir(path.join(dir, "bad"), { recursive: true });
      await writeFile(path.join(dir, "good", "package.json"), manifest("good"));
      await writeFile(
        path.join(dir, "good", "index.mjs"),
        "export default class G { async startObserver() {} }\n",
      );
      await writeFile(path.join(dir, "bad", "package.json"), manifest("bad"));
      await writeFile(path.join(dir, "bad", "index.mjs"), "export default { startObserver() {} };\n");

      const logged: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]): void => {
        logged.push(a.map(String).join(" "));
      };
      let loaded: Array<{ manifest: { name: string } }>;
      const published: unknown[] = [];
      try {
        loaded = (await loadPlugins(dir, {
          publish: (e: unknown) => published.push(e),
        } as never)) as Array<{ manifest: { name: string } }>;
      } finally {
        console.error = orig;
      }
      const names = loaded.map((l) => l.manifest.name).sort();
      const loudLine = logged.find((l) => l.includes("bad") && l.includes("default export class"));

      out.push(
        assert(
          "★클래스를 내보낸 플러그인만 뜬다(객체 리터럴은 로더가 건너뛴다)",
          names.join(",") === "good",
          `뜬 것: ${names.join(",") || "없음"}`,
        ),
        assert(
          "★★실패가 **로그에 남는다**(종전엔 버스에만 발행하고 콘솔엔 아무것도 안 찍어, 로그가 유일한 창인 기계에서 원인을 못 봤다)",
          loudLine !== undefined,
          loudLine ?? `★로그 ${logged.length}줄 — 실패 줄 없음`,
        ),
        assert(
          "★버스 발행도 **그대로 한다**(대시보드가 그걸 본다 — 로그로 옮긴 게 아니라 둘 다다)",
          published.length >= 1,
          `발행 ${published.length}건`,
        ),
      );

      // ── ③ dist 미러가 **삭제를 반영한다** — 스크립트를 실제로 돌린다 ──
      const fakeDist = path.join(root, "dist");
      await mkdir(path.join(fakeDist, "plugins", "weather"), { recursive: true });
      await mkdir(path.join(fakeDist, "plugins", "_gone"), { recursive: true });
      await writeFile(path.join(fakeDist, "plugins", "_gone", "index.js"), "// 소스엔 없다\n");
      spawnSync("node", [path.join(REPO, "bin/copy-dist-assets.mjs"), fakeDist], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 60_000,
      });
      const after = (await readdir(path.join(fakeDist, "plugins"), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      out.push(
        assert(
          "★★미러가 **삭제를 반영한다**(소스에 없는 플러그인이 빌드본에서 사라진다 — 안 그러면 지운 게 계속 돈다)",
          !after.includes("_gone"),
          after.includes("_gone") ? "★고아가 남았다" : `남은 것: ${after.join(",")}`,
        ),
        assert(
          "★살아 있는 플러그인은 **안 건드린다**(트리 통째 prune 이 아니다 — tsc 산출물이 먼저 들어와 있다)",
          // ★**이름을 박지 않는다**(2026-08-29). 종전엔 `weather` 를 찍었는데 그 플러그인은
          //  배포본에 없다(제공자 약관 제외). 지키려는 성질은 *"살아 있는 것이 남는가"* 이지
          //  특정 플러그인이 아니다([[feedback_hand_maintained_lists]]).
          after.filter((n) => n !== "_gone").length >= 2,
          `${after.length}개: ${after.slice(0, 6).join(",")}`,
        ),
      );

      // ── ② 게이트가 인스턴스화까지 하는가 ──
      // ★`src/scripts/verify-*` 는 **배포본에 없다**(manifest EXCLUDE). dev 에서만 돌고,
      //  건너뛰는 사실을 증거란에 남긴다(조용한 면제 금지).
      const gatePath = path.join(REPO, "src/scripts/verify-plugins-load.ts");
      const fsmod = await import("node:fs");
      const gate = fsmod.existsSync(gatePath)
        ? fsmod.readFileSync(gatePath, "utf8")
        : null;
      out.push(
        assert(
          "★★게이트가 **인스턴스화까지** 한다(import 만 하면 `export default class` 위반이 8/8 초록으로 통과한다 — 실제로 그랬다)",
          gate === null ||
            (/new \(mod\.default as new \(\) => unknown\)\(\)/.test(gate) &&
              /typeof mod\.default !== "function"/.test(gate)),
          gate === null
            ? "dev 전용 스크립트 없음(배포본) — 대상 없음"
            : `생성=${/new \(mod\.default/.test(gate)} · 타입확인=${/typeof mod\.default !== "function"/.test(gate)}`,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return out;
  },
};
