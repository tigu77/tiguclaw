import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexSessionIdentity, deriveCodexSessionIdentity } from "../../core/llm-runtime/adapters/_codex-session-identity.js";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";
export const check: RegressionCheck = {
  name: "codex-session-identity",
  guards: "캐시 예비/실제 도구 비교에서 세션 헤더 없는 요청의 고정 영역 재사용 저하; 도입 시 대화·계정 병합 및 raw 키 헤더 유출 방지",
  run: async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-session-test-"));
    const namespace = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
    const stable = (account: string, thread: string) => deriveCodexSessionIdentity(account, thread, namespace);
    const first = codexSessionIdentity("account-a", "parent", join(root, "home-a"));
    const persisted = readFileSync(join(root, "home-a/codex-session-namespace"), "utf8");
    const again = codexSessionIdentity("account-a", "parent", join(root, "home-a"));
    const other = codexSessionIdentity("account-a", "parent", join(root, "home-b"));
    mkdirSync(join(root, "broken")); writeFileSync(join(root, "broken/codex-session-namespace"), "partial");
    const broken = codexSessionIdentity("account-a", "parent", join(root, "broken"));
    writeFileSync(join(root, "not-a-directory"), "block");
    const unavailable = codexSessionIdentity("account-a", "parent", join(root, "not-a-directory"));
    const vector = stable("account-a", "telegram:테스트");
    const keys = ["parent", "worker:job-1", "agent:job-1", "worker:job-2", "parent "];
    const ids = keys.map(k => stable("account-a", k));
    const weird = ["한국어\r\nheader: value", "x".repeat(10000)].map(k => stable("account-a", k));
    const absent = [undefined, null, 42, "", " "].map(a => codexSessionIdentity(a, "parent", join(root, "absent")));
    const child = await spawnWithin(60000, "Codex 세션 식별자 실제 전송", ["--import", "tsx", fileURLToPath(new URL("./_codex-session-identity-child.ts", import.meta.url))]);
    const line = child.out.split(/\r?\n/).find(l => l.startsWith("SESSION_ID_RESULT "));
    const rows = (line ? JSON.parse(line.slice("SESSION_ID_RESULT ".length)) : []) as { key: string; session: string | null; thread: string | null; tools: number }[][];
    const active = rows.slice(0, 5).flat();
    const restarted = await spawnWithin(60000, "같은 홈 새 프로세스", ["--import", "tsx", fileURLToPath(new URL("./_codex-session-identity-child.ts", import.meta.url))]);
    const otherHome = join(process.env.TIGUCLAW_HOME!, "other-instance");
    mkdirSync(otherHome, { recursive: true }); writeFileSync(join(otherHome, ".env"), "# isolated fixture\n");
    const isolated = await spawnWithin(60000, "다른 홈 같은 대화", ["--import", "tsx", fileURLToPath(new URL("./_codex-session-identity-child.ts", import.meta.url))], { env: { ...process.env, TIGUCLAW_HOME: otherHome } });
    const firstKey = (out: string): string | undefined => {
      const l = out.split(/\r?\n/).find(x => x.startsWith("SESSION_ID_RESULT "));
      return l ? JSON.parse(l.slice("SESSION_ID_RESULT ".length))[0]?.[0]?.key : undefined;
    };
    const namespaceSafe = !existsSync(join(root, "absent")) && readFileSync(join(root, "broken/codex-session-namespace"), "utf8") === "partial";
    rmSync(root, { recursive: true, force: true });
    return [
      assert("새 프로세스에서도 실제 전송 ID 유지", firstKey(restarted.out) !== undefined && firstKey(restarted.out) === rows[0]?.[0]?.key, { before: rows[0]?.[0]?.key, after: firstKey(restarted.out), error: restarted.err.slice(-200) }),
      assert("다른 설치 홈은 실제 전송 ID 분리", firstKey(isolated.out) !== undefined && firstKey(isolated.out) !== rows[0]?.[0]?.key, { before: rows[0]?.[0]?.key, other: firstKey(isolated.out), error: isolated.err.slice(-1400) }),
      assert("같은 홈은 파일에 저장된 namespace를 재사용", first !== undefined && first === again && first === deriveCodexSessionIdentity("account-a", "parent", persisted.trim()), { first, again, persisted }),
      assert("서로 다른 설치 홈의 같은 계정/대화도 분리", first !== undefined && other !== undefined && first !== other, { first, other }),
      assert("손상/미완성 또는 저장 불가능한 namespace는 기존 전송으로 폴백", broken === undefined && unavailable === undefined, { broken, unavailable }),
      assert("불명확한 계정은 파일을 만들지 않고 손상 파일을 덮어쓰지 않음", namespaceSafe, { namespaceSafe }),
      assert("독립 Python UUIDv5 기준 벡터와 일치하여 재시작/업그레이드 시 매핑 변경 감지", vector === "d9953ded-bac1-540f-a3bb-7f971f374069", vector),
      assert("같은 계정/대화는 매번 같은 ID", vector === stable("account-a", "telegram:테스트"), { first: vector, again: stable("account-a", "telegram:테스트") }),
      assert("부모·worker·agent·서로 다른 잡·공백 차이를 병합하지 않음", new Set(ids).size === keys.length, ids),
      assert("같은 대화도 계정이 다르면 분리", ids[0] !== stable("account-b", "parent"), { a: ids[0], b: stable("account-b", "parent") }),
      assert("필드 구분자 모호성으로 계정/대화가 합쳐지지 않음", stable("a:b", "c") !== stable("a", "b:c"), [stable("a:b", "c"), stable("a", "b:c")]),
      assert("Unicode·CRLF·긴 키를 고정 길이 ASCII UUID로 변환", weird.every(x => typeof x === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x)), weird),
      assert("계정 미상/잘못된 타입과 빈 대화는 기존 동작으로 폴백", absent.every(x => x === undefined) && codexSessionIdentity("account-a", " ", join(root, "absent")) === undefined, { absent, empty: codexSessionIdentity("account-a", " ", join(root, "absent")) }),
      assert("실제 어댑터 여섯 실행 모두 도구 후 요청까지 관측", rows.length === 6 && rows.every(r => r.length === 2) && !child.timedOut, rows.length ? rows.map(r => r.length) : child.err.slice(-1000)),
      assert("실제 전송의 두 헤더와 캐시 키는 항상 같은 UUID", active.length === 10 && active.every(r => r.session === r.key && r.thread === r.key && /^[a-f0-9-]{36}$/.test(r.key)), active),
      assert("도구 다음 요청·독립 재호출·토큰 갱신 후에도 같은 대화 ID 유지", rows.length === 6 && rows.slice(0, 2).flat().every(r => r.key === rows[0]?.[0]?.key), rows.slice(0, 2)),
      assert("실제 자식 역할 및 계정 변경은 전송 ID 분리", rows.length === 6 && new Set([rows[0]?.[0]?.key, ...rows.slice(2, 5).map(r => r[0]?.key)]).size === 4, rows.slice(0, 5).map(r => r[0]?.key)),
      assert("계정 미상은 실제 전송에서도 헤더 없이 기존 cache key 유지", rows[5]?.length === 2 && rows[5].every(r => r.key === "legacy:thread" && r.session === null && r.thread === null), rows[5]),
    ];
  },
};
