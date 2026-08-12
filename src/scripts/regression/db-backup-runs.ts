/**
 * 회귀: **데이터가 백업된다 — 조용히, 그리고 실패할 때만 말한다.**
 *
 * 사고 (2026-08-11): `<home>/data/tiguclaw.db` 한 파일에 기억·세션·대화가 전부 있는데
 *  **백업이 하나도 없었다.** 크기·성능은 몇 년 뒤 문제지만 백업은 처음부터 문제다 —
 *  없어진 뒤엔 되돌릴 방법이 없다.
 *
 * ★`cp` 가 아니라 `VACUUM INTO` 인 이유가 이 검사의 절반이다: WAL 모드라 최신 내용이
 *  `-wal` 에 따로 있어 **파일만 복사하면 깨지거나 옛 상태**가 나온다. 그래서 "백업이
 *  있다" 가 아니라 **"그 사본이 실제로 열리고 내용이 있다"** 를 본다 — 있는데 못 여는
 *  백업은 없는 것보다 나쁘다(있다고 믿게 만든다).
 *
 * ★그리고 소음을 본다: 상태형 지표("백업이 없다")는 고쳐질 때까지 계속 참이라 매 스윕
 *  뜨면 배경 소음이 된다. 이 레포가 이미 데인 형상이라(같은 warn 이 12일 묻힘) 자원 축은
 *  하루 1회로 묶여 있어야 한다.
 */
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Assertion, RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-backup-"));
  try {
    // ── ① VACUUM INTO 로 뜬 사본이 **실제로 열리고 내용이 있다** ──────────
    //  WAL 에만 있는 내용이 사본에 담기는지가 핵심 — `cp` 였다면 여기서 빠진다.
    const src = path.join(dir, "src.db");
    const db = new Database(src);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 500; i++) ins.run(`row-${i}`);
    // ★체크포인트를 일부러 안 한다 — 최신 쓰기가 WAL 에 남은 상태를 재현한다.
    const dst = path.join(dir, "backup.db");
    db.prepare("VACUUM INTO ?").run(dst);

    let copied = -1;
    let readable = false;
    try {
      const b = new Database(dst, { readonly: true });
      copied = (b.prepare("SELECT count(*) n FROM t").get() as { n: number }).n;
      readable = true;
      b.close();
    } catch {
      /* 못 열면 readable=false 로 남는다 */
    }
    out.push({
      name: "★백업 사본이 열리고 WAL 에 있던 최신 쓰기까지 담긴다(cp 였다면 빠진다)",
      ok: readable && copied === 500,
      got: `열림=${readable} · 행 ${copied}/500`,
    });

    // ── ② 원본은 그대로 (백업이 원본을 건드리지 않는다) ─────────────────────
    const stillThere = (db.prepare("SELECT count(*) n FROM t").get() as { n: number }).n;
    out.push({
      name: "원본은 손대지 않는다",
      ok: stillThere === 500,
      got: `원본 ${stillThere}행`,
    });
    db.close();

    // ── ③ 사본이 원본과 **다른 파일**이고 비어 있지 않다 ────────────────────
    out.push({
      name: "사본이 실제 파일로 남는다",
      ok: existsSync(dst) && readdirSync(dir).length >= 2,
      got: `${readdirSync(dir).filter((f) => f.endsWith(".db")).join(", ")}`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ── ④ 배선 — 실행은 store 가, 시계는 **코어**가 (관측자≠행위자) ─────────
  //  ★2026-08-12: 시계를 self-growth 플러그인에서 코어로 옮겼다. 플러그인 로더는 로드
  //   실패를 조용히 skip 하므로, 성장 기능이 안 뜨면 백업까지 함께 멎던 구조였다.
  {
    const { readFile } = await import("node:fs/promises");
    const bk = await readFile(new URL("../../store/backup.ts", import.meta.url), "utf8");
    const sg = await readFile(
      new URL("../../core/self-maintenance.ts", import.meta.url),
      "utf8",
    );
    const hl = await readFile(
      new URL("../../core/health-sweep.ts", import.meta.url),
      "utf8",
    );
    const daemon = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const plugin = await readFile(
      new URL("../../../plugins/self-growth/src/index.ts", import.meta.url),
      "utf8",
    );
    // ★주석을 빼고 본다 — 이 파일의 주석에 "cp 가 아니라 VACUUM INTO 인 이유" 가 적혀
    //  있어서, 실행부를 cp 로 바꿔도 정규식이 그 주석에 걸려 통과했다(변이가 잡아줬다).
    //  **검사 대상은 코드이지 그것을 설명하는 글이 아니다** — 이 레포에서 세 번째다.
    const codeOnly = (src: string): string =>
      src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    const bkCode = codeOnly(bk);
    const usesVacuum = /prepare\(\s*`VACUUM INTO/.test(bkCode);
    const usesCopy = /copyFileSync|createReadStream/.test(bkCode);
    out.push({
      name: "★백업은 VACUUM INTO 로 뜬다(파일 복사면 WAL 때문에 깨진 사본이 된다)",
      ok: usesVacuum && !usesCopy,
      got: `VACUUM INTO=${usesVacuum} · 파일복사=${usesCopy}`,
    });
    out.push({
      name: "실행은 store 에만 — 자가 진단(health.ts)은 감지만 한다",
      ok: !/prepare\(\s*`VACUUM INTO|copyFileSync/.test(codeOnly(hl)),
      got: `health.ts 에 실행 있음=${/VACUUM INTO|copyFileSync/.test(codeOnly(hl))}`,
    });
    out.push({
      name: "유지보수 시계가 백업을 부른다",
      ok: /runBackupIfDue\(\)/.test(sg) && /runBackup\(bus\)/.test(sg),
      got: `호출=${/runBackupIfDue\(\)/.test(sg)}`,
    });
    // ★핵심 — 백업·진단이 **플러그인과 무관하게** 돈다. 이게 이 이관의 이유다.
    out.push({
      name: "★시계가 코어에 있고 데몬이 직접 건다(플러그인이 안 떠도 백업은 돈다)",
      ok: /startSelfMaintenance\(bus\)/.test(daemon),
      got: /startSelfMaintenance\(bus\)/.test(daemon)
        ? "데몬이 직접 시작"
        : "★데몬이 안 걸었다 — 아무도 백업을 부르지 않는다",
    });
    out.push({
      name: "★성장 플러그인엔 백업 시계가 남아 있지 않다(두 곳에서 돌면 안 된다)",
      ok: !/runBackupIfDue/.test(plugin) && !/runHealthSweep/.test(plugin),
      got: `plugin 잔여: backup=${/runBackupIfDue/.test(plugin)} sweep=${/runHealthSweep/.test(plugin)}`,
    });
    out.push({
      name: "호출부는 알림 여부를 스스로 정하지 않는다(판정은 store)",
      ok: /backupNotice\(r\)/.test(sg),
      got: `backupNotice 위임=${/backupNotice\(r\)/.test(sg)}`,
    });
    out.push({
      name: "★상태형 지표는 하루 1회로 묶인다(매 스윕 뜨면 배경 소음)",
      ok: /RESOURCE_REPORT_INTERVAL_MS/.test(hl) && /lastResourceReportTs/.test(hl),
      got: `게이트=${/RESOURCE_REPORT_INTERVAL_MS/.test(hl)}`,
    });
  }

  // ── ⑤ ★알림 판정을 **실행해서** 지킨다 ──────────────────────────────────
  //  종전엔 이 규칙을 소스 정규식으로 봤는데 **뚫렸다** — 성공 경로 뒤에 보고를 한 줄
  //  끼워 넣었더니 정규식 창 밖이라 못 봤다(변이 테스트가 잡아줬다). 판정을 순수 함수로
  //  뽑았으니 이제 돌려서 확인한다.
  {
    const { backupNotice } = await import("../../store/backup.js");
    const cases: Array<[string, unknown, "말한다" | "침묵"]> = [
      ["아직 때 아님", { ran: false }, "침묵"],
      ["★평소 성공", { ran: true, file: "a.db", bytes: 1, first: false }, "침묵"],
      ["첫 벌", { ran: true, file: "a.db", bytes: 1, first: true }, "말한다"],
      ["실패", { ran: true, error: "disk full" }, "말한다"],
    ];
    const bad = cases.filter(([, v, want]) => {
      const got = backupNotice(v as never) === null ? "침묵" : "말한다";
      return got !== want;
    });
    out.push({
      name: "★성공은 침묵 · 첫 벌과 실패만 알린다(매일 알림 = 배경 소음)",
      ok: bad.length === 0,
      got:
        bad.length === 0
          ? `${cases.length}종 전부 기대대로`
          : `🔴 어긋남: ${bad.map(([n]) => n).join(", ")}`,
    });
    const err = backupNotice({ ran: true, error: "disk full" } as never);
    out.push({
      name: "실패 알림에 원인이 실린다(무슨 일인지 알 수 있게)",
      ok: typeof err === "string" && err.includes("disk full"),
      got: String(err).slice(0, 60),
    });
  }

  // ── ⑥ 끄는 수단이 있고, 기본은 켜짐 ────────────────────────────────────
  //  ★기본 켜짐인 이유: 안 하고 있다가 필요할 때 없으면 끝나는 종류다. 그래도 사용자가
  //   끌 수 있어야 한다(자동 조치의 조건: 통보 + 끌 수단).
  {
    const { readFile } = await import("node:fs/promises");
    const bk = await readFile(new URL("../../store/backup.ts", import.meta.url), "utf8");
    const idx = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    // ★설정을 **실제로 돌려서** 확인한다 (2026-08-12, 사용자: "자동 백업 할 건지는
    //  설정에 두자 · 기본은 켜있는걸로"). 종전엔 소스 정규식뿐이라 동의어 하나로 뚫렸다.
    {
      const { backupEnabled } = await import("../../store/backup.js");
      const { getPaths } = await import("../../core/paths.js");
      const settings = getPaths().settings;
      const { writeFileSync, readFileSync, existsSync: exists, rmSync: rm } = await import(
        "node:fs"
      );
      const had = exists(settings);
      const before = had ? readFileSync(settings, "utf8") : null;
      try {
        if (had) rm(settings, { force: true });
        const onByDefault = backupEnabled(); // 설정 파일 자체가 없을 때.
        writeFileSync(settings, JSON.stringify({ backup: {} }), "utf8");
        const onWhenUnset = backupEnabled(); // 키만 없을 때.
        writeFileSync(settings, JSON.stringify({ backup: { enabled: false } }), "utf8");
        const offWhenFalse = backupEnabled();
        writeFileSync(settings, JSON.stringify({ backup: { enabled: true } }), "utf8");
        const onWhenTrue = backupEnabled();
        out.push({
          name: "★기본은 켜짐 — 설정이 없어도, 키가 없어도 백업한다",
          ok: onByDefault && onWhenUnset,
          got: `설정없음=${onByDefault} 키없음=${onWhenUnset} (둘 다 true 여야)`,
        });
        out.push({
          name: "★설정으로 끌 수 있다 — 명시 false 일 때만 꺼진다",
          ok: !offWhenFalse && onWhenTrue,
          got: `enabled:false=${offWhenFalse} enabled:true=${onWhenTrue}`,
        });
      } finally {
        if (before !== null) writeFileSync(settings, before, "utf8");
        else rm(settings, { force: true });
      }
    }
    out.push({
      name: "끄는 설정이 store(소유자)에 산다 — 시계가 자기 판단을 갖지 않는다",
      ok: /backup\b[\s\S]{0,200}?enabled/.test(bk) && /!== false/.test(bk),
      got: `설정 읽기=${/backupEnabled/.test(bk)} · 기본 켜짐(명시 false 만)=${/!== false/.test(bk)}`,
    });
    out.push({
      name: "★상태는 밀지 않고 /status 에서 본다(알림은 놓치면 끝이다)",
      ok: /backupInfo\(\)/.test(idx) && /백업:/.test(idx),
      got: `/status 줄=${/백업:/.test(idx)}`,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "db-backup-runs",
  guards:
    "기억·세션·대화가 전부 든 DB 에 백업이 하나도 없던 것 + cp 로 뜨면 WAL 때문에 깨진 사본이 나오는 것 + '백업이 없다' 같은 상태형 경고가 매 시간 떠서 배경 소음이 되는 것",
  run,
};
