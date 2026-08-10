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

  return out;
};

export const check: RegressionCheck = {
  name: "egress-applies-to-derived-turns",
  guards:
    "egress 선택이 브라우저에만 있어 서버가 만드는 발화(워커 완료 재주입·스케줄·파일감시)가 fan-out 을 못 타던 것 — 긴 작업일수록 사람이 그 자리에 없는데 알림이 거기로만 갔다",
  run,
};
