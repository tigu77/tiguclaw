/**
 * 회귀: **Claude 턴도 프리픽스 지문을 남기고, 어느 슬롯이 바뀌었는지 이름으로 말한다** (2026-09-24).
 *
 * ★사고: 09-23 돌쇠에서 같은 스레드·같은 모델의 후속 턴이 36초 뒤에도 앞 40,695 토큰만 캐시로
 *  다시 썼다(3턴 연속, 가끔 0%). 캐시 제외 입력의 62% 가 턴 첫 요청에서 나왔다. 그런데 Codex 는
 *  요청마다 지문을 남기는데 **Claude 는 없어서** 무엇이 바뀌었는지 로그로 가를 수 없었다
 *  (`docs/decisions/2026-09-24-natural-usage-after-session-id.md`).
 *
 * 지키는 것:
 *  ① 판정(`describeSlotChange`) — 첫 턴 «처음», 같으면 «없음», 다르면 **바뀐·생긴·빠진 슬롯 이름**,
 *     순서만 바뀌면 «순서바뀜». «처음» 과 «없음» 을 섞지 않는다.
 *  ② 스레드마다 따로 기억한다(다른 대화의 턴과 견주지 않는다).
 *  ③ 같은 이름 슬롯이 둘이어도 둘 다 잰다(뒤엣것이 앞엣것을 덮지 않는다).
 *  ④ Claude 어댑터가 `system/init` 에서 사다리·슬롯·도구 변화를 **한 줄로** 남긴다(소스 대조 —
 *     SDK 를 가짜로 끼우는 통로가 없어 배선은 글자로 잰다. 약한 등급이라 배포 후 로그로 재확인).
 *
 * 등급: ①~③ 동작(판정 함수 실행) · ④ 소스 대조.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeSlotChange,
  rememberSlotHashes,
  slotHashes,
} from "../../core/llm-runtime/prefix-fingerprint.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "claude-prefix-says-which-slot",
  guards:
    "Claude 후속 턴이 같은 스레드·모델에서도 앞 4만 토큰만 캐시를 재사용했는데, Codex 와 달리 Claude 는 프리픽스 지문이 없어 어느 조각이 바뀌었는지 로그로 가를 수 없던 것",
  run: async (): Promise<Assertion[]> => {
    const base = [
      { key: "sysprompt", text: "S" },
      { key: "system", text: "헌법" },
      { key: "agent", text: "AGENT" },
      { key: "memoryIndex", text: "m1" },
    ];
    const a = slotHashes(base);
    const same = slotHashes(base.map((s) => ({ ...s })));
    const changed = slotHashes(base.map((s) => (s.key === "memoryIndex" ? { ...s, text: "m2" } : s)));
    const added = slotHashes([...base, { key: "modelProfiles", text: "p" }]);
    const removed = slotHashes(base.filter((s) => s.key !== "agent"));
    const reordered = slotHashes([base[0], base[2], base[1], base[3]]);
    const dup = slotHashes([{ key: "x", text: "1" }, { key: "x", text: "2" }]);

    const T1 = `regr-slot-${process.pid}-a`;
    const T2 = `regr-slot-${process.pid}-b`;
    const firstT1 = describeSlotChange(a, rememberSlotHashes(T1, a));
    const firstT2 = describeSlotChange(changed, rememberSlotHashes(T2, changed));
    const secondT1 = describeSlotChange(changed, rememberSlotHashes(T1, changed));

    const adapter = readFileSync(
      path.join(REPO, "src/core/llm-runtime/adapters/claude-agent-sdk.ts"),
      "utf8",
    ).replace(/^\s*\/\/.*$/gm, "");
    const initAt = adapter.indexOf('msg.subtype === "init"');
    const initBlock = initAt < 0 ? "" : adapter.slice(initAt, initAt + 1800);

    return [
      assert("① 첫 턴은 «처음»(«없음» 과 섞지 않는다)", describeSlotChange(a, undefined) === "슬롯변화=처음", describeSlotChange(a, undefined)),
      assert("① 같으면 «없음»", describeSlotChange(same, a) === "슬롯변화=없음", describeSlotChange(same, a)),
      assert(
        "★① 바뀐 슬롯을 **이름으로** 말한다(그것만)",
        describeSlotChange(changed, a) === "슬롯변화=바뀜[memoryIndex]",
        describeSlotChange(changed, a),
      ),
      assert("① 생긴 슬롯", describeSlotChange(added, a) === "슬롯변화=생김[modelProfiles]", describeSlotChange(added, a)),
      assert("① 빠진 슬롯", describeSlotChange(removed, a) === "슬롯변화=빠짐[agent]", describeSlotChange(removed, a)),
      assert("① 내용은 같고 순서만 바뀌면 «순서바뀜»(순서도 프리픽스다)", describeSlotChange(reordered, a) === "슬롯변화=순서바뀜", describeSlotChange(reordered, a)),
      assert(
        "② 스레드마다 따로 기억한다(다른 대화의 턴과 견주지 않는다)",
        firstT1 === "슬롯변화=처음" && firstT2 === "슬롯변화=처음" && secondT1 === "슬롯변화=바뀜[memoryIndex]",
        `${firstT1} · ${firstT2} · ${secondT1}`,
      ),
      assert("③ 같은 이름 슬롯 둘을 둘 다 잰다", dup.size === 2, [...dup.keys()].join(",")),
      assert(
        "④ Claude 어댑터가 `system/init` 에서 사다리·슬롯·도구 변화를 한 줄로 남긴다(소스 대조)",
        /\[claude-prefix\]/.test(initBlock) &&
          /sysSlotNote/.test(initBlock) &&
          /sysFpNote/.test(initBlock) &&
          /describeToolChange\(tools, rememberToolNames\(prefixKey, tools\)\)/.test(initBlock) &&
          /describeSlotChange\(sysSlots, rememberSlotHashes\(prefixKey, sysSlots\)\)/.test(adapter) &&
          /\.\.\.stableSlots/.test(adapter),
        initBlock === "" ? "★init 분기를 못 찾음" : "배선 확인",
      ),
    ];
  },
};
