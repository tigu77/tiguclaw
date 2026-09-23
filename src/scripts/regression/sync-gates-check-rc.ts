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
import { execFile } from "node:child_process";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = new URL("../../../", import.meta.url);

/** 스킬 본문의 ```bash 펜스 안쪽만 — 설명 문장을 코드로 세지 않는다. */
const bashBlocks = (md: string): string[] => {
  const out: string[] = [];
  const re = /```bash\n([\s\S]*?)```/g;
  for (const m of md.matchAll(re)) out.push(m[1] ?? "");
  return out;
};

const sh = (script: string): Promise<{ rc: number; out: string }> =>
  new Promise((res) => {
    execFile("/bin/zsh", ["-c", script], { timeout: 20_000 }, (err, so, se) =>
      res({ rc: err === null ? 0 : ((err as { code?: number }).code ?? 1), out: `${so}${se}` }),
    );
  });

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
    return out;
  },
};
