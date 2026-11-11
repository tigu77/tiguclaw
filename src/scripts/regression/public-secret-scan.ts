/**
 * 회귀: **공개 후보 인덱스의 PII·비밀 검사가 실제 blob 을 읽고, 매치·오류에서 멈추고, 값을 내보내지 않는다** (2026-11-11)
 *
 * 잡는 것: 공개 싱크 §4 의 검사식이 하이픈형 `sk-ant-`·`sk-proj-` 와 GitHub·AWS·Google·Slack·PEM 형식을 못 보던 것
 *  (검사 기능의 결함 — 유출 사건 발견은 아니다). 검사는 `_workspace/public-secret-scan.mjs` 한 벌로 옮겼고 §4·§6 이 부른다.
 *
 * 등급: **동작 게이트.** ①스크립트를 임시 git 저장소 인덱스에 실제로 돌려 양성·음성·인덱스/작업 트리 차이·예외 정확도·검사 오류
 *  종료를 본다. ②스킬의 **§4 블록을 그대로** 실제 git·node 로 돌려 새 검사가 그 자리에서 불리고 실패가 블록 rc 로 전해지는지,
 *  ③§6 블록을 스텁으로 돌려 커밋 직전 검사 실패가 commit·push 를 막는지 본다.
 * ★합성 값은 실행 중에 조립한다 — 이 파일은 공개로 나가고, 나가는 소스에 검사식과 맞는 글자가 이어져 있으면 안 된다.
 *  PII 표본은 개발 전용 표본 파일에서 읽는다(배포 소스에 개인정보 조각을 두지 않고, 구현의 식과 독립된 기대값으로 쓴다).
 * ★`.claude/` 한 벌만 읽는다 — `.tiguclaw/` 미러와의 동일성은 `shipped-asset-self-contained` 가 지킨다.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, skip, type Assertion, type RegressionCheck } from "./_framework.js";
import { execRc, runSyncBlock, sectionBlock } from "./_sync-blocks.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOOL = path.join(REPO, "_workspace", "public-secret-scan.mjs");
const ALLOW = path.join(REPO, "_workspace", "public-secret-allow.json");
/** 종전 §4 PII 식의 표본 — 개발 전용 파일(공개로 안 나간다). 구현의 식에서 꺼내지 않는다: 식이 바뀌면 표본도 따라 바뀌어 못 잡는다. */
const PII_SAMPLES = path.join(REPO, "_workspace", "public-secret-pii-samples.json");
const SKILL = path.join(REPO, ".claude", "skills", "sync-public", "SKILL.md");

const j = (...p: string[]): string => p.join("");
const sha = (v: string): string => createHash("sha256").update(v, "latin1").digest("hex");
/** 부모 셸의 git 위치 변수를 물려받지 않는다 — 임시 저장소만 본다. */
const gitEnv = (): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY"]) delete e[k];
  return e;
};
const git = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { env: gitEnv(), encoding: "utf8" });
const scan = (pub: string, allow = ALLOW): Promise<{ rc: number; out: string }> =>
  execRc(process.execPath, [TOOL, pub, allow], { timeout: 30_000, env: gitEnv() }, "공개 비밀 검사");

/** 형식별 합성 값 — 실제 키 길이·엔트로피가 아닌 반복 문자. ★식의 가지(접두사·종류)마다 하나씩 — 가지 하나를 빼도 잡히게. */
const PEM_KINDS = ["RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "EC PRIVATE KEY", "PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"];
const pemHead = (kind: string): string => j("-----BEG", "IN ", kind, "-----");
const pemEnd = (kind: string): string => j("-----EN", "D ", kind, "-----");
const SYNTH: [string, string][] = [
  ["telegram-bot-token", j("123456789", ":", "A".repeat(35))],
  ["jwt", j("ey", "J", "B".repeat(30))],
  ["sk-api-key", j("s", "k-", "C".repeat(24))],
  ...["ant-api03-", "proj-", "or-v1-", "svcacct-", "admin-"].map((p): [string, string] => ["sk-api-key", j("s", "k-", p, "D".repeat(30))]),
  ...["p", "o", "u", "s", "r"].map((c): [string, string] => ["github-token", j("gh", c, "_", "G".repeat(36))]),
  ["github-token", j("github", "_pat_", "H".repeat(30))],
  ...["AK", "AS"].map((p): [string, string] => ["aws-access-key-id", j(p, "IA", "J".repeat(16))]),
  ["google-api-key", j("AI", "za", "K".repeat(35))],
  ...["a", "b", "p", "o", "s", "r"].map((c): [string, string] => ["slack-token", j("xo", "x", c, "-", "1".repeat(12))]),
  ...PEM_KINDS.map((k): [string, string] => ["private-key-pem", pemHead(k)]),
  ["bearer-literal", j("Bear", "er ", "L".repeat(24))],
];
/** 걸리면 안 되는 것 — 낱말 중간 하이픈형 · 짧은 값 · 긴 대문자열 속 AKIA · 보간 · 공개 키 머리말. */
const NEGATIVE = [
  j("ta", "sk-list-item-", "checkbox-wrapper-extra-long"),
  j("s", "k-short"),
  j("X", "AK", "IA", "M".repeat(16)),
  j("gh", "p_", "short"),
  j("xo", "xb-", "1"),
  "Bear" + "er ${token}",
  j("-----BEGIN ", "PUBLIC", " KEY-----"),
].join("\n");

export const check: RegressionCheck = {
  name: "public-secret-scan",
  guards:
    "공개 싱크 비밀 검사가 하이픈형 sk-ant/sk-proj·GitHub·AWS·Google·Slack·PEM 을 못 보고, 검사 오류·예외 남용·값 출력을 가르지 못하던 것",
  run: async (): Promise<Assertion[]> => {
    // 배포 트리엔 대상(dev 하네스·_workspace)이 없다 — 조용히 통과하지 않고 «둘 다 없음» 을 잰다.
    if (!existsSync(path.join(REPO, ".claude"))) {
      return [assert("배포 트리 — 대상(dev 하네스)이 통째로 없다. 개발 레포에서만 잰다", !existsSync(TOOL), `_workspace/public-secret-scan.mjs ${existsSync(TOOL) ? "★있음(트리가 일관되지 않다)" : "없음"}`)];
    }
    if (process.platform === "win32") {
      return [skip("public secret scan behaviour", "Developer sync-public harness uses POSIX shell blocks and paths. POSIX execution required.")];
    }
    const out: Assertion[] = [];
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-secretscan-"));
    let n = 0;
    /** 파일 묶음을 인덱스에 올린 새 저장소. */
    const repoWith = (files: Record<string, string>): string => {
      const dir = path.join(tmp, `r${n++}`);
      mkdirSync(dir);
      git(dir, "-c", "init.defaultBranch=main", "init", "-q");
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body, "latin1");
      }
      if (Object.keys(files).length > 0) git(dir, "add", "-A");
      return dir;
    };
    const allowWith = (entries: unknown): string => {
      const f = path.join(tmp, `allow${n++}.json`);
      writeFileSync(f, typeof entries === "string" ? entries : JSON.stringify(entries));
      return f;
    };
    const leaks = (o: string, values: string[]): string[] => values.filter((v) => o.includes(v));
    try {
      // ── ① 양성 — 형식마다 한 파일, 둘째 줄에 둔다(줄 번호 진단 확인) ─────────────────────────
      // PII: 종전 §4 다섯 식의 표본(개발 전용 파일)과 구현의 PII 유형 목록이 정확히 같아야 한다 — 유형이 빠지거나 늘면 여기서.
      const samples = existsSync(PII_SAMPLES) ? (JSON.parse(readFileSync(PII_SAMPLES, "utf8")) as Record<string, string[]>) : {};
      const toolPii = [...readFileSync(TOOL, "utf8").matchAll(/\['(pii-[a-z-]+)',/g)].map((m) => m[1]!).sort();
      const pii = Object.entries(samples).flatMap(([type, vs]) => vs.map((v): [string, string] => [type, v]));
      out.push(assert("PII 표본(개발 전용)이 종전 다섯 유형이고 구현의 PII 유형과 같다", Object.keys(samples).length === 5 &&
        JSON.stringify(Object.keys(samples).sort()) === JSON.stringify(toolPii) && pii.every(([, v]) => v.length > 0),
        `표본 ${Object.keys(samples).join(",") || "없음"} · 구현 ${toolPii.join(",")}`));
      const positives = [...SYNTH, ...pii];
      const posRepo = repoWith(Object.fromEntries(positives.map(([, v], i) => [`p/${i}.txt`, `head\nx = "${v}"\n`])));
      const pos = await scan(posRepo, allowWith([]));
      const missed = positives.map(([type], i) => `p/${i}.txt:2 · ${type}`).filter((want) => !pos.out.includes(`🔴 ${want}`));
      out.push(
        assert("★형식·가지마다 «경로:줄 · 유형» 으로 걸리고 rc=1(PII 는 창 경로 백슬래시 하나·둘 포함)", pos.rc === 1 && missed.length === 0, `rc=${pos.rc} · ${positives.length}개 중 놓침 ${missed.join(", ") || "0"}`),
        assert("★진단에 값이 나오지 않는다", leaks(pos.out, positives.map(([, v]) => v)).length === 0, `노출 ${leaks(pos.out, positives.map(([, v]) => v)).length}건`),
      );

      // ── ② 음성 ──────────────────────────────────────────────────────────────────
      const neg = await scan(repoWith({ "n.txt": NEGATIVE }), allowWith([]));
      out.push(assert("음성 — 낱말 중간·짧은 값·보간·공개 키는 걸리지 않고 rc=0", neg.rc === 0 && /✅/.test(neg.out), `rc=${neg.rc} · ${neg.out.trim().split("\n").slice(-1)[0]?.slice(0, 120) ?? ""}`));

      // ── ③ 인덱스를 읽는다 — 작업 트리가 아니다 ─────────────────────────────────────────
      const key = SYNTH[3]![1];
      const unstaged = repoWith({ "a.txt": "clean\n" });
      writeFileSync(path.join(unstaged, "a.txt"), `x = "${key}"\n`);
      const staged = repoWith({ "a.txt": `x = "${key}"\n` });
      writeFileSync(path.join(staged, "a.txt"), "clean\n");
      const u = await scan(unstaged, allowWith([]));
      const s = await scan(staged, allowWith([]));
      out.push(
        assert("★작업 트리에만 있는 값(미스테이지)은 인덱스 검사에서 걸리지 않는다", u.rc === 0, `rc=${u.rc}`),
        assert("★인덱스에 올라간 값은 작업 트리를 지워도 걸린다", s.rc === 1 && s.out.includes("a.txt:1 · sk-api-key"), `rc=${s.rc}`),
      );

      // ── ④ 예외 — 경로·유형·값 지문 정확 일치만 ───────────────────────────────────────
      const entry = { path: "f/x.ts", type: "sk-api-key", sha256: sha(key), reason: "합성 회귀 입력" };
      const other = SYNTH[4]![1];
      const exact = await scan(repoWith({ "f/x.ts": `a = "${key}"\n` }), allowWith([entry]));
      const sameLine = await scan(repoWith({ "f/x.ts": `a = "${key}"; b = "${other}"\n` }), allowWith([entry]));
      const changed = await scan(repoWith({ "f/x.ts": `a = "${key.slice(0, -1)}Z"\n` }), allowWith([entry]));
      const moved = await scan(repoWith({ "f/y.ts": `a = "${key}"\n` }), allowWith([entry]));
      const otherType = await scan(repoWith({ "f/x.ts": `a = "${key}"\n` }), allowWith([{ ...entry, type: "jwt" }]));
      out.push(
        assert("예외 정확 일치는 통과하고 «예외 적용 1건» 을 남긴다", exact.rc === 0 && /예외 적용 1건/.test(exact.out), `rc=${exact.rc}`),
        assert("★같은 줄에 다른 값이 생기면 그 값은 걸린다", sameLine.rc === 1 && sameLine.out.includes("f/x.ts:1 · sk-api-key"), `rc=${sameLine.rc}`),
        assert("★예외 값이 한 글자 바뀌면 걸린다", changed.rc === 1, `rc=${changed.rc}`),
        assert("★같은 값이라도 다른 파일이면 걸린다", moved.rc === 1, `rc=${moved.rc}`),
        assert("유형이 다른 예외는 적용되지 않는다", otherType.rc === 1, `rc=${otherType.rc}`),
      );
      // PEM — 예외 지문이 머리말 뒤 본문까지 덮는다(본문 없는 머리말 예외에 본문이 붙거나, 본문 있는 예외의 본문이 바뀌면 다시 걸린다).
      const head = pemHead(PEM_KINDS[0]!);
      const body = "Q".repeat(64);
      const pemBlock = `${head}\n${body}\n${pemEnd(PEM_KINDS[0]!)}`;
      const headEntry = { path: "k.ts", type: "private-key-pem", sha256: sha(head), reason: "본문 없는 머리말" };
      const blockEntry = { ...headEntry, sha256: sha(pemBlock), reason: "합성 본문" };
      const pemHeadOnly = await scan(repoWith({ "k.ts": `pem: "${head}"\n` }), allowWith([headEntry]));
      const pemBodyAdded = await scan(repoWith({ "k.ts": `pem: "${pemBlock}"\n` }), allowWith([headEntry]));
      const pemBodyNoEnd = await scan(repoWith({ "k.ts": `pem: "${head}${body}"\n` }), allowWith([headEntry]));
      const pemBlockOk = await scan(repoWith({ "k.ts": `${pemBlock}\n` }), allowWith([blockEntry]));
      const pemBlockChanged = await scan(repoWith({ "k.ts": `${pemBlock.replace("QQ", "QR")}\n` }), allowWith([blockEntry]));
      out.push(
        assert("PEM 머리말 예외 정확 일치는 통과", pemHeadOnly.rc === 0, `rc=${pemHeadOnly.rc}`),
        assert("★PEM 머리말 예외 뒤에 본문·끝 표식이 붙으면 걸린다", pemBodyAdded.rc === 1 && pemBodyAdded.out.includes("k.ts:1 · private-key-pem"), `rc=${pemBodyAdded.rc}`),
        assert("★PEM 머리말 예외 뒤에 끝 표식 없는 본문이 붙어도 걸린다", pemBodyNoEnd.rc === 1, `rc=${pemBodyNoEnd.rc}`),
        assert("PEM 본문 포함 예외 정확 일치는 통과", pemBlockOk.rc === 0, `rc=${pemBlockOk.rc}`),
        assert("★PEM 본문이 한 글자 바뀌면 걸린다", pemBlockChanged.rc === 1, `rc=${pemBlockChanged.rc}`),
      );
      const clean = repoWith({ "c.txt": "clean\n" });
      const rejects: [string, unknown][] = [
        ["PII 유형 예외", [{ ...entry, type: "pii-email" }]],
        ["줄 번호 키", [{ ...entry, line: 1 }]],
        ["지문 없음(파일 전체 예외)", [{ path: entry.path, type: entry.type, reason: entry.reason }]],
        ["폴더 경로", [{ ...entry, path: "f/" }]],
        ["와일드카드 경로", [{ ...entry, path: "f/*.ts" }]],
        ["사유 없음", [{ ...entry, reason: " " }]],
        ["JSON 오류", "[{"],
      ];
      for (const [why, list] of rejects) {
        const r = await scan(clean, allowWith(list));
        out.push(assert(`★예외 목록 거부 — ${why} → rc=2(판정하지 않음)`, r.rc === 2 && /검사 오류/.test(r.out), `rc=${r.rc}`));
      }
      const noAllow = await scan(clean, path.join(tmp, "없는-예외.json"));
      out.push(assert("★예외 목록이 없으면 rc=2", noAllow.rc === 2, `rc=${noAllow.rc}`));

      // ── ⑤ 검사 오류는 무매치가 아니다 ─────────────────────────────────────────────────
      const notRepo = path.join(tmp, "not-a-repo");
      mkdirSync(notRepo);
      const nr = await scan(notRepo, allowWith([]));
      const empty = await scan(repoWith({}), allowWith([]));
      const missing = repoWith({ "c.txt": "clean\n" });
      git(missing, "update-index", "--add", "--cacheinfo", `100644,${"1".repeat(40)},ghost.txt`);
      const ms = await scan(missing, allowWith([]));
      const sub = repoWith({ "c.txt": "clean\n" });
      git(sub, "update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},vendor/sub`);
      const gl = await scan(sub, allowWith([]));
      out.push(
        assert("★저장소가 아니면 rc=2 · git 오류 본문(fatal)을 옮기지 않는다", nr.rc === 2 && !/fatal/i.test(nr.out), `rc=${nr.rc} · ${nr.out.trim().slice(0, 100)}`),
        assert("★빈 인덱스는 rc=2(검사할 것이 없다 ≠ 통과)", empty.rc === 2, `rc=${empty.rc}`),
        assert("★인덱스가 가리키는 blob 이 없으면 rc=2", ms.rc === 2, `rc=${ms.rc}`),
        assert("gitlink 는 검사할 수 없어 rc=2", gl.rc === 2, `rc=${gl.rc}`),
      );

      // ── ⑥ §4 블록을 그대로 실제로 돌린다 — 새 검사가 그 자리에서 불리고 실패가 rc 로 전해진다 ─────────
      const skill = readFileSync(SKILL, "utf8");
      const s4 = sectionBlock(skill, "4. ");
      out.push(assert("§4 첫 블록을 찾는다", s4 !== undefined, String(s4 !== undefined)));
      if (s4 !== undefined) {
        const dev = path.join(tmp, "dev");
        mkdirSync(path.join(dev, "_workspace"), { recursive: true });
        for (const f of ["sync-gate.sh", "public-secret-scan.mjs", "public-secret-allow.json"]) copyFileSync(path.join(REPO, "_workspace", f), path.join(dev, "_workspace", f));
        const block = path.join(tmp, "s4.zsh");
        writeFileSync(block, s4);
        const runS4 = (pub: string): Promise<{ rc: number; out: string }> =>
          execRc("/bin/zsh", [block], { timeout: 60_000, env: { ...gitEnv(), DEV: dev, PUB: pub, GATE_LOG: tmp } }, "§4 블록");
        const okPub = repoWith({ "src/a.ts": "export const a = 1;\n" });
        const badPub = repoWith({ "src/a.ts": "export const a = 1;\n" });
        writeFileSync(path.join(badPub, "src/b.ts"), `const k = "${key}";\n`); // 블록의 git add -A 가 올린다
        const ok4 = await runS4(okPub);
        const bad4 = await runS4(badPub);
        writeFileSync(path.join(dev, "_workspace", "public-secret-allow.json"), "{");
        const err4 = await runS4(okPub);
        out.push(
          assert("§4 정상 후보 — rc=0", ok4.rc === 0, `rc=${ok4.rc} · ${ok4.out.trim().split("\n").slice(-1)[0]?.slice(0, 100) ?? ""}`),
          assert("★§4 — 블록이 올린 하이픈형 키를 새 검사가 잡아 비영(종전 식이면 통과했다) · 값 미출력", bad4.rc !== 0 && bad4.out.includes("src/b.ts:1 · sk-api-key") && !bad4.out.includes(key), `rc=${bad4.rc}`),
          assert("★§4 — 검사 오류(예외 목록 손상)도 비영", err4.rc !== 0 && /검사 오류/.test(err4.out), `rc=${err4.rc}`),
        );
      }

      // ── ⑦ §6 — 커밋 직전 같은 검사, 실패하면 commit·push 없음 ─────────────────────────────
      const s6 = sectionBlock(skill, "6. ");
      out.push(assert("§6 블록을 찾는다", s6 !== undefined, String(s6 !== undefined)));
      if (s6 !== undefined) {
        const ok6 = await runSyncBlock(REPO, s6);
        const bad6 = await runSyncBlock(REPO, s6, { secret: 1 });
        const at = (calls: string[], re: RegExp): number => calls.findIndex((c) => re.test(c));
        const scanRe = /^node \S*public-secret-scan\.mjs /;
        const scans = ok6.calls.filter((c) => scanRe.test(c));
        const scanAt = at(ok6.calls, scanRe);
        const commitAt = at(ok6.calls, /^git .* commit /);
        const addAt = at(ok6.calls, /^git .* add -A$/);
        const addAfterScan = ok6.calls.slice(scanAt + 1, commitAt).some((c) => /^git .* add\b/.test(c));
        // 검사 대상 = 공개 후보($PUB) — runSyncBlock 은 DEV=<tmp>/dev · PUB=<tmp>/pub 로 돌린다. `$DEV` 를 넘기면 후보를 안 본다.
        const target = /^node (\S+)\/dev\/_workspace\/public-secret-scan\.mjs (\S+)\/pub$/.exec(scans[0] ?? "");
        out.push(
          assert("§6 정상 — add -A 다음, commit 전에 검사가 한 번 불리고 그 사이 add 가 없다", ok6.rc === 0 && addAt >= 0 && scanAt > addAt && commitAt > scanAt &&
            scans.length === 1 && !addAfterScan, `rc=${ok6.rc} · add ${addAt} · scan ${scanAt}(${scans.length}회) · commit ${commitAt} · 사이 add ${addAfterScan}`),
          assert("★§6 검사 대상은 공개 후보($PUB) 하나 — 개발 레포를 넘기면 후보의 새 값을 안 본다", target !== null && target[1] === target[2],
            scans[0]?.replace(/\/[^ ]*\/(dev|pub)\b/g, "<tmp>/$1") ?? "호출 없음"),
          assert("★§6 검사가 실패하면 commit·push 없이 비영", bad6.rc !== 0 && !bad6.calls.some((c) => / commit /.test(c) || /\bpush\b/.test(c)),
            `rc=${bad6.rc} · ${bad6.calls.filter((c) => / commit |\bpush\b/.test(c)).join(" | ") || "commit·push 0"}`),
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return out;
  },
};
