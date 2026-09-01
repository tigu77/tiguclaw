/**
 * 회귀: **구독 인증 등록은 플러그인이 한다 — 코어가 아니다** (2026-09-01).
 *
 * ★정태님 확정: Business 판은 구독을 빼고, 꼭 필요하면 기업이 **설치라는 명시적 행위로
 *  책임을 가져간다.** 그게 성립하려면 등록이 플러그인이어야 한다 — 코어가 등록하면
 *  부팅 순서상(코어 → 번들 → 홈) 코어가 **먼저 잡아** 플러그인이 원리적으로 못 가져가고,
 *  «플러그인으로 뺐다» 가 이름뿐이 된다.
 *
 * ★종전 검사(`auth-shims-are-wired`)는 *"코어의 등록 배선에 심이 다 걸렸나"* 를 물었다.
 *  그 배선 파일이 사라졌으므로 **질문 자체가 바뀐 것**이다 — 이름만 바꾸지 않고 새로 썼다.
 *
 * ★**이름을 열거하지 않는다.** 목록은 디스크가 준다 — `plugins/<이름>/package.json` 의
 *  `needs.auth` 선언과, `src/core/` 안의 `registerAuthProvider(` 호출을 센다.
 *
 * 등급: **정적** — 배선의 자리를 본다. 실제로 도는지는 `home-plugin-can-provide-auth` 가
 * 진짜 플러그인을 설치해서 잰다. 둘은 다른 질문이다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 코어에서 등록을 부를 자격이 있는 자리 — 레지스트리 자신과 플러그인 호스트 뿐. */
const ALLOWED = ["llm-runtime/auth-registry.ts", "plugins/host.ts"];

export const check: RegressionCheck = {
  name: "auth-registration-is-a-plugin",
  guards:
    "구독 인증을 코어가 등록해서, 부팅 순서상 코어가 먼저 잡아 플러그인이 그 id 를 원리적으로 가져갈 수 없던 것 — 그러면 «플러그인으로 뺐다» 가 이름뿐이 된다",
  run: async (): Promise<Assertion[]> => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    const strip = (s: string): string =>
      s
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");

    /** `src/core/` 아래에서 등록을 부르는 파일 — 허용된 자리를 뺀 나머지. */
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    const coreFiles = await walk(path.join(root, "src", "core"));
    const callers: string[] = [];
    for (const f of coreFiles) {
      if (!/registerAuthProvider\s*\(/.test(strip(await readFile(f, "utf8")))) continue;
      const rel = path.relative(path.join(root, "src", "core"), f).split(path.sep).join("/");
      if (!ALLOWED.includes(rel)) callers.push(rel);
    }

    /** `needs.auth` 를 선언한 번들 플러그인이 실제로 등록을 부르는가. */
    const declared: string[] = [];
    const silent: string[] = [];
    const pluginsDir = path.join(root, "plugins");
    for (const name of await readdir(pluginsDir)) {
      let pkg: { tiguclaw?: { needs?: { auth?: unknown }; entry?: unknown } };
      try {
        pkg = JSON.parse(await readFile(path.join(pluginsDir, name, "package.json"), "utf8")) as never;
      } catch {
        continue;
      }
      const auth = pkg.tiguclaw?.needs?.auth;
      if (!Array.isArray(auth) || auth.length === 0) continue;
      declared.push(name);
      const entry = typeof pkg.tiguclaw?.entry === "string" ? pkg.tiguclaw.entry : "";
      let body = "";
      try {
        body = await readFile(path.join(pluginsDir, name, entry), "utf8");
      } catch {
        silent.push(`${name}(entry 없음)`);
        continue;
      }
      if (!/registerAuthProvider\s*\(/.test(strip(body))) silent.push(name);
    }

    return [
      assert(
        "★★`src/core/` 안에서 구독 인증을 **직접 등록하지 않는다** — 코어가 먼저 잡으면 플러그인이 그 id 를 못 가져간다(부팅 순서: 코어 → 번들 → 홈)",
        callers.length === 0 && coreFiles.length > 50,
        callers.length === 0
          ? `코어 ${coreFiles.length}개 검사 · 등록 호출 0(허용 자리 ${ALLOWED.join(", ")} 제외)`
          : `★코어가 등록한다: ${callers.join(", ")}`,
      ),
      assert(
        "★★`needs.auth` 를 선언한 플러그인은 **실제로 등록한다** — 선언만 하고 안 부르면 사용자는 «허용했다» 고 읽는데 아무 일도 안 일어난다",
        declared.length > 0 && silent.length === 0,
        silent.length === 0
          ? `선언 ${declared.length}개 전부 등록: ${declared.join(", ")}`
          : `★선언만 하고 안 부름: ${silent.join(", ")}`,
      ),
    ];
  },
};
