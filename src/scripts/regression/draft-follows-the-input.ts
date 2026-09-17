/**
 * 회귀: **저장된 draft 가 입력창을 따라간다 — 떠날 때 한 번은 반드시 저장한다** (2026-09-17)
 *
 * 잡는 것: 입력창을 **비우고 새로고침하면 옛 글이 되살아나던 것**(정태님 신고:
 * *"지우고 새로고침하면 또 채워져있어"*).
 *
 * ★뿌리는 «주인이 없다» 였다. draft 를 쓰는 자리가 **다섯인데 전부 특수 경로**다 — 탭 전환
 *  둘 · 전송 실패 복원 하나 · 다른 방 보관 둘. 정작 텍스트를 쥔 **입력창이 바뀔 때는 아무도
 *  안 저장**했고 `pagehide` 도 없었다. 그래서 «비운 것» 이 기록되지 않고, 저장분과 화면이
 *  갈리면 **갈린 쪽이 살아남았다.**
 *
 * ★언제부터 — `88e4d42b`(2026-09-15 16:01). 1분 앞선 `14196785` 는 전송 실패 시 입력창만
 *  채웠고 새로고침이 알아서 치웠다. 그 커밋이 적대 검토 O4 를 고치려고 복원을 **영속**
 *  시키면서 열렸다([[feedback_my_fixes_are_the_defect_source]] 의 전형 — 검토 결함을 고친
 *  수정이 새 결함을 만들었다).
 *
 * ★**등급 — 배선 린트다.** 이 레포 회귀는 Chrome 을 띄우지 않는다(전수 확인). 진짜 판정은
 *  헤드리스 프로브 `_workspace/_draft_full_cdp.mjs` 이고, 그건 실제 502 전송 실패 → 지움 →
 *  **실제 새로고침**까지 돌린다. 수정 전/후 실측:
 *
 *      ①타이핑→새로고침 🔴→✅ · ②a 502 심김 ✅→✅ · ②b 지우고→새로고침 🔴→✅
 *      ③전송 성공 ✅→✅ · ④프로그램 주입 🔴→✅ · ⑤탭 전환 ✅→✅ · ⑥탭 둘 🔴→🔴(미수정)
 *
 * ★**이 검사의 한계를 먼저 적는다.** 소스를 훑는 검사는 조건 한 칸·동의어·`if (false)` 로
 *  뚫린다(2026-09-17 레드팀이 정확히 그 축을 넷 뚫었다). 그래서 여기서는 **무력화하는 가장
 *  자연스러운 편집**만 겨냥한다 — `saveOnLeave` 안에 «내용이 있을 때만» 조건을 붙이는 것.
 *  그게 붙으면 «비운 것을 기록하지 않는다» 가 되어 **결함이 그대로 부활**한다.
 *  더 강한 그물이 필요해지면 프로브를 회귀로 올려야 하고, 그건 Chrome 의존을 들이는 별개
 *  결정이다([[feedback_gate_must_actually_run]]: 지키지도 못하면서 지킨다고 적어둔 검사가
 *  가장 나쁘다).
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = new URL("../../../", import.meta.url);
/** 주석은 검사 대상이 아니다 — 결함을 *설명한* 글을 코드로 세면 상시 실패한다. */
const codeOnly = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

export const check: RegressionCheck = {
  name: "draft-follows-the-input",
  guards:
    "입력창을 비우고 새로고침하면 옛 draft 가 되살아나던 것 — draft 를 쓰는 자리가 특수 경로 다섯뿐이고 «비운 것» 을 기록하는 자리가 없었다",
  run: async (): Promise<Assertion[]> => {
    const src = codeOnly(
      await readFile(new URL("packages/dashboard/js/chat-send.js", REPO), "utf8"),
    );

    const self = await readFile(
      new URL("src/scripts/regression/draft-follows-the-input.ts", REPO),
      "utf8",
    );
    const selfRef = {
      probe: /_workspace\/_draft_full_cdp\.mjs/.test(self),
      grade: /등급 — 배선 린트다/.test(self),
      bytes: self.length,
    };
    const leaveFn = /const saveDraftOnLeave = \(\) => \{[\s\S]*?\n {6}\};/.exec(src)?.[0] ?? "";
    // ★함수 본문으로 **좁힌다** — 넓게 잡으면 `[\s\S]*?` 가 `saveChatDraft` 를 넘어
    //  `clearChatDraft` 의 `delete` 까지 읽는다(자기 변이 O6 에서 적발: delete 분기를
    //  지워도 초록이었다).
    const saveFn = /window\.saveChatDraft = \(tk\) => \{[\s\S]*?\n {6}\};/.exec(src)?.[0] ?? "";

    return [
      assert(
        "★**떠날 때 저장한다** — 이 훅이 없으면 «비운 것» 이 기록될 자리가 아예 없다",
        /window\.addEventListener\("pagehide", saveDraftOnLeave\)/.test(src) &&
          /document\.addEventListener\("visibilitychange"/.test(src) &&
          /document\.visibilityState === "hidden"/.test(src),
        `pagehide ${/addEventListener\("pagehide"/.test(src)} · visibilitychange ${/addEventListener\("visibilitychange"/.test(src)} · hidden 판정 ${/visibilityState === "hidden"/.test(src)}`,
      ),
      assert(
        "★**무조건 저장한다** — «내용이 있을 때만» 조건이 붙으면 결함이 그대로 부활한다",
        // ★이게 이 검사의 핵심이고, 수정안을 쓰기 전에 «무력화하는 가장 자연스러운 편집» 을
        //  물어서 나온 답이다. `saveChatDraft` 가 이미 «비면 delete» 를 하므로, 여기에
        //  내용 조건을 다는 순간 빈 입력창이 저장소에 반영되지 않는다.
        leaveFn !== "" &&
          !/\binput\.value\b/.test(leaveFn) &&
          !/\.trim\(\)/.test(leaveFn) &&
          !/pendingAttachments/.test(leaveFn) &&
          // 저장 함수는 «비면 delete» 를 하는 그것이어야 한다 — `stashChatDraft` 는 빈 텍스트면
          // 옛 값을 유지하므로 여기 쓰면 결함이 부활한다.
          /window\.saveChatDraft\(activeThreadKey\)/.test(leaveFn) &&
          !/stashChatDraft/.test(leaveFn),
        `본문(${leaveFn.length}자) 내 내용조건 ${/\binput\.value\b|\.trim\(\)|pendingAttachments/.test(leaveFn)} · saveChatDraft ${/window\.saveChatDraft\(activeThreadKey\)/.test(leaveFn)} · stash 오용 ${/stashChatDraft/.test(leaveFn)}`,
      ),
      assert(
        "★«비면 지운다» 는 판정이 `saveChatDraft` 에 **그대로 남아 있다** — 위 훅이 그걸 빌린다",
        // 새 판정을 만들지 않은 것이 이 수정의 값이다. 저 규칙이 사라지면 훅만 남아 무해해진다.
        saveFn !== "" && /chatDrafts\.delete\(tk\);/.test(saveFn),
        `saveChatDraft 본문(${saveFn.length}자) 내 delete 분기 ${/chatDrafts\.delete\(tk\);/.test(saveFn)}`,
      ),
      assert(
        "전송 성공 시 draft 를 비우는 자리가 남아 있다 — 떠날 때 저장이 그걸 대체하지 않는다",
        /window\.clearChatDraft\(activeThreadKey\)/.test(src),
        `전송 후 clear ${/window\.clearChatDraft\(activeThreadKey\)/.test(src)}`,
      ),
      assert(
        "★진짜 판정이 어디 있는지 **글로 남아 있다** — 린트를 그물로 오해하지 않게",
        selfRef.probe && selfRef.grade,
        `헤더: 프로브 경로 ${selfRef.probe} · 등급 표기 ${selfRef.grade} (자기 파일 ${selfRef.bytes}자)`,
      ),
    ];
  },
};
