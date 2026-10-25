/**
 * 회귀: **공개 싱크는 의존성을 고치지 않고, 개발 레포에서 검증한 lock 그대로 내보낸다** (2026-10-25 사용자 확정).
 *
 * 사고(2026-10-24 데브싱크): §5 의 `npm audit fix` 가 공개 트리에서만 zod 를 4.4.3 → 4.6.7 로 올렸고, 개발 레포에서
 *  한 번도 검증하지 않은 조합(claude-agent-sdk 0.3.280 × zod 4.6.7)이 z.record 도구 목록을 통째로 깨뜨려 배포 트리
 *  회귀 132/6,072 빨강이 났다. 그 전 싱크들도 같은 길로 개발에 없던 판(MCP sdk 1.32.1 — 개발은 1.29.0)을 내보냈다.
 *  정책: 의존성 갱신은 개발 레포에서 보안 점검 → 호환·전체 검증 → 그 판 그대로 싱크. 싱크는 `npm audit` **검사만** 하고
 *  새 취약점이면 개발 단계로 돌린다.
 *
 * ★등급: **동작 게이트 두 겹.** ①판정 도구(`_workspace/check-public-lock.mjs`)를 픽스처로 **실제로 돌려** 통과·실패 양쪽을
 *  본다 — 공개 변환이 바꾸는 lock 루트 `license` 만 허용하고, lock 최상위·패키지 항목·의존 선언의 어떤 차이도 실패다(바이트
 *  동일은 요구하지 않는다). ②스킬의 **§5 블록과 §7 설치 블록을 각각** 스텁 명령으로 실제로 돌려, 대조·audit 가 그 블록에서
 *  불리고 실패하면 블록이 비영으로 끝나는지 본다(GPT 검토 10-25 — «어딘가에 있다» 만 세면 한쪽을 지워도 초록이었다).
 * ★`.claude/` 한 벌만 읽는다 — `.tiguclaw/` 미러와의 동일성은 `shipped-asset-self-contained` 가 지킨다.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, skip, type Assertion, type RegressionCheck } from "./_framework.js";
import { execRc, runSyncBlock, sectionBlock } from "./_sync-blocks.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOOL = path.join(REPO, "_workspace", "check-public-lock.mjs");
const SKILL = path.join(REPO, ".claude", "skills", "sync-public", "SKILL.md");

type Json = Record<string, any>;
const run = (dev: string, pub: string): Promise<{ rc: number; out: string }> => execRc(process.execPath, [TOOL, dev, pub], { timeout: 20_000 }, "lock 대조 도구");
const bashBlocks = (md: string): string => [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? "").join("\n");

export const check: RegressionCheck = {
  name: "public-lock-matches-dev",
  guards:
    "공개 싱크의 npm audit fix 가 개발에서 검증하지 않은 의존성 조합을 내보내던 것(zod 4.6.7 × SDK 0.3.280 → 도구 목록 실패 132건) — 싱크는 검사만, 갱신은 개발 레포에서",
  run: async (): Promise<Assertion[]> => {
    // 배포 트리엔 대상(dev 하네스·_workspace)이 없다 — 조용히 통과하지 않고 «둘 다 없음» 을 잰다.
    if (!existsSync(path.join(REPO, ".claude"))) {
      return [assert("배포 트리 — 대상(dev 하네스)이 통째로 없다. 개발 레포에서만 잰다", !existsSync(TOOL), `_workspace/check-public-lock.mjs ${existsSync(TOOL) ? "★있음(트리가 일관되지 않다)" : "없음"}`)];
    }
    const out: Assertion[] = [];
    const devPkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as Json;
    const devLock = JSON.parse(readFileSync(path.join(REPO, "package-lock.json"), "utf8")) as Json;
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-publock-"));
    try {
      const dev = path.join(tmp, "dev");
      mkdirSync(dev);
      writeFileSync(path.join(dev, "package.json"), JSON.stringify(devPkg));
      writeFileSync(path.join(dev, "package-lock.json"), JSON.stringify(devLock));
      /** 공개 변환(§3)을 한 정상 공개 트리를 만든 뒤 `edit` 로 한 가지만 바꾼다. */
      let n = 0;
      const pubWith = (edit: (pkg: Json, lock: Json) => void, writeLock = true): string => {
        const dir = path.join(tmp, `pub${n++}`);
        mkdirSync(dir);
        const pkg = structuredClone(devPkg);
        const lock = structuredClone(devLock);
        pkg.license = "Apache-2.0";
        lock.packages[""].license = "Apache-2.0";
        edit(pkg, lock);
        writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
        if (writeLock) writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
        return dir;
      };
      const entries = Object.entries(devLock.packages as Record<string, Json>).filter(([k]) => k !== "");
      const someKey = entries.find(([, v]) => typeof v.integrity === "string")![0];
      const withDeps = entries.find(([, v]) => v.dependencies !== undefined && Object.keys(v.dependencies).length > 0)![0];
      const cases: Array<[string, number, string]> = [
        ["정상 공개 변환(license 만 다름·서식 다름)", 0, pubWith(() => undefined)],
        ["패키지 판이 다르다", 1, pubWith((_p, l) => { l.packages[someKey].version = "999.0.0"; })],
        ["integrity 만 다르다", 1, pubWith((_p, l) => { l.packages[someKey].integrity = "sha512-AAAA"; })],
        ["resolved 만 다르다", 1, pubWith((_p, l) => { l.packages[someKey].resolved = "https://registry.example.invalid/x.tgz"; })],
        ["하위 의존 관계만 다르다", 1, pubWith((_p, l) => { l.packages[withDeps].dependencies = { ...l.packages[withDeps].dependencies, "extra-pkg": "^1.0.0" }; })],
        ["플래그(dev)만 다르다", 1, pubWith((_p, l) => { l.packages[someKey].dev = !l.packages[someKey].dev; })],
        ["공개에만 있는 패키지", 1, pubWith((_p, l) => { l.packages["node_modules/extra-pkg"] = { version: "1.0.0" }; })],
        ["공개에 없는 패키지", 1, pubWith((_p, l) => { delete l.packages[someKey]; })],
        ["lock 루트 license 를 안 바꿨다", 1, pubWith((_p, l) => { l.packages[""].license = devLock.packages[""].license; })],
        ["lock 루트가 license 밖에서 다르다(의존)", 1, pubWith((_p, l) => { l.packages[""].dependencies = { ...l.packages[""].dependencies, "extra-pkg": "^1.0.0" }; })],
        ["lock 루트가 license 밖에서 다르다(version)", 1, pubWith((_p, l) => { l.packages[""].version = "999.0.0"; })],
        ["lock 최상위 version 이 다르다", 1, pubWith((_p, l) => { l.version = "999.0.0"; })],
        ["lock 최상위 requires 가 다르다", 1, pubWith((_p, l) => { l.requires = !l.requires; })],
        ["lock 최상위 lockfileVersion 이 다르다", 1, pubWith((_p, l) => { l.lockfileVersion = 1; })],
        ["공개 lock 이 없다(읽기 실패)", 2, pubWith(() => undefined, false)],
      ];
      // package.json 의 의존 선언 — npm 이 읽는 이름 전부(두 철자의 bundle 포함). 공개에만 하나를 더해 본다.
      for (const f of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "overrides"]) {
        const v = f.startsWith("bundle") ? ["zod"] : f === "peerDependenciesMeta" ? { "extra-pkg": { optional: true } } : { "extra-pkg": "1.0.0" };
        cases.push([`package.json ${f} 가 다르다`, 1, pubWith((p) => { p[f] = Array.isArray(v) ? v : { ...(p[f] ?? {}), ...v }; })]);
      }
      for (const [label, want, dir] of cases) {
        const r = await run(dev, dir);
        out.push(assert(`판정 도구: ${label} → 종료 ${want}`, r.rc === want, `rc=${r.rc} · ${r.out.trim().split("\n")[0]?.slice(0, 160) ?? ""}`));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const skill = readFileSync(SKILL, "utf8");
    const auditFix = bashBlocks(skill).match(/^.*audit\s+fix.*$/gm) ?? [];
    out.push(assert("★sync-public 실행 블록에 `audit fix` 가 없다(싱크는 의존성을 고치지 않는다)", auditFix.length === 0,
      `bash 블록 안 \`audit fix\` ${auditFix.length}줄${auditFix.slice(0, 2).map((l) => ` · «${l.trim().slice(0, 60)}»`).join("")}`));

    // ── ② §5·§7 블록을 **각각** 실제로 돌린다 ─────────────────────────────────────
    if (process.platform === "win32") {
      out.push(skip("sync-public §5·§7 block execution", "Developer sync-public shell harness uses zsh; tool fixtures above still run. POSIX execution required."));
      return out;
    }
    const blocks: Array<[string, string, string | undefined]> = [["§5", "5. ", sectionBlock(skill, "5. ")], ["§7 설치", "7. ", sectionBlock(skill, "7. ")]];
    for (const [label, heading, block] of blocks) {
      if (block === undefined) {
        out.push(assert(`${label} 블록을 찾는다`, false, `«### ${heading}» 절 ${skill.includes(`\n### ${heading}`) ? "있음 · bash 블록 없음" : "없음"}`));
        continue;
      }
      const pass = await runSyncBlock(REPO, block);
      const lockFail = await runSyncBlock(REPO, block, { lock: 1 });
      const auditFail = await runSyncBlock(REPO, block, { audit: 1 });
      const called = (r: { calls: string[] }, re: RegExp): boolean => r.calls.some((c) => re.test(c));
      out.push(
        assert(`${label}: 정상이면 블록 0 · lock 대조와 npm audit 를 이 블록에서 부른다`,
          pass.rc === 0 && called(pass, /^node \S*check-public-lock\.mjs /) && called(pass, /^npm audit$/),
          `rc=${pass.rc} · 호출 ${pass.calls.filter((c) => /check-public-lock|npm audit/.test(c)).join(" | ") || "없음"} · ${pass.out.trim().split("\n").slice(-1)[0]?.slice(0, 100) ?? ""}`),
        assert(`★${label}: lock 대조가 실패하면 블록이 비영으로 끝난다`, lockFail.rc !== 0, `rc=${lockFail.rc}`),
        assert(`★${label}: npm audit 가 취약점을 내면 블록이 비영으로 끝난다(고치지 않는다)`, auditFail.rc !== 0, `rc=${auditFail.rc}`),
      );
    }
    return out;
  },
};
