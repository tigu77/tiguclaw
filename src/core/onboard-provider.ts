/**
 * **온보딩이 고른 provider 판정 — 리프** (2026-08-13).
 *
 * ★왜 `cli.ts` 가 아니라 여기인가: cli.ts 는 **import 만으로 CLI 를 실행**한다(top-level
 *  디스패치). 회귀가 이 판정을 실행해 보려고 import 했더니 도움말이 찍히고 프로세스가
 *  끝났다 — 스위트가 통째로 사라졌다. 검사가 껄끄러운 건 대개 코드가 잘못 놓였다는 뜻이라
 *  (Q7), 판정만 의존 0 리프로 뽑는다. 소비자는 cli.ts 하나지만 **실행 가능**해진다.
 */

/**
 * codex OAuth 발급이 필요한 설치인가 — `.env` 본문으로 판정(파일 I/O 는 호출자 몫).
 *
 * ★진실 소스는 `TIGUCLAW_PROVIDER`(init 이 명시로 남긴다). 종전엔 `REGION_A_MODELS`
 *  접두로 **유추**했는데, 모델을 자동으로 두는 모드(프로파일·env 를 일부러 비움)에서는
 *  그 값이 비어 codex 를 골라도 인증 단계를 통째로 건너뛴다 — 무인증으로 데몬이 뜨고
 *  자동 카탈로그도 codex 를 못 본다. 에러도 안 난다(빈 값이니까).
 * ★옛 설치 호환으로 REGION_A_MODELS 폴백은 남긴다(그때 쓴 .env 엔 새 키가 없다).
 */
export const codexProviderFromEnvBody = (body: string): boolean => {
  const explicit = body.match(/^TIGUCLAW_PROVIDER=(.*)$/m);
  if (explicit !== null && explicit[1]!.trim() !== "") {
    return explicit[1]!.trim() === "codex";
  }
  const m = body.match(/^REGION_A_MODELS=(.*)$/m);
  return m !== null && m[1]!.trim().startsWith("codex");
};
