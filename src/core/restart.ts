// src/core/restart.ts
/**
 * 크로스플랫폼 데몬 재시작 — supervisor 유무와 무관하게 "새 데몬이 반드시 다시 뜨게".
 *
 * 배경(버그): restartDaemon(index.ts)은 graceful exit 후 supervisor(launchd KeepAlive·
 *  systemd Restart=always)의 respawn 에 의존한다. mac/linux 는 정상이지만 **Windows 는
 *  HKCU Run(로그온 전용, supervisor 없음)** 이라 종료만 하고 안 살아난다.
 *
 * 해결: supervisor 가 없는 OS(현재 win32)에서는 graceful exit 전에 **분리(detached)
 *  재기동을 보장**한다. 검증된 `daemon.ts restart`(taskkill 로 옛 데몬·포트 확실히 비운
 *  뒤 wscript 숨김 VBS 로 새 데몬 기동 — 포트 race 처리 포함)를 detached 서브프로세스로
 *  spawn 한다. 부모가 죽어도 서브프로세스는 생존하며, 자기가 옛 데몬을 taskkill 해
 *  단일 데몬만 남는다(이중 데몬·봇 폴링 충돌 0).
 *
 * 재사용 우선: 새 재시작 로직을 또 짜지 않고 daemon.ts 의 OS별 검증 경로(win32=winRestart)
 *  를 그대로 호출한다. TIGUCLAW_SERVICE_LABEL·TIGUCLAW_HOME env 를 상속해 *올바른
 *  인스턴스* 를 타겟한다.
 *
 * import 위생: index→이 코어 모듈(core 방향) 단방향. daemon.ts(CLI 스크립트, 직접
 *  실행 시 side effect)를 import 하지 않고 서브프로세스로 격리 spawn 한다.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { appRoot } from "./paths.js";

/**
 * 현 OS 가 supervisor(자동 respawn) 위에서 도는가.
 *  - darwin = launchd KeepAlive=true → respawn O
 *  - linux  = systemd Restart=always → respawn O
 *  - win32  = HKCU Run(로그온 전용) → respawn X ← graceful exit 만으론 안 살아남
 *  - 기타   = 알 수 없음 → 보수적으로 detached 재기동 시도(있으면 이득, 없어도 exit 진행)
 */
export const hasSupervisorRespawn = (): boolean =>
  process.platform === "darwin" || process.platform === "linux";

/**
 * supervisor 없는 OS 에서 "분리 재기동" 보장.
 *
 * 반환 true = detached `daemon.ts restart` 를 띄웠다(이 서브프로세스가 taskkill 로
 *  옛 데몬·포트를 비운 뒤 새 데몬 기동). 호출측은 이 경우 graceful exit 를 *생략* 해도
 *  된다(서브프로세스의 taskkill 이 종료까지 처리). 반환 false = spawn 실패 → 호출측은
 *  최소한 graceful exit 로 종료를 보장해야 한다(견고성).
 *
 * 데몬은 prod·dev 모두 launchd plist/systemd unit/VBS 런처에서 `node tsx --env-file=.env
 *  src/index.ts` 로 도므로(buildCtx.entry 참조), 같은 src 트리의 `src/scripts/daemon.ts`
 *  를 동일 tsx 러너로 실행한다. appRoot()=레포 루트(이 src 런타임에서 cwd 동치).
 */
export const spawnDetachedRestart = (source: string): boolean => {
  const repoRoot = appRoot();
  const nodePath = process.execPath;
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const daemonScript = path.join(repoRoot, "src", "scripts", "daemon.ts");

  try {
    const child = spawn(
      nodePath,
      [tsxCli, "--env-file=.env", daemonScript, "restart"],
      {
        cwd: repoRoot,
        // TIGUCLAW_SERVICE_LABEL·TIGUCLAW_HOME·HTTP_BRIDGE_PORT 등 상속 → 올바른 인스턴스 타겟.
        env: process.env,
        detached: true, // 부모(현 데몬)가 죽어도 생존.
        stdio: "ignore",
        windowsHide: true,
      },
    );
    // 부모 이벤트 루프가 이 자식을 붙잡지 않게 분리(부모는 곧 exit).
    child.unref();
    console.log(
      `daemon: detached restart spawned (${source}) — daemon.ts restart 가 옛 데몬 종료 후 재기동`,
    );
    return true;
  } catch (err) {
    console.error(
      `daemon: detached restart spawn 실패 (${source}) — graceful exit 로 폴백:`,
      err,
    );
    return false;
  }
};
