/**
 * 회귀: "이 답도 함께 보낼 채널"(egress)은 **서버가 안다** — 그래서 서버가 스스로 만드는
 * 발화에도 걸린다.
 *
 * 사고 (2026-08-10, 사용자): 몇 시간짜리 매니저가 끝났는데 텔레그램으로 알림이 안 왔다.
 *  대시보드에서 "텔레그램에도 보내기" 는 켜져 있었다.
 *
 *  뿌리: egress 선택이 **브라우저 localStorage** 에만 있었고, 컴포저가 전송할 때마다
 *  메시지에 실어 보내는 per-message 플래그였다. 그런데 워커 완료는 서버가 만든 **합성
 *  메시지**를 메인 핸들러에 재주입하는 경로라(worker-jobs.ts) 그 플래그가 없다.
 *  스케줄·파일감시도 같다. 즉 **서버는 사용자가 켠 사실을 아예 몰랐고**, 사람이 그 자리에
 *  없을 확률이 가장 높은 긴 작업일수록 알림이 안 갔다.
 *
 *  종전 주석은 이걸 *"발신 좌표가 아니라 화면 설정"* 이라 적어 localStorage 를 정당화했다 —
 *  그 판단이 틀렸다. 메시지를 어디로 보낼지 정하는 값은 동작 설정이다.
 *
 * 지키는 것 — ①설정이 서버에 있고 ②없으면 빈 목록(기존 동작) ③한 키만 병합 저장
 *  ④★핸들러가 **메시지에 실려온 것과 서버 설정을 합집합**으로 쓴다(그래야 파생 발화가 탄다).
 *
 * ★④의 등급은 **배선 린트**다 — 합성 메시지 재주입을 실제로 돌리려면 LLM 이 필요해서,
 *  여기선 "합집합을 쓰는 배선이 있는가" 만 본다. 동의어 우회는 못 잡는다.
 */
import { readFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  const { readEgressChannels } = await import("../../core/settings.js");

  // ── ① 설정 부재 = 빈 목록(기존 동작 그대로, 회귀 0) ────────────────────────
  {
    const empty = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-egress-"));
    try {
      out.push({
        name: "설정이 없으면 빈 목록(fan-out 없음 = 기존 동작)",
        ok: readEgressChannels(empty).length === 0,
        got: `${readEgressChannels(empty).length}개 (기대 0)`,
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }

  // ── ② 프로젝트 레이어에서 읽힌다 + 잡값은 걸러진다 ─────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-egress-"));
    try {
      const scope = path.join(dir, ".tiguclaw");
      mkdirSync(scope, { recursive: true });
      writeFileSync(
        path.join(scope, "settings.json"),
        JSON.stringify({ egress: { channels: ["telegram", "", 42, "cli"] } }),
        "utf8",
      );
      const got = readEgressChannels(dir);
      out.push({
        name: "설정을 읽고, 빈 문자열·비문자열은 버린다",
        ok: got.length === 2 && got[0] === "telegram" && got[1] === "cli",
        got: `${JSON.stringify(got)} (기대 ["telegram","cli"])`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── ③ ★핸들러가 메시지 값과 서버 설정을 **합집합**으로 쓴다 ────────────────
  //  이게 없으면 서버가 만든 합성 메시지(워커 완료 재주입)는 영원히 fan-out 을 못 탄다.
  {
    const src = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const usesSettings = src.includes("readEgressChannels()");
    const unions =
      /new Set\(\[\s*\.\.\.\(msg\.egressChannels \?\? \[\]\),\s*\.\.\.egressFromSettings/.test(
        src,
      );
    out.push({
      name: "★턴이 서버 설정을 읽는다(파생 발화가 fan-out 을 타는 근거)",
      ok: usesSettings,
      got: usesSettings ? "readEgressChannels() 사용" : "★서버 설정을 안 읽음",
    });
    out.push({
      name: "★메시지 값과 합집합이다(컴포저 값도 계속 유효)",
      ok: unions,
      got: unions ? "합집합 배선 확인" : "★합집합 아님(한쪽만 쓰고 있다)",
    });
  }

  // ── ④ 저장은 한 키만 건드린다(다른 설정 보존) ──────────────────────────────
  //  setDefaultProfile 이 지키는 불변식과 같다 — 통째로 덮어쓰면 손으로 넣은 값이 날아간다.
  {
    const settingsSrc = await readFile(
      new URL("../../core/settings.ts", import.meta.url),
      "utf8",
    );
    const i = settingsSrc.indexOf("export const setEgressChannels");
    const body = i < 0 ? "" : settingsSrc.slice(i, i + 1400);
    out.push({
      name: "저장이 read-modify-write 다(다른 키 보존 · 원자적 rename)",
      ok:
        body.includes("JSON.parse(readFileSync(file") &&
        body.includes("renameSync(tmp, file)"),
      got: `read=${body.includes("JSON.parse(readFileSync(file")} rename=${body.includes("renameSync(tmp, file)")}`,
    });
  }

  // ── ⑤ ★재주입이 **자기 배달 좌표를 실어 보낸다** (2026-08-25) ───────────────
  //  ④가 파생 발화를 fan-out 에 태운 뒤, 그 반대 방향 사고가 났다: 잡의 목적지가 이미
  //  텔레그램인 경우(스케줄發) 같은 본문이 **두 번** 갔다(실측 08:11:29·08:11:31, 4,562자).
  //  중복 가드가 채널 **이름**만 봤기 때문이다 — 재주입의 이름은 `scheduler`, 배달지는
  //  telegram 이라 안 겹쳤다. 좌표 판정 자체는 `egress-target-resolution` 이 실행으로 본다.
  //  ★여기서 보는 건 **그 좌표가 실제로 실려 나가는가** 뿐이다(등급: 배선 린트 — 재주입을
  //   실제로 돌리려면 LLM 이 필요하다. 동의어 우회는 못 잡는다).
  {
    const wj = await readFile(new URL("../../core/worker-jobs.ts", import.meta.url), "utf8");
    const carried = wj.split("replyTarget:").length - 1;
    out.push({
      name: "★[배선 린트] 워커 재주입(완료·점검)이 replyTarget 을 실어 보낸다",
      ok: carried >= 2,
      got: carried >= 2 ? `${carried}곳` : `★${carried}곳 — 좌표가 안 실리면 같은 곳에 두 번 간다`,
    });
    // 좌표는 `dest` 에서 와야 한다 — 다른 값을 실으면 가드가 엉뚱한 걸 막는다.
    // ★**전수**로 센다: "하나라도 dest 면 통과" 로 두면 두 곳 중 한 곳만 바꿔도 초록이다
    //  (실제로 그 구멍으로 변이가 빠져나갔다 — 존재 확인은 개수 확인이 아니다).
    const fromDest = wj.split("replyTarget: { channel: dest.channel, target: dest.target ?? null }").length - 1;
    out.push({
      name: "★그 좌표가 **전부** 잡의 목적지(dest)에서 온다",
      ok: fromDest === carried && carried > 0,
      got: fromDest === carried ? `${fromDest}/${carried} dest` : `★${fromDest}/${carried} 만 dest — 나머지는 엉뚱한 좌표`,
    });
  }

  // ── ⑥ ★fan-out 이 **사본 표식**을 단다 (2026-08-25) ──────────────────────────
  //  적재 판정(event-persist)은 `room-notice-is-ephemeral` 이 실행으로 본다. 여기서는
  //  **그 표식이 실제로 실려 나가는가** — 오늘 하루에 같은 부류(판정은 검사되는데 호출부는
  //  안 검사됨)로 세 번 뚫렸다. 등급: 배선 린트(fan-out 을 실제로 돌리려면 채널이 필요하다).
  {
    const idx = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const fanOut = idx.slice(idx.indexOf("const fanOutEgress"), idx.indexOf("const fanOutEgress") + 1400);
    out.push({
      name: "★[배선 린트] fanOutEgress 가 `copyOfRecorded` 를 실어 보낸다",
      ok: /copyOfRecorded:\s*true/.test(fanOut),
      got: /copyOfRecorded:\s*true/.test(fanOut)
        ? "표식 확인"
        : "★표식 없음 — 같은 답이 대화 기록에 두 줄로 남는다",
    });
    // 인입 응답(원본)엔 붙으면 안 된다 — 붙으면 대화가 통째로 기록에서 사라진다.
    const reply = idx.slice(idx.indexOf("await msg.reply("), idx.indexOf("await msg.reply(") + 400);
    out.push({
      name: "★원본 응답 경로엔 그 표식이 없다(대화가 기록에서 사라지지 않게)",
      ok: !/copyOfRecorded/.test(reply),
      got: /copyOfRecorded/.test(reply) ? "★원본에 붙었다" : "원본 무표식 확인",
    });
  }

  // ── ⑦ ★사슬 **가운데 고리** (재검토 G-2·G-12) ────────────────────────────────
  //  종전엔 양끝만 봤다: fanOut 이 표식을 담는가(⑥) · event-persist 가 그걸 보고 거르는가
  //  (room-notice-is-ephemeral). 가운데 `deliverOutbound` 가 payload 에 안 실으면 사슬이
  //  끊기는데 둘 다 초록이었다. [[feedback_verify_before_asserting]] — 양끝만 보고 가운데를
  //  가정했다. 등급: 배선 린트.
  {
    const ob = await readFile(new URL("../../core/outbound.ts", import.meta.url), "utf8");
    out.push({
      name: "★[배선 린트] deliverOutbound 가 `copyOfRecorded` 를 payload 로 실어 보낸다",
      ok: /copyOfRecorded:\s*true/.test(ob) && /input\.copyOfRecorded/.test(ob),
      got: /copyOfRecorded:\s*true/.test(ob) && /input\.copyOfRecorded/.test(ob)
        ? "payload + 입력 배선 확인"
        : "★가운데 고리가 끊겼다 — 표식이 event-persist 까지 못 간다",
    });
    // ★G-12: 오늘 편집이 바로 그 두 줄 옆에 들어갔다. 2026-08-11 실사고(텔레그램 답장이
    //  원래 세션을 못 찾고 공통 세션으로 떨어짐)를 지키던 줄이다.
    const idx2 = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const fan = idx2.slice(idx2.indexOf("const fanOutEgress"), idx2.indexOf("const fanOutEgress") + 1400);
    out.push({
      name: "★[배선 린트] fanOutEgress 가 `originThreadKey` 도 여전히 실어 보낸다",
      ok: /originThreadKey,/.test(fan),
      got: /originThreadKey,/.test(fan)
        ? "귀속 확인"
        : "★귀속이 빠졌다 — 텔레그램 답장이 원래 세션을 못 찾는다(2026-08-11 사고)",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "egress-applies-to-derived-turns",
  guards:
    "egress 선택이 브라우저에만 있어 서버가 만드는 발화(워커 완료 재주입·스케줄·파일감시)가 fan-out 을 못 타던 것 — 긴 작업일수록 사람이 그 자리에 없는데 알림이 거기로만 갔다",
  run,
};
