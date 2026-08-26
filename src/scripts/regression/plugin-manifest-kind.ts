/**
 * 회귀: **`kind` 의 사전은 하나이고, 모르는 값은 조용히 버려지지 않는다** (2026-08-26).
 *
 * ★깨져 있던 것 둘:
 *
 *  ① **한 필드에 사전이 둘이었다.** 로더는 `channel·observer·trigger·service` 넷을 알고,
 *     `core/plugins/providers.ts` 만 `provider` 를 안다(모듈 카드용). 그래서
 *     `kind:["provider"]` 만 적은 플러그인은 **카드는 뜨는데 로더엔 안 뜨는** 반쪽 상태가
 *     됐다 — 실제로 `self-growth` 가 `["observer","provider"]` 인데, 그중 `provider` 는
 *     로더 눈엔 **없는 값**이었다(observer 덕에 우연히 로드됐을 뿐이다).
 *  ② **모르는 값에 로그가 0이었다.** 오타 `kind:["chanel"]` 은 플러그인을 통째로
 *     사라지게 하고도 아무 흔적을 안 남기고, `["observer","chanel"]` 은 절반만 무시된 채
 *     떴다. 둘 다 무음이라 "왜 안 뜨는지 아무도 모르는" 부류가 된다.
 *
 * 그리고 **문자열 `kind` 하위호환**을 함께 못박는다 — 우리 레포는 배열로 통일했지만
 * schemaVersion 1 계약이라 남의 플러그인이 문자열로 돌고 있다. 입력은 계속 받아야 한다.
 *
 * 등급: **동작 검사** — 임시 디렉터리에 진짜 매니페스트를 쓰고 `loadPlugins` 를 부른다.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins } from "../../core/plugins/loader.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const ENTRY = `export default class P {
  async start(): Promise<void> {}
}
`;

/** 임시 plugins/ 루트에 매니페스트 하나짜리 플러그인을 만든다. */
const writePlugin = async (
  root: string,
  dir: string,
  kind: unknown,
): Promise<void> => {
  const pdir = path.join(root, dir);
  await fs.mkdir(pdir, { recursive: true });
  await fs.writeFile(path.join(pdir, "index.ts"), ENTRY, "utf8");
  await fs.writeFile(
    path.join(pdir, "package.json"),
    JSON.stringify({
      name: dir,
      private: true,
      type: "module",
      tiguclaw: { schemaVersion: 1, kind, name: dir, entry: "./index.ts" },
    }),
    "utf8",
  );
};

/** console.warn 을 가로채 경고 문자열을 모은다(로그가 진단면이라 내용까지 본다). */
const captureWarnings = async <T>(fn: () => Promise<T>): Promise<[T, string[]]> => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return [await fn(), lines];
  } finally {
    console.warn = original;
  }
};

export const check: RegressionCheck = {
  name: "plugin-manifest-kind",
  guards:
    "kind 한 필드를 로더(4종)와 providers(provider)가 서로 다른 사전으로 읽어 kind:['provider'] 플러그인이 카드만 뜨고 안 돌던 것 + 오타 kind 가 로그 0으로 플러그인을 통째로 사라지게 하던 것 + 문자열 kind 하위호환",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tgc-kind-"));
    try {
      await writePlugin(root, "str-kind", "channel"); // 문자열 — 하위호환
      await writePlugin(root, "provider-only", ["provider"]); // ①
      await writePlugin(root, "typo-only", ["chanel"]); // ② 전부 모르는 값
      await writePlugin(root, "typo-mixed", ["observer", "chanel"]); // ② 일부

      const [loaded, warnings] = await captureWarnings(() => loadPlugins(root));
      const byName = new Map(loaded.map((l) => [l.manifest.name, l]));
      const names = [...byName.keys()].sort();

      out.push(
        assert(
          "문자열 kind 는 계속 로드된다(schemaVersion 1 하위호환)",
          byName.get("str-kind")?.capabilities.includes("channel") === true,
          JSON.stringify(byName.get("str-kind")?.capabilities ?? null),
        ),
      );
      out.push(
        assert(
          "★kind:['provider'] 만 있어도 로드된다(사전 통합)",
          byName.get("provider-only")?.capabilities.includes("provider") === true,
          JSON.stringify(names),
        ),
      );
      out.push(
        assert(
          "아는 값이 하나도 없으면 건너뛴다",
          !byName.has("typo-only"),
          JSON.stringify(names),
        ),
      );
      out.push(
        assert(
          "일부만 모르는 값이면 나머지로 로드된다",
          byName.get("typo-mixed")?.capabilities.includes("observer") === true,
          JSON.stringify(byName.get("typo-mixed")?.capabilities ?? null),
        ),
      );

      // ★경고는 "있다" 로 끝내지 않는다 — 로그만 보고 고칠 수 있어야 하므로
      //  ①어느 플러그인인지 ②무엇이 모르는 값인지 ③아는 값이 무엇인지가 실려야 한다.
      const skipWarn = warnings.find((w) => w.includes("typo-only"));
      const mixedWarn = warnings.find((w) => w.includes("typo-mixed"));
      out.push(
        assert(
          "★건너뛴 이유가 로그에 남는다(종전 로그 0건)",
          skipWarn !== undefined,
          JSON.stringify(warnings),
        ),
      );
      out.push(
        assert(
          "경고에 모르는 값·아는 값이 함께 실린다",
          skipWarn !== undefined &&
            skipWarn.includes("chanel") &&
            skipWarn.includes("channel"),
          skipWarn ?? "(없음)",
        ),
      );
      out.push(
        assert(
          "부분 무시도 경고한다(절반만 무시된 채 뜨던 것)",
          mixedWarn !== undefined && mixedWarn.includes("chanel"),
          mixedWarn ?? "(없음)",
        ),
      );

      // 우리 레포의 실물도 함께 못박는다 — kind 는 전부 배열이고, 아는 값만 쓴다.
      const repoRoot = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../..",
      );
      const dirs = (
        await fs.readdir(path.join(repoRoot, "plugins"), { withFileTypes: true })
      )
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const kinds = await Promise.all(
        dirs.map(async (d) => {
          const raw = await fs.readFile(
            path.join(repoRoot, "plugins", d, "package.json"),
            "utf8",
          );
          return {
            d,
            kind: (JSON.parse(raw) as { tiguclaw?: { kind?: unknown } }).tiguclaw
              ?.kind,
          };
        }),
      );
      const notArray = kinds.filter((k) => !Array.isArray(k.kind)).map((k) => k.d);
      out.push(
        assert(
          "우리 레포의 kind 는 전부 배열이다(한 모양)",
          notArray.length === 0,
          notArray.length === 0 ? `${kinds.length}개 전부 배열` : JSON.stringify(notArray),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    return out;
  },
};
