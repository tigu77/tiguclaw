import { skip } from "./_framework.js";
/**
 * 회귀: **sync-public 의 블록이 `set -e` 에 기대지 않고 rc 를 직접 본다** (2026-09-17)
 *
 * 잡는 것: 싱크 절차가 **실패했는데 통과로 읽혀 다음 단계가 낡은 트리 위에서 도는 것.**
 *
 * ★실측 — sync-public 을 실제로 돌리는 셸에서 `set -e` 가 서브셸 안 명령 실패에 **안 듣는다**:
 *
 *      ( set -e; false; echo "도달하면 안 되는 자리" ); echo "rc=$?"
 *      → 도달하면 안 되는 자리 · rc=0
 *
 *  `zsh -c` · 표준입력 zsh · `bash -c` 는 전부 rc=1 이다. 셸 종류가 아니라 **이 실행 경로**의
 *  성질이고, 그래서 «문서에 `set -euo pipefail` 을 적어두면 지켜진다» 가 거짓이다.
 *
 * ★실제 피해(2026-09-17 싱크): §1 의 `prepare-public-stage.mjs` 가 *"staging 준비 중단"* 으로
 *  rc=1 로 죽었는데 블록이 rc=0 으로 빠져나와 «§1 rc=0» 을 찍었고, **§2·§3 이 낡은 트리 위에서
 *  돌았다.** §5 는 2026-09-16 에 이미 이 부류를 고쳤는데(자체 `gate()`), §0~§4 는 못 고쳐
 *  **한 파일 안에서 같은 병을 절반만 닫고 있었다** — 「게이트는 '있다' 가 아니라 '도는가'」.
 *
 * ★**이 검사가 개수를 세지 않는 이유**: 블록 수는 절차가 늘면 정당하게 는다. 그래서 «몇 개» 가
 *  아니라 **«실행 블록에 `set -euo pipefail` 이 없고, 공유 헬퍼를 쓴다»** 는 성질을 본다.
 *  헬퍼는 파일 하나(`_workspace/sync-gate.sh`)에만 정의된다 — 블록마다 복사하면 그게 곧
 *  두 벌이고, 한쪽만 고쳐져 §0~§4 가 뒤처진 것이 이 사고다.
 *
 * ★**`.claude/` 한 벌만 읽는다** — `.tiguclaw/` 미러도 데몬이 읽지만, 둘이 «소비자별 구역»
 *  밖에서 한 글자도 다르지 않다는 것은 `shipped-asset-self-contained` 가 이미 지킨다(실제로
 *  이 변경에서 그 검사가 미러 누락을 잡았다). 여기서 둘을 다 읽으면 **같은 판단이 두 곳**이 된다.
 *
 * ★등급: **소스 게이트 + 동작 게이트.** ①은 스킬 본문을 읽고, ②는 헬퍼를 **실제로 돌려**
 *  실패를 비영으로 만드는지 본다(문장만 검사하면 헬퍼가 망가져도 초록이다).
 */
import { readFile, stat } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { blockContaining, execRc, exitCodeOf, runSyncBlock, sectionBlock } from "./_sync-blocks.js";

const REPO = new URL("../../../", import.meta.url);

/** 스킬 본문의 ```bash 펜스 안쪽만 — 설명 문장을 코드로 세지 않는다. */
const bashBlocks = (md: string): string[] => {
  const out: string[] = [];
  const re = /```bash\n([\s\S]*?)```/g;
  for (const m of md.matchAll(re)) out.push(m[1] ?? "");
  return out;
};

const sh = (script: string): Promise<{ rc: number; out: string }> => execRc("/bin/zsh", ["-c", script], { timeout: 20_000 }, "헬퍼 실행");

export const check: RegressionCheck = {
  name: "sync-gates-check-rc",
  guards:
    "싱크 절차가 실패했는데 통과로 읽혀 다음 단계가 낡은 트리 위에서 도는 것 — 이 실행 경로에서 set -e 가 안 듣는다",
  run: async (): Promise<Assertion[]> => {
    // ★**배포 트리엔 이 검사의 대상이 없다** (2026-09-17 싱크에서 빨강). 스킬 본문도
    //  헬퍼도 dev 전용이라 manifest 가 뺀다(`.claude/`·`_workspace/`) — 배포 레포에서 읽으면
    //  ENOENT 로 던진다. 스킬이 경고한 그 부류다: *"개발 레포에만 있는 경로를 읽으면 배포
    //  레포에서 깨진다 — 있는 쪽을 읽거나 «대상 아님» 을 **명시하고** 통과시켜라."*
    // ★**조용히 통과시키지 않는다.** 그리고 판정은 파일 이름 목록이 아니라 **조건**이다:
    //  `.claude/` 자체가 없으면 배포 트리이고, 있는데 스킬만 없으면 **진짜 실패**다.
    //  둘의 부재가 **함께** 성립하는지까지 재서, 항상 참인 가짜 검사가 되지 않게 한다.
    const exists = async (rel: string): Promise<boolean> => {
      try {
        await stat(new URL(rel, REPO));
        return true;
      } catch {
        return false;
      }
    };
    if (!(await exists(".claude"))) {
      const helperGone = !(await exists("_workspace/sync-gate.sh"));
      return [
        assert(
          "배포 트리 — 이 검사의 대상(dev 하네스)이 통째로 없다. 개발 레포에서만 잰다",
          helperGone,
          `.claude/ 없음 · _workspace/sync-gate.sh ${helperGone ? "없음" : "★있음(트리가 일관되지 않다)"}`,
        ),
      ];
    }
    const skill = await readFile(
      new URL(".claude/skills/sync-public/SKILL.md", REPO),
      "utf8",
    );
    const blocks = bashBlocks(skill);
    const withSetE = blocks.filter((b) => /^\s*set -euo pipefail\s*$/m.test(b));
    // 헬퍼를 필요로 하는 블록 = 여러 명령을 이어 도는 것(단일 `node …` 한 줄은 제외).
    const multi = blocks.filter((b) => b.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).length >= 4);
    const sourced = multi.filter((b) => /sync-gate\.sh/.test(b));

    const helperSrc = await readFile(new URL("_workspace/sync-gate.sh", REPO), "utf8");
    // ★`gate`·`need`·`run` 은 실패를 **기록만** 한다 — 블록 rc 는 `gate_done`(또는 그 줄의 `|| exit`)이 만든다.
    //  §5 가 `gate_done` 없이 `git add -A` 로 끝나, 그 안의 게이트가 실패해도 블록이 rc=0 이었다(2026-10-25 적발).
    const recordsOnly = /^[ \t]*(gate|need|run)[ \t](?![^\n]*\|\|[ \t]*exit)/m;
    const unclosed = blocks.filter((b) => recordsOnly.test(b) && !/^[ \t]*gate_done\b/m.test(b));
    // ★`gate_done` 이 «있다» 로는 부족하다 — 그 뒤에 명령이 오면 블록 rc 는 그 명령의 것이다(`gate_done` 다음 `true` 한 줄로
    //  실패가 사라졌다 — GPT 검토 10-25). 마지막 명령이거나, 그 줄에서 `|| exit` 로 끊어야 한다.
    const effective = (b: string): string[] => b.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#") && l !== ")");
    const doneNotFinal = blocks.filter((b) => {
      const e = effective(b);
      const i = e.findIndex((l) => /^gate_done\b/.test(l));
      return i >= 0 && i !== e.length - 1 && !/^gate_done\s*\|\|\s*exit\b/.test(e[i]!);
    });

    const out: Assertion[] = [
      assert(
        "★실행 블록에 `set -euo pipefail` 이 **하나도 없다** — 이 경로에서 안 듣는 것에 기대지 않는다",
        withSetE.length === 0,
        `bash 블록 ${blocks.length}개 중 set -e 의존 ${withSetE.length}개`,
      ),
      assert(
        "★여러 명령을 잇는 블록은 **공유 헬퍼를 source 한다**",
        multi.length > 0 && sourced.length === multi.length,
        `다명령 블록 ${multi.length}개 · source 한 것 ${sourced.length}개`,
      ),
      assert(
        "★헬퍼가 **한 곳에만** 정의된다 — 블록마다 복사하면 §0~§4 가 뒤처진 그 사고가 다시 난다",
        // 스킬 본문이 `gate() {` 를 다시 정의하지 않는다.
        !/^\s*gate\(\) \{/m.test(skill) && /^gate\(\) \{/m.test(helperSrc),
        `스킬 안 재정의 ${/^\s*gate\(\) \{/m.test(skill)} · 헬퍼에 정의 ${/^gate\(\) \{/m.test(helperSrc)}`,
      ),
      assert(
        "★헬퍼로 실패를 기록하는 블록은 `gate_done`(또는 그 줄의 `|| exit`)으로 rc 를 만든다",
        unclosed.length === 0,
        `닫히지 않은 블록 ${unclosed.length}개${unclosed.map((b) => ` · «${b.split("\n").find((l) => recordsOnly.test(l))?.trim().slice(0, 60) ?? ""}»`).join("")}`,
      ),
      assert(
        "★`gate_done` 은 블록의 마지막 명령이거나 그 줄에서 `|| exit` 로 끊는다 — 뒤에 명령이 오면 실패가 그 rc 로 덮인다",
        doneNotFinal.length === 0,
        `어긋난 블록 ${doneNotFinal.length}개${doneNotFinal.map((b) => ` · «${effective(b).slice(-1)[0]?.slice(0, 60) ?? ""}»`).join("")}`,
      ),
    ];

    // ── ② 헬퍼를 **실제로 돌린다** ──────────────────────────────────────────
    if (process.platform === "win32") {
      out.push(skip("POSIX sync shell helper execution", "Developer sync-public shell harness uses POSIX absolute paths; static source checks above still run. POSIX execution required."));
      return out;
    }
    const helperPath = new URL("_workspace/sync-gate.sh", REPO).pathname;
    const fail = await sh(`. ${JSON.stringify(helperPath)}; gate 일부러 false; gate_done`);
    const ok = await sh(`. ${JSON.stringify(helperPath)}; gate 성공 true; need 참 [ 1 -eq 1 ]; gate_done`);
    const rcKept = await sh(`. ${JSON.stringify(helperPath)}; gate 코드7 sh -c 'exit 7'; true`);
    // ★**거짓 조건의 `need` 도 반드시 넣는다** — 참 조건만 재면 «항상 ✅» 로 바꿔도 통과한다
    //  (자기 변이 P6 에서 적발. 오늘 같은 표본 편향에 두 번 걸렸다).
    const needFalse = await sh(`. ${JSON.stringify(helperPath)}; need 거짓 [ 1 -eq 2 ]; gate_done`);
    out.push(
      assert(
        "★헬퍼가 실패를 **비영으로 만든다**(문장만 있고 안 도는 헬퍼를 막는다)",
        fail.rc !== 0,
        `실패 시나리오 rc=${fail.rc} · 출력에 🔴 ${/🔴/.test(fail.out)}`,
      ),
      assert(
        "성공 경로는 0으로 끝난다 — 상시 빨간 게이트는 아무도 안 본다",
        ok.rc === 0,
        `성공 시나리오 rc=${ok.rc}`,
      ),
      assert(
        "★`need` 가 **거짓 조건을 거짓으로** 본다 — 참만 재면 «항상 ✅» 를 못 잡는다",
        needFalse.rc !== 0 && /🔴 거짓/.test(needFalse.out),
        `거짓 need rc=${needFalse.rc} · 🔴 표기 ${/🔴 거짓/.test(needFalse.out)}`,
      ),
      assert(
        "★원래 rc 를 **그대로 보고한다** — `tail` 이 `$?` 를 덮어 rc=0 으로 찍던 것",
        /rc=7/.test(rcKept.out),
        `exit 7 보고: ${/rc=7/.test(rcKept.out) ? "rc=7" : rcKept.out.slice(0, 120)}`,
      ),
    );

    // ── ③ push·설치를 가르는 **실제 블록**을 돌린다(§6·R5·§7) ────────────────────
    //  ★헬퍼가 맞아도 블록이 그 rc 를 안 쓰면 소용없다 — §6 은 업데이트 검사 실패 뒤 push 했고, R5 는 CI 실패 뒤 main 에 push 했고,
    //   §7 은 `npm ci | tee | tail` 이 실패를 삼켜 «설치 검증 완료» 까지 갔다(GPT 검토 10-25 재현). 스텁으로 실패를 넣어 rc·이후 호출을 본다.
    //  (§5 의 대조·audit 는 `public-lock-matches-dev` 가 같은 방식으로 본다.)
    const repoRoot = new URL(".", REPO).pathname;
    const pushes = (r: { calls: string[] }, ref: string): number => r.calls.filter((c) => /^git .*\bpush\b/.test(c) && c.includes(ref)).length;
    const s6 = sectionBlock(skill, "6. ");
    const r5 = blockContaining(skill, "check-public-ci.mjs", "refs/heads/main");
    const s7 = sectionBlock(skill, "7. ");
    const s7boot = sectionBlock(skill, "7. ", 1);
    out.push(assert("§6·R5·§7 의 블록을 찾는다", s6 !== undefined && r5 !== undefined && s7 !== undefined && s7boot !== undefined,
      JSON.stringify({ s6: s6 !== undefined, r5: r5 !== undefined, s7: s7 !== undefined, s7boot: s7boot !== undefined })));
    if (s6 !== undefined && r5 !== undefined && s7 !== undefined && s7boot !== undefined) {
      const rel = { SYNC_MODE: "release" };
      const s6ok = await runSyncBlock(repoRoot, s6, {}, rel);
      const s6upd = await runSyncBlock(repoRoot, s6, { update: 7 }, rel);
      const s6push = await runSyncBlock(repoRoot, s6, { push: 1 });
      const s6commit = await runSyncBlock(repoRoot, s6, { commit: 7 });
      const s6synced = await runSyncBlock(repoRoot, s6, {}, { STUB_NOTHING_STAGED: "0" });
      const s6unpushed = await runSyncBlock(repoRoot, s6, {}, { STUB_NOTHING_STAGED: "0", STUB_REMOTE_DEV: "f".repeat(40) });
      const s6noRemote = await runSyncBlock(repoRoot, s6, { lsRemote: 2 }, { STUB_NOTHING_STAGED: "0" });
      // 릴리스인데 새로 실을 것이 없다(평소 싱크로 dev 에 이미 올렸다) — 그 HEAD 로 업데이트 경로를 재야 한다(10-25 독립 검토).
      const headSha = "c".repeat(40);
      const relSynced = { ...rel, STUB_NOTHING_STAGED: "0", STUB_HEAD: headSha, STUB_REMOTE_DEV: headSha };
      const s6relSynced = await runSyncBlock(repoRoot, s6, {}, relSynced);
      const s6relSyncedUpd = await runSyncBlock(repoRoot, s6, { update: 7 }, relSynced);
      const updateCalls = (r: { calls: string[] }): string[] => r.calls.filter((c) => /^bash \S*check-public-update\.sh /.test(c));
      const r5ok = await runSyncBlock(repoRoot, r5);
      const r5ci = await runSyncBlock(repoRoot, r5, { ci: 7 });
      const s7ok = await runSyncBlock(repoRoot, s7);
      const s7ci = await runSyncBlock(repoRoot, s7, { npmCi: 7 });
      const s7build = await runSyncBlock(repoRoot, s7, { build: 7 });
      const bootT = mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-bootT-"));
      mkdirSync(path.join(bootT, "app"));
      const bootEnv = { T: bootT };
      const s7bOk = await runSyncBlock(repoRoot, s7boot, {}, bootEnv);
      const s7bProd = await runSyncBlock(repoRoot, s7boot, { buildProd: 7 }, bootEnv);
      const s7bBoot = await runSyncBlock(repoRoot, s7boot, { boot: 7 }, bootEnv);
      rmSync(bootT, { recursive: true, force: true });
      const done = (r: { out: string }): boolean => /설치 검증 완료/.test(r.out);
      out.push(
        assert("§6 정상(릴리스 모드) — 업데이트 검사 뒤 dev 로 한 번 push · 0 · SYNC_SHA 출력",
          s6ok.rc === 0 && pushes(s6ok, "refs/heads/dev") === 1 && /SYNC_SHA=/.test(s6ok.out), `rc=${s6ok.rc} · push ${pushes(s6ok, "refs/heads/dev")}`),
        assert("★§6 업데이트 검사가 실패하면 push 하지 않고 비영으로 끝난다",
          s6upd.rc !== 0 && pushes(s6upd, "refs/heads/") === 0, `rc=${s6upd.rc} · push ${pushes(s6upd, "refs/heads/")}`),
        assert("★§6 push 가 실패하면 비영 — SYNC_SHA 를 «성공» 처럼 내지 않는다",
          s6push.rc !== 0 && !/SYNC_SHA=/.test(s6push.out), `rc=${s6push.rc}`),
        assert("★§6 commit 이 실패하면 push 하지 않고 비영 — SYNC_SHA 도 안 낸다",
          s6commit.rc !== 0 && pushes(s6commit, "refs/heads/") === 0 && !/SYNC_SHA=/.test(s6commit.out), `rc=${s6commit.rc} · push ${pushes(s6commit, "refs/heads/")}`),
        assert("§6 바꿀 것 없음 + HEAD = 원격 dev(평소 싱크) — «최신 상태» 로 0 · commit·push·업데이트 검사 없음",
          s6synced.rc === 0 && /최신 상태/.test(s6synced.out) && pushes(s6synced, "refs/heads/") === 0 && !s6synced.calls.some((c) => / commit /.test(c)) &&
            updateCalls(s6synced).length === 0,
          `rc=${s6synced.rc} · ${s6synced.out.trim().split("\n").slice(-1)[0]?.slice(0, 80) ?? ""}`),
        assert("★§6 바꿀 것 없음인데 HEAD ≠ 원격 dev(미전송 커밋) — «최신 상태» 가 아니라 비영",
          s6unpushed.rc !== 0 && !/최신 상태/.test(s6unpushed.out) && pushes(s6unpushed, "refs/heads/") === 0,
          `rc=${s6unpushed.rc} · ${s6unpushed.out.trim().split("\n").slice(-1)[0]?.slice(0, 80) ?? ""}`),
        assert("★§6 바꿀 것 없음인데 원격 dev 조회가 실패 — «최신 상태» 가 아니라 비영 · commit·push·SYNC_SHA 없음",
          s6noRemote.rc !== 0 && !/최신 상태/.test(s6noRemote.out) && pushes(s6noRemote, "refs/heads/") === 0 &&
            !s6noRemote.calls.some((c) => / commit /.test(c)) && !/SYNC_SHA=/.test(s6noRemote.out),
          `rc=${s6noRemote.rc} · ${s6noRemote.out.trim().split("\n").slice(-1)[0]?.slice(0, 80) ?? ""}`),
        assert("★§6 릴리스인데 바꿀 것 없음(HEAD = 원격 dev) — 그 HEAD 로 업데이트 경로 검사 1회 뒤 0 · SYNC_SHA=HEAD · commit·push 없음",
          s6relSynced.rc === 0 && updateCalls(s6relSynced).length === 1 && updateCalls(s6relSynced)[0]!.includes(` ${headSha} `) &&
            s6relSynced.out.includes(`SYNC_SHA=${headSha}`) && pushes(s6relSynced, "refs/heads/") === 0 && !s6relSynced.calls.some((c) => / commit /.test(c)),
          `rc=${s6relSynced.rc} · 검사 ${JSON.stringify(updateCalls(s6relSynced))} · ${s6relSynced.out.trim().split("\n").slice(-1)[0]?.slice(0, 80) ?? ""}`),
        assert("★§6 릴리스인데 바꿀 것 없음 + 업데이트 검사 실패 — 비영 · SYNC_SHA 없음 · push 없음",
          s6relSyncedUpd.rc !== 0 && !/SYNC_SHA=/.test(s6relSyncedUpd.out) && pushes(s6relSyncedUpd, "refs/heads/") === 0,
          `rc=${s6relSyncedUpd.rc} · ${s6relSyncedUpd.out.trim().split("\n").slice(-1)[0]?.slice(0, 80) ?? ""}`),
        assert("R5 정상 — CI 확인 뒤 main 으로 한 번 push · 0", r5ok.rc === 0 && pushes(r5ok, "refs/heads/main") === 1, `rc=${r5ok.rc} · push ${pushes(r5ok, "refs/heads/main")}`),
        assert("★R5 CI 확인이 실패하면 main 에 push 하지 않고 비영", r5ci.rc !== 0 && pushes(r5ci, "refs/heads/main") === 0, `rc=${r5ci.rc} · push ${pushes(r5ci, "refs/heads/main")}`),
        assert("§7 설치 정상 — 0 · «설치 검증 완료»", s7ok.rc === 0 && done(s7ok), `rc=${s7ok.rc} · ${s7ok.out.trim().split("\n").slice(-1)[0]?.slice(0, 100) ?? ""}`),
        assert("★§7 npm ci 가 실패하면 비영 — «설치 검증 완료» 까지 가지 않는다", s7ci.rc !== 0 && !done(s7ci), `rc=${s7ci.rc} · 완료 표시 ${done(s7ci)}`),
        assert("★§7 build 가 실패하면 비영 — «설치 검증 완료» 까지 가지 않는다", s7build.rc !== 0 && !done(s7build), `rc=${s7build.rc} · 완료 표시 ${done(s7build)}`),
        assert("§7 부팅 정상 — 0", s7bOk.rc === 0, `rc=${s7bOk.rc}`),
        assert("★§7 build:prod 가 실패하면 부팅 검사로 가지 않고 비영",
          s7bProd.rc !== 0 && !s7bProd.calls.some((c) => c.includes("check-public-boot")), `rc=${s7bProd.rc}`),
        assert("★§7 부팅 검사가 실패하면 비영", s7bBoot.rc !== 0, `rc=${s7bBoot.rc}`),
      );
    }
    // ── ④ 하네스가 rc 를 **지어내지 않는다** — 시한 초과·실행 실패를 -1·1 로 바꿔 돌려주면 «실패하면 비영» 이 멈춘 게이트에도 초록이다(10-25 독립 검토).
    //  (Windows 는 위 ②에서 이미 돌아갔다 — 여기는 POSIX 만 온다.)
    const hung = await runSyncBlock(new URL(".", REPO).pathname, "sleep 5", {}, {}, 300).then(
      (r) => `resolved rc=${r.rc}`,
      (e: unknown) => `rejected:${String((e as Error)?.message ?? e).slice(0, 60)}`,
    );
    const spawnFail = (() => {
      try {
        return `rc=${exitCodeOf(Object.assign(new Error("spawn"), { code: "ENOENT" }), "없는 명령")}`;
      } catch (e) {
        return `threw:${String((e as Error).message).slice(0, 40)}`;
      }
    })();
    // 실행·판정의 한 곳(`execRc` — 헬퍼 `sh`·lock 도구 `run`·블록 모두 이것만 부른다)을 직접: 시한 초과 · 없는 실행 파일.
    const rejectOf = (p: Promise<{ rc: number }>): Promise<string> =>
      p.then((r) => `resolved rc=${r.rc}`, (e: unknown) => `rejected:${String((e as Error)?.message ?? e).slice(0, 60)}`);
    const execHung = await rejectOf(execRc("/bin/zsh", ["-c", "sleep 5"], { timeout: 300 }, "시한 시험"));
    const execMissing = await rejectOf(execRc("/nonexistent/tiguclaw-regression-bin", [], { timeout: 5_000 }, "없는 실행 파일"));
    const execNonzero = await rejectOf(execRc("/bin/zsh", ["-c", "exit 7"], { timeout: 5_000 }, "비영 시험"));
    out.push(assert("★싱크 블록이 시한을 넘기거나 실행 자체가 실패하면 rc 를 내지 않고 거절한다(비영 판정으로 삼키지 않는다)",
      hung.startsWith("rejected:") && spawnFail.startsWith("threw:"), JSON.stringify({ hung, spawnFail })),
      assert("★실행 한 곳(execRc) — 시한 초과·없는 실행 파일은 거절 · 진짜 비영은 그 rc 그대로",
        execHung.startsWith("rejected:") && execMissing.startsWith("rejected:") && execNonzero === "resolved rc=7",
        JSON.stringify({ execHung, execMissing, execNonzero })),
    );
    // 래퍼가 판정을 따로 들지 않는다 — 두 래퍼가 `execRc` 만 부르는지(«숫자 아니면 -1·1» 이 되살아나면 위 단언이 그 자리를 못 본다).
    const lockSrc = await readFile(new URL("src/scripts/regression/public-lock-matches-dev.ts", REPO), "utf8");
    const selfSrc = await readFile(new URL("src/scripts/regression/sync-gates-check-rc.ts", REPO), "utf8");
    const wrapperOk = (src: string, name: string): boolean => new RegExp(`const ${name} = \\([^)]*\\)[^=]*=>\\s*execRc\\(`).test(src) && !/\bexecFile\(/.test(src);
    out.push(assert("래퍼(`sh`·`run`)는 실행·판정을 `execRc` 한 곳에 맡기고 `execFile` 을 직접 부르지 않는다",
      wrapperOk(selfSrc, "sh") && wrapperOk(lockSrc, "run"), JSON.stringify({ sh: wrapperOk(selfSrc, "sh"), run: wrapperOk(lockSrc, "run") })));
    return out;
  },
};
