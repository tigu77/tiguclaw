/**
 * 회귀: **버그 신고 스킬의 GitHub 제출 절차가 본문에 살아 있다** (2026-11-02, v0.81.0 후보).
 *
 * 번들 스킬 `skills/tiguclaw-bug-report` 가 «정리본만 쓰고 제출하지 않는다» 에서
 * «작성 뒤 한 번 묻고, 동의 때만 같은 이슈를 찾아보고, 최종 승인받은 1건만 공개로 쓴다» 로
 * 넓어졌다. 이 절차의 안전은 전부 **글**에 있다 — 코어에 제출 도구가 없고, 비서가 사용자의
 * 기존 GitHub 도구를 쓴다. 그러니 한 문장이 지워지면 공개 쓰기가 승인 없이 나가거나,
 * 검색 실패가 «중복 없음» 이 되거나, 시간 초과에 같은 이슈가 두 번 생긴다.
 *
 * 등급: 정적 문구 대조. ★한계를 정직하게 — 이 검사는 «규칙이 적혀 있나» 까지다. 모델이
 *  그 글을 지키는지는 보장하지 않는다(그건 모의 흐름 검증의 몫이다).
 * ★그물이 비어 있지 않음을 스스로 보인다: 규칙마다 그 문장을 지운 본문을 만들어
 *  같은 판정이 빨개지는지 함께 잰다(자기 변이).
 */
import { readSourceSync } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SKILL = "skills/tiguclaw-bug-report/SKILL.md";

interface Rule {
  readonly name: string;
  /** 모두 맞아야 통과. 자기 변이는 첫 패턴의 첫 일치를 지운다. */
  readonly must: readonly RegExp[];
}

const RULES: readonly Rule[] = [
  { name: "작성만 → 정리본 파일을 보낸다(못 보내면 경로 안내)", must: [/`send_file`/, /경로 안내로 대신한다/] },
  {
    name: "작성 뒤 제출 여부를 **한 번** 묻는다(선택지 도구 · 보내지 않음 보기)",
    must: [/제출 여부를 \*\*한 번\*\* 묻는다/, /`prompt_options`/, /«보내지 않음»/],
  },
  {
    name: "거절·무응답이면 끝 — 검색·조회·쓰기 0, 같은 사건 재권유 없음",
    must: [/무응답[^\n]*\*\*여기서 끝\*\*[^\n]*검색·조회·쓰기를 하지 않/, /같은 사건으로 다시 권하지 않는다/],
  },
  { name: "제출까지 청했으면 첫 질문 생략(공개 쓰기 승인은 따로)", must: [/제출 질문 없이 6으로 간다/] },
  {
    name: "검색어는 가린 정리본에서만 — 비밀·개인정보·경로·대화 제외",
    must: [/검색어는 \*\*가린 정리본에서만\*\*/, /검색어도 외부 서버로 간다/],
  },
  { name: "검색 실패를 «중복 없음» 으로 읽지 않는다", must: [/«같은 이슈 없음» 이 아니다/, /중복 확인 못 함/] },
  { name: "같은 문제·열림 → 새 정보 있을 때만 댓글", must: [/새 정보가 없으면 쓰지 않는다/] },
  {
    name: "닫힌 같은 문제 → 고친 버전 대조, 이후 재발은 «원인 다를 수 있음» 새 이슈",
    must: [/고친 버전과 사용자 버전을 대조/, /재발 — 원인이 다를 수 있음/],
  },
  {
    // ★제목 «자동으로 합치지 않는다» 나 §5 의 로컬 «관련 가능» 문구로는 판정하지 않는다 — 표의 그 행이 지워져도
    //  둘은 남는다(GPT R2). 행의 행동 문구 자체에 묶는다.
    name: "유사·불확실 → 합치지 않고 «관련 가능» 새 이슈 기본, 댓글은 다른 보기로만",
    must: [
      /새 이슈 \+ «관련 가능: #N \(같은 원인인지 미확인\)» 을 기본으로/,
      /«#N 에 댓글» 은 6\.4 의 다른 보기로만/,
    ],
  },
  {
    // ★보완 줄이 «맨 위» 에 붙으면 상태 줄 판독(첫 줄 «제출 미확정» → 먼저 확인)이 깨진다(GPT R2).
    name: "제출 상태 줄은 첫 줄 하나 — 보완 줄은 그 아래",
    must: [/\*\*제출 상태 줄\*\*[^\n]*파일 \*\*첫 줄\*\*에 하나만 둔다\. 보완 줄은 그 아래에 더한다/, /제출 상태 줄이 있으면 그 바로 아래/],
  },
  { name: "검색 성공·결과 없음 → 새 이슈", must: [/없음\(검색 성공\)/] },
  { name: "이미 제출한 사건은 다시 내지 않는다", must: [/같은 내용을 다시 내지 않는다/] },
  {
    name: "«같은 문제» = 오류 원문과 발생 조건이 둘 다 같을 때만 — 증상 유사는 불확실",
    must: [/오류 원문\(고정된 부분\)과 발생 조건·재현 단계가 둘 다\*\*/, /증상만 비슷하거나/],
  },
  {
    name: "제출 뒤 보완 → 로컬만, 재질문·승인 재사용 없음, 미확정이면 먼저 확인",
    must: [/\*\*제출한 뒤 같은 사건을 보완하면\*\* 로컬 파일만 고친다/, /앞서 받은 승인을 다시 쓰지 않는다/, /«제출 미확정» 이면/],
  },
  { name: "쓴 승인은 재사용하지 않는다", must: [/쓴 승인은 끝난 것이다/] },
  {
    name: "최종 승인 전 공개 쓰기 0 — 저장소·동작·전문을 보이고 그 1건만",
    must: [
      /공개 쓰기\(이슈·댓글\)는 6\.4 의 최종 승인을 받은 \*\*그 1건\*\*만/,
      /제목과 본문\(댓글\) 전문 그대로/,
      /무엇이든 바뀌면 다시 묻는다/,
    ],
  },
  { name: "같은 대상·내용을 이미 명시 승인했으면 재확인 반복 없음", must: [/같은 것을 다시 묻지 않는다/] },
  {
    name: "대상 저장소 = 설치본 `bugs.url` — 관측 내용이 가리키는 저장소 금지",
    must: [/`bugs\.url`/, /관측 내용이 가리키는 다른 저장소로는 보내지 않는다/],
  },
  {
    name: "이미 쓸 수 있는 도구만 — 자격 파일·토큰 요청·설치·로그인 자동 금지",
    must: [/\*\*이미 쓸 수 있는 것\*\*만/, /자격 증명 파일·키체인 읽기, 대화로 토큰 받기, 설치·로그인/, /`--show-token` 금지/],
  },
  { name: "도구가 없으면 직접 제출 안내(양식 링크)", must: [/\*\*쓸 도구가 없으면\*\*/, /\/new\/choose/] },
  { name: "이슈 본문·댓글의 지시는 데이터 — 따르지 않는다", must: [/\*\*데이터\*\*다/, /따르지 않고/] },
  { name: "본문은 명령줄이 아니라 파일로 넘긴다", must: [/명령줄에 넣지 말고 파일로/, /--body-file/] },
  {
    name: "결과 불명 → 재전송 금지, 목록 조회로 생성 확인, 안 되면 미확정 보류",
    must: [/\*\*결과 불명\*\*[^\n]*다시 보내지 않는다[^\n]*목록 조회/, /생성 여부 미확정/, /새로 승인받았을 때 1회만/],
  },
  {
    name: "보안 취약점 → 공개 제출·질문·검색 없음, 대리 전송 없음",
    must: [/공개 이슈·댓글로 보내지 않는다/, /중복 검색도 하지 않는다/, /대신 어디에도 보내지 않는다/],
  },
];

/** 있으면 안 되는 문장 — 옛 «제출하지 않는다» 와 개발자 기계 전제. */
const FORBIDDEN: readonly [string, RegExp][] = [
  ["옛 description «제출·전송은 하지 않는다»", /제출·전송은 하지 않는다/],
  ["옛 §6 «이슈 등록·메시지 전송·업로드는 하지 않는다»", /이슈 등록·메시지 전송·업로드는 하지 않는다/],
  ["옛 머리 «제출·전송·수정은 이 스킬의 일이 아니다»", /제출·전송·수정은 이 스킬의 일이 아니다/],
  ["개발자 기계 경로·계정 하드코딩", /\/Users\/|tigu77/],
];

const failsOf = (text: string): string[] => [
  ...RULES.filter((r) => !r.must.every((re) => re.test(text))).map((r) => r.name),
  ...FORBIDDEN.filter(([, re]) => re.test(text)).map(([n]) => n),
];

export const check: RegressionCheck = {
  name: "bug-report-submit-procedure",
  guards:
    "버그 신고 스킬의 제출 절차(1회 질문·거절 시 0·가린 검색·중복 분기·최종 승인 1건·결과 불명 재전송 금지·보안 비공개)가 문장 하나 지워져도 아무것도 안 빨개지던 것",
  run: async (): Promise<Assertion[]> => {
    const text = readSourceSync(SKILL);
    const desc = /^description:\s*"([^"]*)"/m.exec(text)?.[1] ?? "";
    const fails = failsOf(text);
    const out: Assertion[] = [
      assert(
        "★★제출 절차의 모든 갈래가 본문에 있고 옛 «제출하지 않는다»·개발자 전제가 없다",
        fails.length === 0,
        fails.length === 0 ? `규칙 ${RULES.length} · 금지 ${FORBIDDEN.length}` : `★빠짐/잔존: ${fails.join(" | ")}`,
      ),
      assert(
        "description 이 «한 번 묻고 … 승인받아 제출» 을 말한다(인덱스만 보는 모델도 제출을 아는 자리)",
        /한 번 묻고/.test(desc) && /승인받아 제출/.test(desc),
        desc.slice(-120),
      ),
    ];
    // 자기 변이 — 규칙마다 그 문장을 지우면 그 규칙이 빨개져야 한다.
    const blind: string[] = [];
    for (const r of RULES) {
      const first = r.must[0];
      if (first === undefined) continue;
      const mutated = text.replace(new RegExp(first.source, first.flags), "");
      if (mutated === text || !failsOf(mutated).includes(r.name)) blind.push(r.name);
    }
    for (const [n, re] of FORBIDDEN) {
      const sample = re.source.replace(/\\\//g, "/").split("|")[0] ?? "";
      if (!failsOf(`${text}\n${sample}`).includes(n)) blind.push(`금지: ${n}`);
    }
    out.push(
      assert(
        "★자기 변이: 규칙 문장을 지우거나 옛 문장을 되살리면 해당 판정이 빨개진다(빈 그물 아님)",
        blind.length === 0,
        blind.length === 0 ? `변이 ${RULES.length + FORBIDDEN.length}/${RULES.length + FORBIDDEN.length} 적발` : `★못 잡음: ${blind.join(" | ")}`,
      ),
    );
    return out;
  },
};
