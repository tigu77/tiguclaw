/**
 * 회귀: **홈 플러그인이 구독 인증을 제공할 수 있다** (2026-09-01).
 *
 * ★정태님: *"홈 플러그인에 클로드 구독 어댑터가 들어가도 작동할 수 있냐 이게 중요한거지."*
 *  그게 이 트랙의 전부다. Business 판은 코어의 등록 배선을 빼서 구독 경로를 닫는데, 기업이
 *  **자기 책임으로 되돌리는 길**이 없으면 «빼기» 만 있고 «가져가기» 가 없다.
 *
 * ★왜 홈이어야 하나 — 앱 트리를 고치는 것은 `/update` 가 되살린다(`tsc -p tsconfig.build.json`
 *  이 소스에서 다시 짓는다). 홈은 레포 밖이라 살아남는다.
 *
 * ★왜 **인증만** 오나 — claude 어댑터 자체는 SDK 의존이고 홈 플러그인엔 `node_modules` 가
 *  없다(폴더에 `npm i` 하면 실측 247MB). 인증 판정은 env 문자열을 보는 게 전부라 의존성 0이다.
 *
 * ★지키는 것 셋:
 *  ① 홈 플러그인이 **부팅 시점에** 등록할 수 있다(도구 호출을 기다리지 않는다 — host 가
 *    종전엔 `getMcpServer`·`getTools` 에만 갔다)
 *  ② **선언 없이는 못 한다**(`needs.auth`) — 사용자가 설치 전에 본다
 *  ③ **먼저 잡은 쪽이 갖는다** — 이미 있는 id 는 못 뺏는다
 *
 * 등급: **동작** — 임시 홈에 진짜 플러그인을 만들어 설치하고 레지스트리를 본다.
 * 자식 프로세스로 돈다(`getPaths()` 가 메모이즈라 홈을 갈아끼우려면 프로세스를 갈라야 하고,
 * 그 덕에 이 검사가 스위트 전역 레지스트리를 오염시키지 않는다).
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeInterpreter } from "./_probe-helpers.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const ENTRY = `export default class S {
  async startService(_bus, host) {
    globalThis.__r = host.registerAuthProvider({
      provider: "regr-home-auth",
      getAccessToken: async () => "tok",
      isAuthenticated: () => true,
    });
  }
  async stop() {}
};\n`;

/** 선언 없이 같은 짓을 하는 플러그인 — 거부돼야 한다. */
const ENTRY_NODECL = ENTRY.replace("__r", "__rNo").replace("regr-home-auth", "regr-home-auth2");

const pkg = (name: string, auth?: string[]): string =>
  JSON.stringify({
    name,
    private: true,
    type: "module",
    tiguclaw: {
      schemaVersion: 1,
      kind: ["service"],
      name,
      entry: "./index.mjs",
      ...(auth === undefined ? {} : { needs: { auth } }),
    },
  });

export const check: RegressionCheck = {
  name: "home-plugin-can-provide-auth",
  guards:
    "구독 인증을 뺄 수는 있는데 기업이 자기 책임으로 되돌릴 길이 없던 것 — 앱 트리는 /update 가 되살리고, 홈 플러그인은 host 에 등록 문이 없어 코어에 닿을 수가 없었다",
  run: async (): Promise<Assertion[]> => {
    const home = await mkdtemp(path.join(tmpdir(), "home-auth-"));
    try {
      const mk = async (name: string, body: string, auth?: string[]): Promise<void> => {
        const dir = path.join(home, "plugins", name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "package.json"), pkg(name, auth));
        await writeFile(path.join(dir, "index.mjs"), body);
      };
      await mk("subauth", ENTRY, ["regr-home-auth"]);
      await mk("subauth-nodecl", ENTRY_NODECL);

      const probe = `void (async () => {
      const m = await import(${JSON.stringify(path.join(REPO, "src/core/plugins/manager.ts"))});
      const auth = await import(${JSON.stringify(path.join(REPO, "src/core/llm-runtime/auth-registry.ts"))});
      const { getEventBus } = await import(${JSON.stringify(path.join(REPO, "src/core/eventbus.ts"))});
      m.initPluginManager({ bus: getEventBus(), channels: [], serviceStops: [] });
      // 번들 인증 플러그인이 실제로 등록하는지 먼저 본다 — 소스에 호출이 보이는 것만으로는
      // 부족하다(if (false) 로 감싼 변이가 정적 검사를 통과했다). 부팅이 하는 일을 돌린다.
      // ★이 주석에 백틱을 쓰면 안 된다 — 여기는 템플릿 리터럴 안이고, 백틱이 문자열을 끊는다.
      const { loadPlugins } = await import(${JSON.stringify(path.join(REPO, "src/core/plugins/loader.ts"))});
      const { wirePlugin } = await import(${JSON.stringify(path.join(REPO, "src/core/plugins/wire.ts"))});
      const { appRoot } = await import(${JSON.stringify(path.join(REPO, "src/core/paths.ts"))});
      const nodePath = await import("node:path");
      // ★needs.auth 를 선언한 것만 배선한다. 전부 배선하면 http-bridge 가 포트를 잡고
      //  대시보드·텔레그램 폴링까지 떠서, 검사가 120초를 먹고 **라이브 데몬 포트와 충돌**한다
      //  (첫 판이 실제로 그랬다). 여기서 묻는 것은 «인증 플러그인이 등록하는가» 하나다.
      const all = await loadPlugins(nodePath.join(appRoot(), "plugins"), getEventBus());
      const bundled = all.filter((lp) => Array.isArray(lp.manifest.needs && lp.manifest.needs.auth));
      for (const lp of bundled) {
        await wirePlugin(lp, { bus: getEventBus(), channels: [], serviceStops: [] });
      }
      const bundledAuth = {
        claude: auth.getAuthProvider("claude-subscription") !== undefined,
        codex: auth.getAuthProvider("codex") !== undefined,
      };
      const before = auth.getAuthProvider("regr-home-auth") !== undefined;
      const inst = await m.installHomePlugin("subauth");
      const got = auth.getAuthProvider("regr-home-auth");
      const declined = await m.installHomePlugin("subauth-nodecl");
      const leaked = auth.getAuthProvider("regr-home-auth2") !== undefined;
      // ★이미 잡힌 id 는 못 뺏는다 — 코어가 먼저 잡은 상황을 흉내낸다.
      const squat = globalThis.__r;
      console.log("__J__" + JSON.stringify({
        before,
        installOk: inst.ok,
        registered: got !== undefined,
        authed: got === undefined ? null : (got.isAuthenticated ? got.isAuthenticated() : null),
        needsShown: (inst.needsFacts ?? []).some((f) => f.kind === "auth"),
        bundledAuth,
        wiredCount: bundled.length,
        declinedResult: globalThis.__rNo ?? null,
        leaked,
        squat,
      }));
    })();`;
      const r = spawnSync(probeInterpreter(REPO), ["-e", probe], {
        cwd: REPO,
        env: { ...process.env, TIGUCLAW_HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      const line = `${r.stdout ?? ""}`.split("\n").find((l) => l.startsWith("__J__"));
      if (line === undefined) {
        return [
          assert(
            "★프로브가 실제로 돌았다(0이면 아래는 미검사다)",
            false,
            `★실패 — ${`${r.stderr ?? ""}`.slice(-300)}`,
          ),
        ];
      }
      const j = JSON.parse(line.slice(5)) as {
        before: boolean;
        installOk: boolean;
        registered: boolean;
        authed: boolean | null;
        needsShown: boolean;
        bundledAuth: { claude: boolean; codex: boolean };
        wiredCount: number;
        declinedResult: { ok: boolean; error?: string } | null;
        leaked: boolean;
        squat: { ok: boolean } | null;
      };

      return [
        assert(
          "★★번들 인증 플러그인이 **실제로 등록한다** — 소스에 호출이 보이는 것만으로는 부족하다(`if (false)` 로 감싼 변이가 정적 검사를 통과했다). 부팅이 하는 일을 그대로 돌려서 본다",
          j.bundledAuth.claude && j.bundledAuth.codex,
          `배선 ${j.wiredCount}개 · claude-subscription=${j.bundledAuth.claude} · codex=${j.bundledAuth.codex}`,
        ),
        assert(
          "★★홈 플러그인이 **구독 인증을 등록한다** — 이게 안 되면 «구독을 뺀다» 는 기업이 되돌릴 길 없이 «못 쓴다» 가 된다",
          j.before === false && j.installOk && j.registered && j.authed === true,
          `설치 전=${j.before} · ok=${j.installOk} · 등록=${j.registered} · 판정=${String(j.authed)}`,
        ),
        assert(
          "★★**부팅 시점에** 등록된다 — 도구 호출을 기다리지 않는다(종전엔 host 가 `getMcpServer`·`getTools` 에만 갔다)",
          j.squat?.ok === true,
          `startService 에서 받은 결과=${JSON.stringify(j.squat)}`,
        ),
        assert(
          "★★**선언 없이는 못 한다**(`needs.auth`) — 사용자가 설치 전에 무엇을 허용하는지 본다",
          j.declinedResult?.ok === false && j.leaked === false,
          `거부=${JSON.stringify(j.declinedResult)} · 샜나=${j.leaked}`,
        ),
        assert(
          "★그 선언이 **설치 화면에 뜬다** — 안 보이면 선언의 값이 0이다(격리가 없으므로 값은 보이는 데만 있다)",
          j.needsShown,
          j.needsShown ? "needsFacts 에 auth 포함" : "★설치 결과에 안 보인다",
        ),
      ];
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
};
