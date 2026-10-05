/** Windows 시작 계약·로그·보존 롤백. OS/네트워크/모델 부작용은 전부 fake, 파일은 임시 홈만. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Assertion, type RegressionCheck } from "./_framework.js";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const checks: Assertion[] = [];
const test = (name: string, fn: () => void) => {
  try { fn(); checks.push({ name, ok: true, got: "확인" }); }
  catch (err) { checks.push({ name, ok: false, got: String(err) }); }
};
export const check: RegressionCheck = { guards: "Windows 업데이트 후 별도 인스턴스 환경 유실과 무통지 실패 로그 소실", name: "windows-update-environment", run: async () => {
  const daemonUrl = new URL("../../../bin/daemon.mjs", import.meta.url).href;
  const d: any = await import(daemonUrl);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tigu-win-update-"));
  try {
    const c = { homeAbs: home, homeRaw: home, label: "inspection.7020", repoRoot: repo,
      nodePath: process.execPath, runtime: "built", logsDir: path.join(home, "logs"),
      distEntry: path.join(home, "dist-entry.js"), pidFile: path.join(home, "daemon.pid") };
    test("기본 인스턴스: 저장본 없는 홈은 환경을 덮지 않는다", () => {
      const env = { DASHBOARD_PORT: "7010", HTTP_BRIDGE_PORT: "7011" };
      d.applyWinServiceEnv(home, env); assert.deepEqual(env, { DASHBOARD_PORT: "7010", HTTP_BRIDGE_PORT: "7011" });
    });
    const env = { HTTP_BRIDGE_PORT: "7021", DASHBOARD_PORT: "7020", HTTP_BRIDGE_HOST: "127.0.0.1",
      USERPROFILE: "C:\\isolated profile", HOME: "C:\\isolated profile", CODEX_HOME: "C:\\isolated profile\\.codex",
      CLAUDE_CONFIG_DIR: "C:\\isolated profile\\.claude", PATH: "C:\\node24;C:\\npm;C:\\Windows",
      npm_config_userconfig: "C:\\empty.npmrc", npm_config_globalconfig: "C:\\empty-global.npmrc",
      HTTP_BRIDGE_TOKEN: "do-not-persist-test-token", CLAUDE_CODE_OAUTH_TOKEN: "do-not-persist-test-oauth",
      TIGUCLAW_UPDATE_PREV_SHA: "one-shot-sha", UNRELATED_VALUE: "not-persisted" };
    test("비밀·일회성 값 제외, port/label/profile/npm 경로 영속화", () => {
      d.saveWinServiceEnv(c, env);
      const saved = JSON.parse(fs.readFileSync(path.join(home, "win-service-env.json"), "utf8"));
      assert.equal(saved.TIGUCLAW_SERVICE_LABEL, c.label);
      for (const [key, value] of Object.entries(env)) {
        if (d.WIN_SERVICE_ENV_KEYS.includes(key)) assert.equal(saved[key], value);
        else assert.equal(saved[key], undefined);
      }
    });
    test("새 예약작업·restart·update 재생성: 동일 홈 정본, 비밀 없는 VBS", () => {
      const fresh: Record<string,string> = {}; d.applyWinServiceEnv(home, fresh);
      assert.equal(fresh.HTTP_BRIDGE_PORT, "7021"); assert.equal(fresh.USERPROFILE, env.USERPROFILE);
      const vbs = d.buildWinVbs(c);
      assert(vbs.includes('("HTTP_BRIDGE_PORT") = "7021"'));
      assert(vbs.includes('("TIGUCLAW_SERVICE_LABEL") = "inspection.7020"'));
      assert(vbs.includes(env.CODEX_HOME)); assert(!vbs.includes("TOKEN"));
      // 구 버전 supervise로 롤백해도 VBS가 표준 환경으로 전달하므로 새 JSON reader에 의존하지 않는다.
      assert(vbs.includes('("npm_config_userconfig") = "C:\\empty.npmrc"'));
      assert(vbs.includes("--home"));
    });
    test("홈 .env 명시 설정 우선; JSON 임의 키/비밀 주입 차단", () => {
      fs.writeFileSync(path.join(home, ".env"), 'HTTP_BRIDGE_PORT=7029\nHTTP_BRIDGE_TOKEN=private-test-only\n');
      const saved = JSON.parse(fs.readFileSync(path.join(home,"win-service-env.json"),"utf8"));
      saved.HTTP_BRIDGE_TOKEN="injected-secret";
      fs.writeFileSync(path.join(home,"win-service-env.json"),JSON.stringify(saved));
      assert.equal(d.readWinServiceEnv(home).HTTP_BRIDGE_PORT,"7029");
      assert.equal(d.readWinServiceEnv(home).HTTP_BRIDGE_TOKEN,undefined);
    });
    test("손상된 정본: 다른 기본 인스턴스로 fallback 금지", () => {
      const file=path.join(home,"win-service-env.json"); const before=fs.readFileSync(file,"utf8");
      fs.writeFileSync(file,"{"); assert.throws(()=>d.readWinServiceEnv(home)); fs.writeFileSync(file,before);
    });
    test("실패 로그 비밀 지우기", () => {
      const text=d.redactUpdateLog('opaque-test-secret Bearer abcdefghi https://user:password@example.test token=foo', { SOME_TOKEN:'opaque-test-secret' });
      for(const secret of ['opaque-test-secret','abcdefghi','password','token=foo']) assert(!text.includes(secret));
    });
    const source=fs.readFileSync(path.join(repo,"bin/daemon.mjs"),"utf8");
    const body=source.slice(source.indexOf("const runUpdate = (c) => {"),source.indexOf("\n/**\n * @param {Ctx} c\n * @param {string} cmd",source.indexOf("const runUpdate = (c) => {")));
    const simulate = (scenario: "success"|"npm-fail"|"dirty"|"rollback-dirty", notify=false) => {
      const h=fs.mkdtempSync(path.join(home,"case-"));fs.writeFileSync(path.join(h,"dist.js"),"ok");
      const context={...c,homeAbs:h,logsDir:path.join(h,"logs"),distEntry:path.join(h,"dist.js")};
      const calls:string[]=[];let rev=0,status=0,ci=0;
      const processFake={platform:"win32",execPath:process.execPath,exitCode:0,stdout:{write:()=>{}}, env:{HTTP_BRIDGE_TOKEN:"opaque-fixture-secret",...(notify?{TIGUCLAW_UPDATE_NOTIFY_CHANNEL:"fixture"}:{})}};
      const spawnSync=(cmd:string,args:string[])=>{
        calls.push([cmd,...args].join(" "));let stdout="",stderr="",code=0;
        if(cmd==="git"&&args[0]==="rev-parse")stdout=++rev===1?"1111111":"2222222";
        if(cmd==="git"&&args[0]==="status"){
          status++;if(scenario==="dirty"||(scenario==="rollback-dirty"&&status>1))stdout=" M package-lock.json\n";
        }
        if(cmd==="npm"&&args[0]==="ci"){
          ci++;if(scenario!=="success"&&ci===1){code=1;stderr="fixture npm EACCES opaque-fixture-secret";}
        }
        return {status:code,stdout,stderr};
      };
      const messages:string[]=[];const fakeConsole={log:(...a:unknown[])=>messages.push(a.join(" ")),error:(...a:unknown[])=>messages.push(a.join(" ")),warn:(...a:unknown[])=>messages.push(a.join(" "))};
      const fds:number[]=[];
      const names=["process","console","path","existsSync","mkdirSync","openSync","writeSync","writeFileSync","spawnSync","isDaemonRunning","isRegistered","handlers","assertWinServiceToken","saveWinServiceEnv","redactUpdateLog"];
      const invoke=new Function(...names,body+"; return runUpdate;")(...[
        processFake,fakeConsole,path,fs.existsSync,fs.mkdirSync,(p:string,flags:string)=>{const fd=fs.openSync(p,flags);fds.push(fd);return fd;},fs.writeSync,fs.writeFileSync,spawnSync,()=>true,()=>true,
        {win32:{stop:()=>calls.push("STOP"),start:()=>calls.push("START")}},()=>{},()=>calls.push("SAVE_ENV"), (text:string)=>d.redactUpdateLog(text,processFake.env),
      ]);
      try {invoke(context);} finally {for(const fd of fds)fs.closeSync(fd);}
      const log=fs.readdirSync(path.join(h,"logs")).find(x=>x.startsWith("update-"));assert(log);
      return {calls,messages,exitCode:processFake.exitCode,log:fs.readFileSync(path.join(h,"logs",log),"utf8"),home:h};
    };
    test("notify 없는 dashboard 실패도 npm stderr·단계 로그 보존, 비밀 제거",()=>{
      const r=simulate("npm-fail");assert.equal(r.exitCode,1);assert(r.log.includes("fixture npm EACCES"));assert(!r.log.includes("opaque-fixture-secret"));
      assert(r.calls.some(x=>x==="git reset --keep 1111111"));assert(r.calls.includes("START"));
      assert(r.calls.indexOf("SAVE_ENV")<r.calls.indexOf("STOP"));
    });
    test("성공: pull→stop→npm→build→start, 알림 마커 기존 유지",()=>{
      const r=simulate("success",true);assert.equal(r.exitCode,0);assert(r.calls.includes("npm run build:prod"));assert(r.calls.includes("START"));
      assert(r.calls.indexOf("git pull --ff-only")<r.calls.indexOf("STOP"));
      assert(fs.existsSync(path.join(r.home,".update-complete")));
    });
    test("미커밋 lock 보존: checkout/reset/stop 전 중단",()=>{
      const r=simulate("dirty");assert.equal(r.exitCode,1);assert(!r.calls.includes("STOP"));assert(!r.calls.some(x=>/checkout|reset|pull/.test(x)));
    });
    test("업데이트 중 새 변경: 롤백 reset도 생략, 사용자 파일 보존",()=>{
      const r=simulate("rollback-dirty");assert.equal(r.exitCode,1);assert(!r.calls.some(x=>x.includes("git reset")));assert(!r.calls.includes("START"));
    });
  } finally {fs.rmSync(home,{recursive:true,force:true});}
  return checks;
}};
