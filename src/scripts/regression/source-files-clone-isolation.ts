/** 복제본만 제외하고, gitignored 개발 스크립트의 위반은 계속 잡는다. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, assertIsolated, skip, type Assertion, type RegressionCheck } from "./_framework.js";
import { CLONE_CONTAINER, listSourceFiles } from "./_source-files.js";

const SCANNERS = ["file-url-not-pathname", "dotbin-shim-is-not-spawnable"];
const normalizedRelative = (p: string): string => p.replaceAll("\\", "/");
// synthetic 경로·위반 코드는 임시 트리에 넣는 데이터다. 제품 도구 참조/실행 소스와
// 구별되는 JSON에 원문 그대로 두며, 전수 검사의 탐지 규칙은 바꾸지 않는다.
const { included, excluded, badSource: BAD } = JSON.parse(
  readFileSync(new URL("./fixtures/source-files-clone-isolation.json", import.meta.url), "utf8"),
) as { included: string[]; excluded: string[]; badSource: string };

export const check: RegressionCheck = {
  name: "source-files-clone-isolation",
  guards: "_workspace 안의 변이용 복제본이 제품 소스 검사에 혼입되던 것 — 넓은 제외로 원본 위반까지 숨기지 않는다",
  async run(): Promise<Assertion[]> {
    assertIsolated();
    const out: Assertion[] = [];
    // 작은 synthetic 트리만 만든다. 레포·홈·DB 사본은 없고, 러너가 자기 임시 홈을 정리한다.
    const fixture = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "source-files-"));
    const put = (root: string, rel: string, text: string): void => {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    const helper = readFileSync(new URL("./_source-files.ts", import.meta.url), "utf8");
    const makeTree = async (name: string, source: string): Promise<{ root: string; checks: RegressionCheck[] }> => {
      const root = path.join(fixture, name);
      put(root, "package.json", '{"type":"module"}');
      put(root, ".gitignore", "_workspace/*\n");
      // 기존 스캐너의 >200 하한도 실제로 통과시켜, 위반 단언과 하한 실패를 구별한다.
      for (let i = 0; i < 201; i += 1) put(root, `src/empty-${String(i)}.ts`, "");
      const reg = "src/scripts/regression/";
      put(root, `${reg}_source-files.ts`, source);
      put(root, `${reg}_framework.ts`, "export const assert = (name, ok, got) => ({ name, ok, got });\n");
      const checks: RegressionCheck[] = [];
      for (const scanner of SCANNERS) {
        put(root, `${reg}${scanner}.ts`, readFileSync(new URL(`./${scanner}.ts`, import.meta.url), "utf8"));
        const mod = await import(pathToFileURL(path.join(root, reg, `${scanner}.ts`)).href) as { check: RegressionCheck };
        checks.push(mod.check);
      }
      return { root, checks };
    };
    const normal = await makeTree("normal", helper);
    // 같은 이름·접두·중첩 경로는 제외하지 않는다. 증거도 컨테이너 밖에 남는다.
    for (const rel of included) put(normal.root, rel, "");
    for (const rel of excluded) put(normal.root, rel, BAD);
    put(normal.root, "src/notes.md", BAD);
    const files = listSourceFiles(normal.root).map((f) => normalizedRelative(path.relative(normal.root, f)));
    const winRoot = "C:\\fixture";
    const winIncluded = included.map((r) => normalizedRelative(path.win32.relative(winRoot, path.win32.join(winRoot, r))));
    out.push(assert("Windows 상대경로도 포함·제외 비교 형식과 일치한다", included.every((r) => winIncluded.includes(r)) && excluded.every((r) => !winIncluded.includes(r)), winIncluded));
    out.push(assert("전용 컨테이너·기존 제외·비대상 확장자만 빠진다", excluded.every((r) => !files.includes(r)) && !files.includes("src/notes.md"), files.length));
    out.push(assert("제품·gitignored 스크립트·증거·유사 이름·중첩 경로는 열거한다", included.every((r) => files.includes(r)), included));
    const absentFiles = listSourceFiles(path.join(fixture, "absent"));
    out.push(assert("없는 루트는 기존처럼 빈 목록이다", absentFiles.length === 0, absentFiles));
    for (const scanner of normal.checks) {
      const clean = await scanner.run();
      out.push(assert(`${scanner.name}: 복제본의 위반은 혼입되지 않는다`, clean.every((a) => a.ok), clean));
      // 소스 검사를 실제로 돌려 정상 경로 각각에서 위반 단언이 빨개지는지 대조한다.
      for (const rel of included) {
        put(normal.root, rel, BAD);
        const bad = await scanner.run();
        out.push(assert(`${scanner.name}: ${rel} 위반은 검출한다`, bad[0]?.ok === true && bad[1]?.ok === false, bad));
        put(normal.root, rel, "");
      }
    }
    // 필수 분기 제거 대조: 원본 대신 synthetic helper 사본만 망가뜨린다.
    const branch = "if (full === cloneContainer) continue;";
    const mutantSource = helper.replace(branch, "");
    out.push(assert("제외 분기 제거 변이가 실제로 붙는다", mutantSource !== helper, branch));
    const mutant = await makeTree("without-clone-exclusion", mutantSource);
    put(mutant.root, excluded[0]!, BAD);
    for (const scanner of mutant.checks) {
      const red = await scanner.run();
      out.push(assert(`${scanner.name}: 제외 분기가 없으면 복제본 혼입으로 빨강`, red[0]?.ok === true && red[1]?.ok === false, red));
    }
    const skillPath = new URL("../../../.tiguclaw/skills/mutation-hunt/SKILL.md", import.meta.url);
    const linkage = "생성 지침이 공통 열거와 같은 컨테이너·분리된 증거 경로를 가리킨다";
    // 개발 스킬은 공개 배포에서 EXCLUDE 된다. 열거·검출 대조는 그곳에서도 모두 실행한다.
    if (existsSync(new URL("../", skillPath))) {
      const isolation = readFileSync(skillPath, "utf8").split("[격리]")[1]?.split("<!-- 소비자별:끝 -->")[0] ?? "";
      out.push(assert(linkage, isolation.includes(`\`${CLONE_CONTAINER}/mut-`) && isolation.includes("`_workspace/hunt/<주제>/`") && isolation.includes("_source-files.ts"), isolation));
    } else {
      out.push(skip(linkage, "개발 전용 mutation-hunt 스킬 부재(공개 배포 EXCLUDE)"));
    }
    return out;
  },
};
