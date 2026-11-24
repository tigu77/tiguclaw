/**
 * 회귀: **구독 인증 목록 라우트는 다른 프로세스가 쓴 자격을 따라가고, 자격 표지를 감춰 내보낸다** (2026-11-21, 인증 후 한도 게이지 갱신).
 *
 * 사고: 화면이 안내한 터미널 발급(`npm run claude-auth`)은 **별도 프로세스**가 홈 `.env` 에 쓴다. 데몬은 메시지 입구에서만 그 파일을
 *  따라가서(`followHomeCredentials`), 목록 라우트는 다음 메시지가 올 때까지 «미인증» 이었다 — 화면이 아무리 다시 읽어도 인증 완료를
 *  못 봤다. 또 «인증됐나» 만으로는 이미 인증된 provider 의 재인증(계정 교체)을 모른다.
 *
 * 지키는 것(자식 프로세스 — 임시 홈 `.env` · 가짜 provider · 실제 자격·네트워크 0):
 *  ① 다른 프로세스가 홈 `.env` 에 쓴 토큰을 목록이 바로 따라간다(«인증됨») · 한도 라우트가 먼저 불려도 새 자격으로 묻는다
 *  ② 자격 표지는 자격이 바뀔 때만 바뀐다(재인증 = 표지 변화 · 같은 자격 = 같은 표지) · 자격이 없으면 `""` · 표지를 안 주면 `null`
 *  ③ 응답에 토큰도, provider 가 준 표지(해시)도 그대로 나가지 않는다
 *  ④ 데몬을 다시 켜도(새 프로세스) 같은 자격이면 같은 표지다 — 재시작이 «자격이 바뀌었다» 로 읽혀 열린 화면이 한도를 다시 묻지 않게
 *
 * 등급: **동작**.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "_auth-route-follows-child.ts");

type Item = { authenticated: boolean | null; credential: string | null } | undefined;

export const check: RegressionCheck = {
  name: "auth-route-follows-credentials",
  guards:
    "터미널(다른 프로세스)로 발급한 구독 토큰을 목록 라우트가 다음 메시지 전까지 못 보던 것 + 이미 인증된 provider 의 재인증을 화면이 구분할 표지가 없던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], { encoding: "utf8", timeout: 60_000, env: { ...process.env } });
    const line = (r.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "";
    // 두 번째 프로세스 = 데몬 재시작
    const r2 = spawnSync(process.execPath, ["--import", "tsx", CHILD], { encoding: "utf8", timeout: 60_000, env: { ...process.env } });
    const line2 = (r2.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "";
    let res2: { afterFirst?: Item } = {};
    try {
      res2 = JSON.parse(line2);
    } catch {
      res2 = {};
    }
    let res: { before?: Item; afterFirst?: Item; afterSecond?: Item; again?: Item; untagged?: Item; usageFirst?: string; usageAfterAuth?: string; finishCredential?: string | null; finishAuthenticated?: boolean; leaksToken?: boolean; leaksTag?: boolean; error?: string } = {};
    try {
      res = JSON.parse(line);
    } catch {
      res = { error: `자식 출력 해석 실패: ${line.slice(0, 200)} / stderr ${(r.stderr ?? "").slice(0, 300)}` };
    }
    out.push(assert("전제 — 자식 프로브가 끝까지 돌았다", res.error === undefined && r.status === 0, res.error ?? `exit ${r.status}`));
    out.push(
      assert(
        "★★① 다른 프로세스가 홈 `.env` 에 쓴 토큰을 목록 라우트가 바로 따라간다(메시지를 기다리지 않는다)",
        res.before?.authenticated === false && res.afterFirst?.authenticated === true,
        { 전: res.before, 후: res.afterFirst },
      ),
    );
    out.push(
      assert(
        "★① 한도 라우트가 목록보다 먼저 불려도 다른 프로세스가 쓴 새 자격으로 묻는다 · `after=auth` 만 provider 에 «인증 직후» 로 전한다(보통 조회는 아님)",
        res.usageFirst === "token-first" && res.usageAfterAuth === "token-first|after-auth",
        { 보통: res.usageFirst, 인증직후: res.usageAfterAuth },
      ),
    );
    out.push(
      assert(
        "★② 자격 표지 — 없으면 \"\" · 생기면 값 · 다시 발급하면 바뀌고 · 같은 자격이면 같다 · 표지를 안 주는 provider 는 null",
        res.before?.credential === "" &&
          typeof res.afterFirst?.credential === "string" &&
          res.afterFirst.credential !== "" &&
          res.afterSecond?.credential !== res.afterFirst.credential &&
          res.again?.credential === res.afterSecond?.credential &&
          res.untagged?.credential === null,
        { 전: res.before?.credential, 첫: res.afterFirst?.credential, 둘: res.afterSecond?.credential, 같은: res.again?.credential, 표지없음: res.untagged?.credential },
      ),
    );
    out.push(
      assert(
        "★⑤ 로그인 마무리 응답이 목록과 **같은** 자격 표지·인증 상태를 싣는다(화면이 그 응답을 그 provider 의 확정 상태로 쓴다)",
        typeof res.finishCredential === "string" && res.finishCredential === res.again?.credential && res.finishAuthenticated === true,
        { 마무리: res.finishCredential, 목록: res.again?.credential, 인증: res.finishAuthenticated },
      ),
    );
    out.push(
      assert(
        "★④ 데몬을 다시 켜도 같은 자격이면 같은 표지다",
        typeof res.afterFirst?.credential === "string" && res.afterFirst.credential !== "" && res2.afterFirst?.credential === res.afterFirst.credential,
        { 첫프로세스: res.afterFirst?.credential, 재시작: res2.afterFirst?.credential },
      ),
    );
    out.push(
      assert("★③ 응답에 토큰도 provider 가 준 표지도 그대로 나가지 않는다", res.leaksToken === false && res.leaksTag === false, {
        토큰: res.leaksToken,
        표지: res.leaksTag,
      }),
    );
    return out;
  },
};

export default check;
