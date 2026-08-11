/**
 * 회귀: **칩으로 배우는 태그는 「명시했거나 아는 이름」뿐이다.**
 *
 * 사용자 신고 (2026-08-11): 로그를 붙여넣으면 그 안의 `#` 이 전부 컨텍스트 칩으로 학습돼
 *  바가 쓰레기로 찼다(`# 목표`·`#!/bin/sh`·`#1234`·`# TODO`).
 *
 * ★처음엔 **모양으로** 막으려 했다 — 구두점 시작 제외 · 줄 첫머리만 · 붙여넣기 추적 ·
 *  여러 줄 제외. 사용자가 멈춰 세웠다: **"예외가 너무 많은 게 별로다."** 맞는 지적이고,
 *  `#` 은 sh·python·yaml·toml·Makefile 의 **주석 문자**라 모양으로는 원리적으로 못 가린다.
 *  예외가 쌓인다는 건 **판정 기준이 없다**는 신호였다.
 *
 * 기준:
 *   배운다 = `#[이름]`(명시) ∪ `#이름` 중 **아는 이름**(프로젝트·스킬·에이전트·기존 칩)
 *
 * 이 한 줄이 예외를 전부 흡수한다 — 로그의 `#` 들은 아는 이름이 아니라서 안 걸린다.
 * 별도 규칙이 하나도 필요 없다. 새 태그는 `#[...]` 로 **의도해서** 태어난다.
 * 그래서 이 수정은 코드를 **덜어냈다**(붙여넣기 추적·구두점 규칙 삭제).
 *
 * ★배우는 것만 이 기준을 탄다 — 본문의 `#뭐든` 은 그냥 글자다(표시·활성 회귀 0).
 *
 * ★검사 등급 — **행동**이다. 판정을 `util.js` 순수 함수로 뽑아 `vm` 으로 실행한다.
 */
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import type { Assertion, RegressionCheck } from "./_framework.js";

const JS_DIR = new URL("../../../packages/dashboard/js/", import.meta.url);

interface Fns {
  learn?: (t: string, known: string[]) => string[];
  fmt?: (n: string) => string;
  scaffold?: (before: string) => boolean;
}

const load = async (): Promise<Fns> => {
  const src = await readFile(new URL("util.js", JS_DIR), "utf8");
  const grab = (re: RegExp): string | null => re.exec(src)?.[0] ?? null;
  const a = grab(/const learnableTagNames = \(text, knownNames\) => \{[\s\S]*?\n      \};/);
  const b = grab(/const formatTagToken = \(name\) => \{[\s\S]*?\n      \};/);
  const c = grab(/const shouldScaffoldTag = \(textBefore\) => \{[\s\S]*?\n      \};/);
  if (a === null || b === null || c === null) return {};
  const ctx: Fns = {};
  vm.createContext(ctx);
  vm.runInContext(
    `${a}\n${b}\n${c}\nlearn = learnableTagNames; fmt = formatTagToken; scaffold = shouldScaffoldTag;`,
    ctx,
  );
  return ctx;
};

/** 실제로 붙여넣을 법한 것 — `#` 가 주석·shebang·번호로 두루 나온다. */
const PASTED = [
  "#!/bin/sh",
  "## 목표",
  "# TODO: 나중에",
  "[2026-08-11] [log] build #1234 ok",
  "key=#1  # 설정 주석",
].join("\n");

const KNOWN = ["핫딜알리미", "Tigu Engine", "principle-check"];

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const { learn, fmt, scaffold } = await load();
  if (learn === undefined || fmt === undefined || scaffold === undefined) {
    return [{ name: "★util.js 판정 함수를 뽑아 실행한다", ok: false, got: "🔴 못 찾음" }];
  }

  // ── ① ★로그를 통째로 붙여넣어도 배우는 게 없다 — 예외 규칙 0으로 ────────
  {
    const got = learn(`이 로그 좀 봐줘\n${PASTED}`, KNOWN);
    out.push({
      name: "★로그·코드의 # 는 하나도 배우지 않는다(모양 규칙 없이)",
      ok: got.length === 0,
      got: got.length === 0 ? "학습 0" : `🔴 학습됨: ${got.join(", ")}`,
    });
  }

  // ── ② 아는 이름은 맨 태그로도 배운다(=최근 사용 갱신) ───────────────────
  {
    const got = learn("#핫딜알리미 확인해줘", KNOWN);
    out.push({
      name: "아는 이름은 #이름 으로 걸린다",
      ok: got.join(",") === "핫딜알리미",
      got: `[${got.join(", ")}]`,
    });
  }

  // ── ③ ★새 태그는 명시로 태어난다 — 그게 유일한 출생 통로 ────────────────
  {
    const born = learn("#[새 주제 하나] 로 묶어줘", KNOWN);
    const notBorn = learn("#새주제 로 묶어줘", KNOWN);
    out.push({
      name: "★모르는 이름은 #[...] 로만 태어난다(공백도 담긴다)",
      ok: born.join(",") === "새 주제 하나" && notBorn.length === 0,
      got: `명시=[${born.join(", ")}] · 맨태그=[${notBorn.join(", ")}] (기대 [새 주제 하나] / [])`,
    });
  }

  // ── ④ 섞여 있어도 각자 판정된다 ─────────────────────────────────────────
  {
    const got = learn(`#[Tigu Engine] 이랑 #핫딜알리미 봐줘\n${PASTED}`, KNOWN);
    out.push({
      name: "로그와 진짜 태그가 한 메시지에 섞여도 진짜만 걸린다",
      ok: got.join("|") === "Tigu Engine|핫딜알리미",
      got: `[${got.join(", ")}]`,
    });
  }

  // ── ⑤ 공백 있는 이름을 쓰는 모양 — 실물 근거(`Tigu Engine`) ─────────────
  {
    out.push({
      name: "★공백 이름은 #[...] 로 쓴다(맨 태그로는 잘려 못 쓰던 것)",
      ok: fmt("Tigu Engine") === "#[Tigu Engine]" && fmt("핫딜알리미") === "#핫딜알리미",
      got: `${fmt("Tigu Engine")} · ${fmt("핫딜알리미")}`,
    });
  }

  // ── ⑥ 스캐폴드는 줄 첫머리에서만 ────────────────────────────────────────
  //  처음엔 "공백 뒤" 였는데 **헤드리스로 실제 타이핑해서** 잡았다 — `issue #123` 도
  //  공백 뒤라 똑같이 걸렸다. 코드를 읽어선 안 보이고 쳐봐야 보이는 부류다.
  {
    const yes = ["", "앞줄\n"];
    const no = ["issue ", "확인해줘 ", "C", "key="];
    out.push({
      name: "★줄 첫머리에서만 #[] 가 깔린다(문장 중간 글쓰기 무방해)",
      ok: yes.every((v) => scaffold(v)) && no.every((v) => !scaffold(v)),
      got: [...yes, ...no].map((v) => `${JSON.stringify(v)}=${scaffold(v)}`).join(" "),
    });
  }

  // ── ⑦ ★새 태그를 만드는 통로가 커서 어디서든 있다 ───────────────────────
  //  사용자 요청: "첫머리 말고도 가능하게". 자동 스캐폴드를 넓히는 건 답이 아니다 —
  //  `issue #123` 이 `issue #[123]` 이 되는데 대괄호는 명시형이라 **무조건 배운다**
  //  (예전엔 그냥 글자였다). 문장 중간의 `#` 이 태그인지는 모양으로 못 가린다.
  //  그래서 추측을 넓히지 않고 **의도를 받는다** — 컨텍스트 바의 "＋ 새 태그" 가
  //  커서 자리에 `#[]` 를 넣는다. 오탐 0, 예외 0.
  {
    const vp = await readFile(new URL("view-projects.js", JS_DIR), "utf8");
    const hasAdd = /ctx-add/.test(vp) && /＋ 새 태그/.test(vp);
    const insertsAtCaret = /ta\.selectionStart[\s\S]{0,400}?"#\[\]"/.test(vp);
    const padsWord = /!\/\\s\$\/\.test\(v\.slice\(0, a\)\)/.test(vp);
    out.push({
      name: "★커서 어디서든 새 태그를 만들 수단이 있다(자동 추측을 넓히는 대신)",
      ok: hasAdd && insertsAtCaret,
      got: `＋칩=${hasAdd} · 커서 삽입=${insertsAtCaret}`,
    });
    out.push({
      name: "앞 단어에 붙지 않게 한 칸 띄운다",
      ok: padsWord,
      got: padsWord ? "공백 보정 있음" : "🔴 앞 단어에 들러붙는다",
    });
  }

  // ── ⑧ 배선 — 예외 더미가 되살아나지 않았는가 ────────────────────────────
  {
    const vp = await readFile(new URL("view-projects.js", JS_DIR), "utf8");
    const util = await readFile(new URL("util.js", JS_DIR), "utf8");
    const usesCriterion = /learnableTagNames\(text, known\)/.test(vp);
    const noPasteHack = !/pastedChunks|stripPastedChunks/.test(vp + util);
    out.push({
      name: "★판정 하나만 쓰고, 붙여넣기 추적 같은 우회는 없다",
      ok: usesCriterion && noPasteHack,
      got: `기준 사용=${usesCriterion} · 우회 부활=${!noPasteHack}`,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "context-tag-learning",
  guards:
    "로그를 붙여넣으면 그 안의 # 가 전부 컨텍스트 칩으로 학습돼 바가 쓰레기로 차던 것 — # 은 여러 언어의 주석 문자라 모양으로는 못 가린다. 배우는 것은 명시(#[이름])이거나 아는 이름일 때뿐",
  run,
};
