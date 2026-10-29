/**
 * 회귀 공용 — **sync-public 스킬의 실제 bash 블록을 꺼내 스텁 명령으로 돌린다** (2026-10-25).
 *
 * 왜: 블록 안에 명령이 «있다» 를 세는 검사는 그 명령의 실패가 블록 rc 로 «전해진다» 를 못 본다 — `gate_done` 뒤에 `true` 를
 *  붙이거나 `cmd | tee | tail` 로 쓰면 글자는 그대로인데 실패가 삼켜진다(GPT 검토 10-25 — §6·§7·R5 재현). 그래서 블록 본문을 그대로
 *  실행하되 `npm`·`node`·`git`·`bash` 만 셸 함수로 바꿔 끼우고(실제 설치·push·clone 없음), 실패를 하나씩 넣어 rc 와 이후 호출을 본다.
 * 헬퍼(`_workspace/sync-gate.sh`)는 **진짜**를 쓴다 — 그것이 판정의 일부다.
 * ★POSIX 전용(zsh) — Windows 에선 호출부가 건너뛴다.
 */
import { execFile, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `execFile` 결과의 종료 코드. ★시한 초과(신호로 죽음)·spawn 실패(문자열 코드)는 «비영» 이 아니라 **던진다** — 호출부의 «실패하면 비영»
 *  단언이 `rc !== 0` 만 보므로, 숫자가 아닌 끝을 -1·1 로 바꿔 돌려주면 **게이트가 멈춰도 초록**이었다(독립 검토 10-25).
 */
export const exitCodeOf = (err: ExecFileException | null, what: string): number => {
  if (err === null) return 0;
  if (typeof err.code === "number") return err.code;
  throw new Error(`${what} — 종료 코드 없이 끝났다(${err.killed === true ? "시한 초과" : "실행 실패"} · ${String(err.code ?? err.signal ?? "?")}). 판정하지 않는다`);
};

/**
 * 명령 하나를 돌려 `{ rc, out }` — 싱크 게이트 회귀의 실행·판정은 **여기 한 곳**이다(블록·헬퍼·lock 도구 모두). 숫자 아닌 끝은 거절한다
 *  (`exitCodeOf`). `onDone` 은 판정 전에 출력으로 뒷정리할 때(결과와 무관하게 한 번).
 *  ★한 곳인 이유: 세 래퍼가 각자 «숫자 아니면 -1·1» 을 들고 있었고, 하나를 고쳐도 나머지가 그대로였다(10-25 GPT 검토).
 */
export const execRc = (
  file: string,
  args: readonly string[],
  opts: ExecFileOptions,
  what: string,
  onDone?: (out: string) => void,
): Promise<{ rc: number; out: string }> =>
  new Promise((res, rej) => {
    execFile(file, [...args], { ...opts, encoding: "utf8" }, (err, so, se) => {
      const out = `${String(so)}${String(se)}`;
      try {
        onDone?.(out);
        res({ rc: exitCodeOf(err, what), out });
      } catch (e) {
        rej(e);
      }
    });
  });

/** `### <heading>` 절(다음 `### `·`## ` 전까지) 안의 `nth` 번째 bash 블록. 못 찾으면 undefined(호출부가 실패로 단언한다). */
export const sectionBlock = (md: string, heading: string, nth = 0): string | undefined => {
  const at = md.indexOf(`\n### ${heading}`);
  if (at < 0) return undefined;
  const rest = md.slice(at + 1);
  const end = rest.slice(4).search(/\n#{2,3} /);
  const section = end < 0 ? rest : rest.slice(0, end + 4);
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)][nth]?.[1];
};

/** 절 제목이 없는 자리(릴리스 R5 처럼 목록 안)용 — 모든 조각을 담은 bash 블록이 **정확히 하나**일 때만 돌려준다. */
export const blockContaining = (md: string, ...needles: string[]): string | undefined => {
  const hits = [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? "").filter((b) => needles.every((n) => b.includes(n)));
  return hits.length === 1 ? hits[0] : undefined;
};

/**
 * 실패를 넣을 자리 — 값은 그 스텁의 종료 코드. git 상태는 `env` 로 준다: `STUB_NOTHING_STAGED=0`(인덱스 비었음) ·
 *  `STUB_HEAD`(rev-parse HEAD) · `STUB_REMOTE_DEV`(ls-remote dev) — 기본은 «바뀐 것 있음 · HEAD = 원격 dev = SYNC_SHA».
 */
export type SyncStubFail = Partial<Record<"npmCi" | "audit" | "build" | "buildProd" | "typecheck" | "lock" | "ci" | "boot" | "update" | "commit" | "push" | "lsRemote", number>>;

const STUBS = `
_log() { print -r -- "$*" >> "$STUB_LOG"; }
npm() {
  _log "npm $*"
  case "$1" in
    ci) return \${F_npmCi:-0} ;;
    audit) return \${F_audit:-0} ;;
    run) case "$2" in build) return \${F_build:-0} ;; build:prod) return \${F_buildProd:-0} ;; typecheck) return \${F_typecheck:-0} ;; esac ;;
  esac
  return 0
}
node() {
  _log "node $*"
  case "$1" in
    *check-public-lock.mjs) return \${F_lock:-0} ;;
    *check-public-ci.mjs) return \${F_ci:-0} ;;
    *check-public-boot.mjs) return \${F_boot:-0} ;;
  esac
  echo STUB_OK
  return 0
}
bash() {
  _log "bash $*"
  case "$1" in *check-public-update.sh) return \${F_update:-0} ;; esac
  return 0
}
git() {
  _log "git $*"
  local -a a; a=("$@")
  [ "$1" = -C ] && a=("\${@:3}")
  case "\${a[1]}" in
    clone) mkdir -p "\${a[-1]}"; return 0 ;;
    rev-parse) echo "\${STUB_HEAD:-$SYNC_SHA}"; return 0 ;;
    commit) return \${F_commit:-0} ;;
    push) return \${F_push:-0} ;;
    ls-remote) [ "\${F_lsRemote:-0}" -ne 0 ] && return \${F_lsRemote}; printf '%s\\trefs/heads/dev\\n' "\${STUB_REMOTE_DEV:-$SYNC_SHA}"; return 0 ;;
    diff) [[ " \${a[*]} " == *" --quiet "* ]] && return \${STUB_NOTHING_STAGED:-1}; return 0 ;;
  esac
  return 0
}
`;

/**
 * 블록 하나를 격리된 가짜 DEV·PUB 로 돌린다. 반환 = rc · 출력 · 스텁 호출 기록(한 줄 = 한 호출).
 * `env` 로 SYNC_MODE·T 등 블록이 요구하는 값을 더 준다(DEV·PUB·SYNC_SHA·UPDATE_FROM_TAG 는 기본으로 채운다).
 * ★시한을 넘기거나 셸을 못 띄우면 rc 를 지어내지 않고 **거절한다**(`exitCodeOf`).
 */
export const runSyncBlock = async (
  repoRoot: string,
  block: string,
  fail: SyncStubFail = {},
  env: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<{ rc: number; out: string; calls: string[] }> => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tiguclaw-regression-syncblock-"));
  const dev = path.join(tmp, "dev");
  const pub = path.join(tmp, "pub");
  mkdirSync(path.join(dev, "_workspace"), { recursive: true });
  mkdirSync(pub);
  mkdirSync(path.join(tmp, "gatelog"));
  copyFileSync(path.join(repoRoot, "_workspace", "sync-gate.sh"), path.join(dev, "_workspace", "sync-gate.sh"));
  const log = path.join(tmp, "calls.log");
  writeFileSync(log, "");
  const script = path.join(tmp, "block.zsh");
  writeFileSync(script, `${STUBS}\n${block}\n`);
  const vars: Record<string, string> = {
    ...process.env as Record<string, string>,
    DEV: dev,
    PUB: pub,
    SYNC_SHA: "0123456789abcdef0123456789abcdef01234567",
    UPDATE_FROM_TAG: "v0.0.0-regression",
    STUB_LOG: log,
    GATE_LOG: path.join(tmp, "gatelog"),
    ...Object.fromEntries(Object.entries(fail).map(([k, v]) => [`F_${k}`, String(v)])),
    ...env,
  };
  let calls: string[] = [];
  const r = await execRc("/bin/zsh", [script], { env: vars, timeout: timeoutMs }, "싱크 블록", (out) => {
    calls = readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
    // §7 설치 블록은 자기 임시 경로(`${TMPDIR:-/tmp}/tiguclaw-cleanroom.XXXX`)를 만든다 — 이 실행이 만든 것만 지운다.
    //  ★줄 전체를 잡고 «이름 꼴 · 블록이 본 TMPDIR 바로 아래» 가 둘 다 맞을 때만 지운다 — 종전 `/tmp/…` 정규식은 고정되지 않아
    //  `/private/tmp/tiguclaw-cleanroom.X` 같은 경로의 접미만 잡아 다른 자리의 /tmp 를 지우려 했고, TMPDIR 아래 것은 못 지웠다.
    const made = /^검증 경로: (\/.*)$/m.exec(out)?.[1];
    const at = made === undefined ? undefined : path.resolve(made);
    if (
      at !== undefined &&
      /^tiguclaw-cleanroom\.[A-Za-z0-9]+$/.test(path.basename(at)) &&
      existsSync(at) &&
      realpathSync(path.dirname(at)) === realpathSync(vars.TMPDIR || "/tmp")
    ) rmSync(at, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });
  return { ...r, calls };
};
