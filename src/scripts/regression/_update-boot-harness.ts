/**
 * 부팅 업데이트 통지 영역(`src/index.ts` 의 `deliverUpdateNotice` ~ 일반 재시작 통지)을 **실제 코드 그대로** 돌리는 실행기.
 * `t1-final-contract`(가짜 파일)와 `windows-update-environment`(실제 `runUpdate` 가 쓴 실제 파일)가 같이 쓴다 — 조각별로 돌리면 이음매가 빠진다.
 * 배달은 기록만 한다(외부 발송 0). 시계·잠은 주입한다(실제로 82.5초를 기다리지 않는다).
 */
import { readFile, readlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export type BootDelivery = { channel: string; target: string | null; text: string; observeThreadKey?: string; originThreadKey?: string };
export type BootFsp = {
  readFile: (n: string, enc?: string) => Promise<string>;
  writeFile: (n: string, raw: string, enc?: string) => Promise<void>;
  unlink: (n: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
  /** 홈 목록 — 옆 보존 실패 기록(`.update-failed.unsent-*`) 쓸기(§14). */
  readdir: (dir: string) => Promise<string[]>;
  /** 디렉터리 기록(§15 — POSIX link 불가 홈의 옆 보존)을 소비한 뒤 빈 디렉터리를 치운다. 없으면 진짜 fs. */
  rmdir?: (p: string) => Promise<void>;
  /** 고정 슬롯이 symlink 공개(§16 — POSIX link 불가 홈)면 그 대상 임시본을 찾는다. 없으면 진짜 fs. */
  readlink?: (p: string) => Promise<string>;
};
export type BootRunOpts = {
  fsp: BootFsp; home: string; pathApi?: typeof path.posix; boot: unknown;
  deliver?: (d: BootDelivery) => unknown; now?: () => number; sleep?: (ms: number) => Promise<void>; reboot?: boolean;
  /** 실제 판정(`self-update.ts` 의 `updateOriginSession`)을 넘긴다 — 대역으로 판단을 한 번 더 만들지 않는다. */
  updateOriginSession: (n: unknown) => string | undefined;
  updateFailedText?: (m: { outcome?: string }) => string;
  translate?: (k: string) => string;
};

export const makeBootRunner = async (root: string) => {
  const index = await readFile(path.join(root, "src/index.ts"), "utf8");
  // 시작 표식은 수정 전·후 index 둘 다에 있는 주석이다 — 수정 전 대조 사본에서도 같은 실행기가 돈다.
  const start = index.indexOf("// 자가 업데이트 실패 통지 — 위임 CLI update");
  const end = index.indexOf("// 모델 풀 단일-provider");
  if (start < 0 || end < 0) throw new Error("boot update-notice region markers not found in src/index.ts");
  const js = ts.transpileModule(index.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const helper = await import(pathToFileURL(path.join(root, "bin/update-marker.mjs")).href);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  return async (o: BootRunOpts) => {
    const deliveries: BootDelivery[] = [];
    const logs: string[] = [];
    /** 부팅 결과 처리 끝(§15) — 그때까지의 배달 수를 적는다(모든 업데이트 결과 배달 뒤·일반 재시작 통지 전인지 본다). */
    const ends: number[] = [];
    const translate = o.translate ?? ((k: string) => k);
    const deps = {
      path: o.pathApi ?? path, getPaths: () => ({ home: o.home }), fsp: { rmdir: (p: string) => rmdir(p), readlink: (p: string) => readlink(p), ...o.fsp },
      endBootUpdateResults: () => { ends.push(deliveries.length); }, UPDATE_FAILED_MARKER: ".update-failed", getUpdateBoot: () => o.boot,
      consumeUpdateMarker: (io: object) => helper.consumeUpdateMarker({ ...io, ...(o.now ? { now: o.now } : {}), ...(o.sleep ? { sleep: o.sleep } : {}) }),
      deliverOutbound: async (d: BootDelivery) => { deliveries.push(d); return o.deliver ? o.deliver(d) : { delivered: true }; },
      updateOriginSession: o.updateOriginSession,
      updateFailedText: o.updateFailedText ?? ((m: { outcome?: string }) => `FAILURE:${m.outcome ?? "none"}`), translate, bus: {}, DEFAULT_SESSION_ID: "dashboard:default",
      listSchedules: () => (o.reboot ? [{ id: 1 }] : []), getMostRecentTelegramChatId: () => "chat-recent",
      console: { error: (...a: unknown[]) => logs.push(a.join(" ")), warn() {}, log() {} },
    };
    const r = await new AsyncFunction(...Object.keys(deps), js + ";return {boot:typeof bootUpdateFailure===\"undefined\"?{consumed:updateFailedNotified,failure:null,delivered:false}:bootUpdateFailure,updateFailedNotified,updateNotified};")(...Object.values(deps));
    const successText = translate("srv.update.complete");
    const restartText = translate("srv.restart.complete");
    const success = deliveries.filter((d) => d.text === successText);
    const restart = deliveries.filter((d) => d.text === restartText);
    const failure = deliveries.filter((d) => d.text !== successText && d.text !== restartText);
    return { ...r, deliveries, success, failure, restart, logs, ends } as {
      boot: { consumed: boolean; failure: Record<string, unknown> | null; delivered: boolean }; updateFailedNotified: boolean; updateNotified: boolean;
      deliveries: BootDelivery[]; success: BootDelivery[]; failure: BootDelivery[]; restart: BootDelivery[]; logs: string[]; ends: number[];
    };
  };
};
