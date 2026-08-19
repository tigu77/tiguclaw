/**
 * 회귀: **네이티브 모듈 적재 실패는 다음 행동까지 알려준다.**
 *
 * 사고 (2026-08-11, 윈도우 신규 설치): 데몬이 부팅마다 죽었고, 그물을 앞당긴 뒤 남은 것은
 *  bindings 탐색 경로 13줄 + 스택이었다. 원인은 명확했지만(better-sqlite3 네이티브 바인딩
 *  부재) **사용자가 무엇을 해야 하는지는 어디에도 없었다** — 로그를 개발자에게 보내야만
 *  앞으로 나갈 수 있었다. 실제로 그렇게 진행됐다.
 *
 * ★"로그가 1차 진단면" 은 *원인이 적히는 것* 까지가 아니라 **다음 행동이 적히는 것** 까지다.
 *  원격 인스턴스(회사PC·타 사용자 기계)는 우리가 붙을 수 없다 — 로그가 혼자 서야 한다.
 *
 * ★윈도우는 한 줄이 더 붙는다: 돌고 있는 데몬을 안 멈추고 `npm ci` 를 돌리면 파일 잠금으로
 *  네이티브 모듈이 안 깔린다. 실측 로그에서 **정상 부팅(11:38) → npm ci → 사망(11:42~)** 으로
 *  나타났다 — 즉 안내 없이는 사용자가 스스로 자기 설치를 깬다.
 */
import {
  describeNativeLoadFailure,
  explainDbOpenFailure,
} from "../../store/sessions.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // 실측 원문(윈도우 D:\tiguclaw, 2026-08-11 11:45:17).
  const real = "Could not locate the bindings file. Tried:\n → build/better_sqlite3.node";

  // ── ① 이 부류를 알아본다 ─────────────────────────────────────────────────
  {
    const hits = [
      real,
      "ERR_DLOPEN_FAILED: The specified module could not be found.",
      "The module was compiled against a different Node.js version",
    ].map((m) => describeNativeLoadFailure(m, "linux") !== null);
    out.push({
      name: "★네이티브 적재 실패 3형태를 모두 알아본다",
      ok: hits.every(Boolean),
      got: `판정=${JSON.stringify(hits)} (기대 전부 true)`,
    });
  }

  // ── ② 무관한 실패엔 안 붙는다(안내가 소음이 되면 안 읽힌다) ──────────────
  {
    const noise = [
      "SQLITE_CANTOPEN: unable to open database file",
      "EACCES: permission denied, mkdir '/data'",
      "database disk image is malformed",
    ].map((m) => describeNativeLoadFailure(m, "linux"));
    out.push({
      name: "무관한 DB 오류엔 안 붙는다(원인 오도 0)",
      ok: noise.every((n) => n === null),
      got: `붙은 것=${noise.filter((n) => n !== null).length}건 (기대 0건)`,
    });
  }

  // ── ③ ★조치가 **이미 있는 도구**를 가리킨다 — 손 절차 재작성 금지 ────────
  //  이 검사의 존재 이유. 2026-08-11 에 나는 여기에 `npm rebuild` 손 절차를 적었다가
  //  사용자에게 지적받았다("매번 저렇게 해줘야 하는거야? tiguclaw update 로 다 되는 거
  //  아니야?"). `tiguclaw update` 가 stop→npm ci→build→start+롤백을 이미 한다 —
  //  도구가 아는 순서를 사람이 다시 적으면 그 사본이 먼저 낡는다.
  {
    const msg = describeNativeLoadFailure(real, "linux") ?? "";
    out.push({
      name: "★조치가 `tiguclaw update` 한 줄이다(있는 도구를 가리킨다)",
      ok: msg.includes("tiguclaw update") && msg.includes("조치:"),
      got: msg.includes("tiguclaw update")
        ? "update 안내 포함"
        : `🔴 조치 없음 — ${msg.slice(0, 70)}`,
    });
    out.push({
      name: "★손 절차(npm rebuild)를 다시 적지 않는다 — 사본은 먼저 낡는다",
      ok: !/npm rebuild/.test(msg),
      got: /npm rebuild/.test(msg) ? "🔴 손 절차가 되살아났다" : "손 절차 없음",
    });
    out.push({
      name: "빌드 도구가 필요할 수 있다는 다음 단계까지 있다",
      ok: /Build Tools|build-essential/.test(msg),
      got: /Build Tools|build-essential/.test(msg) ? "후속 안내 포함" : "🔴 막다른 길",
    });
  }

  // ── ④ ★`npm ci` 직접 실행을 말린다 — 사용자가 자기 설치를 깨는 경로 ──────
  //  실측: 정상 부팅(11:38) → (손으로) npm ci → 사망(11:42~). 데몬이 떠 있으면
  //  better_sqlite3.node 가 잠겨 설치가 깨진다. 플랫폼 무관하게 같은 말을 한다 —
  //  종전엔 win32 에만 붙였는데, 안내를 플랫폼으로 가를 이유가 없었다(도구가 알아서 한다).
  {
    for (const p of ["win32", "linux", "darwin"]) {
      const m = describeNativeLoadFailure(real, p) ?? "";
      out.push({
        name: `${p}: npm ci 를 직접 돌리지 말라고 말린다`,
        ok: m.includes("npm ci") && /직접 돌리지 마세요|말립/.test(m),
        got: m.includes("npm ci") ? "경고 포함" : `🔴 누락 — ${m.slice(0, 60)}`,
      });
    }
  }

  // ── ⑤ ★쓰는 자리가 실제로 붙이는가 ──────────────────────────────────────
  //  ①~④ 는 판정 함수만 봤다. 변이 테스트에서 **안내를 통째로 빼도 초록**이었다 —
  //  검사가 순수 함수만 보고 그걸 쓰는 자리를 안 봤기 때문이다. 그래서 감싸는 판단도
  //  실행 가능한 자리로 뽑아 여기서 돌린다(그물 구멍을 변이가 알려줬다).
  {
    const wrapped = explainDbOpenFailure(new Error(real));
    out.push({
      name: "★DB 열기 실패에 안내가 실제로 붙는다(원문도 보존)",
      ok:
        wrapped.message.includes("tiguclaw update") &&
        wrapped.message.includes("원문:") &&
        wrapped.message.includes("Could not locate the bindings file"),
      got: `메시지 앞머리=${JSON.stringify(wrapped.message.slice(0, 60))}`,
    });

    // ★**로그에 실제로 찍히는 것**은 message 가 아니라 stack 이다 (2026-08-19, SANTO 머신
    //  실증). 크래시 핸들러가 `logFatal(..., err)` 로 Error 객체를 통째로 넘기고 콘솔은
    //  그럴 때 `stack` 을 찍는다. 종전엔 `wrapped.stack = e.stack` 으로 **원본 스택을
    //  덮어써서**, 그 문자열이 `Error: Could not locate the bindings file…` 로 시작해
    //  **안내가 통째로 가려졌다** — 사용자 로그엔 탐색 경로 13줄만 남았고, 이 파일이
    //  없애려던 바로 그 증상이 그대로 재현됐다. 안내를 만드는 것과 **도달하는 것**은 다르다.
    out.push({
      name: "★안내가 stack 에도 먼저 온다(크래시 로그가 찍는 건 message 가 아니라 stack)",
      ok:
        String(wrapped.stack).startsWith("SQLite 네이티브 모듈") &&
        !String(wrapped.stack).startsWith("Error: Could not locate"),
      got: `stack 앞머리=${JSON.stringify(String(wrapped.stack).slice(0, 40))}`,
    });
    out.push({
      name: "그러면서 원본 스택을 잃지 않는다(진단 정보 보존)",
      ok: String(wrapped.stack).includes("--- 원본 스택 ---"),
      got: String(wrapped.stack).includes("--- 원본 스택 ---") ? "원본 첨부됨" : "🔴 원본 스택 소실",
    });

    const untouched = new Error("SQLITE_CANTOPEN: unable to open database file");
    out.push({
      name: "무관한 실패는 **원본 그대로** 통과한다(감싸서 스택을 흐리지 않는다)",
      ok: explainDbOpenFailure(untouched) === untouched,
      got:
        explainDbOpenFailure(untouched) === untouched
          ? "동일 객체 반환"
          : "🔴 불필요하게 감쌌다",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "native-load-failure-actionable",
  guards:
    "better-sqlite3 네이티브 바인딩 부재로 데몬이 부팅마다 죽는데 로그엔 탐색 경로 13줄만 남아, 사용자가 무엇을 해야 하는지 알 수 없던 것(원격 기계는 로그가 혼자 서야 한다)",
  run,
};
