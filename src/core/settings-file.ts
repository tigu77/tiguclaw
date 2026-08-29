// src/core/settings-file.ts
/**
 * **설정 파일을 읽고 쓰는 한 자리** — 읽기는 관대하게, **쓰기는 거부한다** (2026-08-29).
 *
 * ★사고: 적대 검토가 잡았다. `settings.json` 이 파싱 불가일 때 쓰기 함수들이 그 실패를
 *  **삼키고 `{}` 에서 시작**해, 그 `{}` 를 파일에 원자 교체로 덮었다. `models.profiles`·
 *  `theme`·`gateway`·`hooks` 가 **한 번에, 비가역으로, 성공 메시지와 함께** 사라진다.
 *
 *  실측(격리 홈):
 *  ```
 *  전: {"models":{"profiles":{...}},"theme":"dusk",     ← 콤마로 끝나 파싱 불가
 *  후: { "dashboard": { "home": { "widgets": [ ... ] } } }   ← 나머지 전부 소실
 *  ```
 *
 * ★**같은 관용구가 11곳이었다**(코어 9 + 홈 위젯·플러그인 설정 2 — 세어서 적었다). 그래서 호출부마다 고치지
 *  않고 **판정을 여기로 모은다** — 손으로 아홉 번 맞추는 것은 이 레포가 반복해서 데인 형태다
 *  ([[feedback_hand_maintained_lists]]).
 *
 * ★**핵심은 「없다」와 「깨졌다」를 가르는 것**이다. 종전 코드는 둘을 같은 `catch` 로 묶었다:
 *   - **없다/비었다** → 새로 만드는 게 맞다. 첫 설치가 그 경로다.
 *   - **깨졌다** → 사용자가 손으로 고쳤거나 다른 도구가 망쳤다는 뜻이고, 그 위에 덮는 것은
 *     **남의 데이터를 지우는 일**이다. 여기서 멈추고 말하는 게 맞다.
 *
 * ★**읽기는 여전히 관대하다.** 화면·조회가 깨진 파일 하나로 죽으면 사용자는 고칠 수단까지
 *  잃는다. 그래서 읽기는 `{}` 로 물러서고(그리고 경고를 남기고), **쓰기만** 거부한다.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 파싱 불가한 설정 파일 위에 쓰려 했을 때. 호출부가 사용자에게 그대로 전할 수 있는 문장. */
export class SettingsFileCorruptError extends Error {
  constructor(
    readonly file: string,
    readonly detail: string,
  ) {
    super(
      `설정 파일을 읽을 수 없어 쓰기를 멈췄습니다: ${file}\n` +
        `사유: ${detail}\n` +
        `★덮어쓰면 이 파일의 다른 설정(모델 프로파일·테마 등)이 함께 사라집니다. ` +
        `파일을 고친 뒤 다시 시도하세요.`,
    );
    this.name = "SettingsFileCorruptError";
  }
}

const asObject = (parsed: unknown): Record<string, unknown> | undefined =>
  parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;

/**
 * **읽기** — 못 읽으면 `{}`. 조회·화면이 깨진 파일 하나로 죽지 않게.
 *
 * ★경고는 남긴다. 조용히 빈 값을 주면 "설정이 왜 안 먹지" 를 아무도 못 잡는다
 *  ([[feedback_logs_must_stand_alone]]).
 */
export const readSettingsRootLenient = (file: string): Record<string, unknown> => {
  try {
    if (!existsSync(file)) return {};
    const text = readFileSync(file, "utf8");
    if (text.trim() === "") return {};
    const obj = asObject(JSON.parse(text) as unknown);
    if (obj === undefined) {
      console.warn(`[settings-file] ${file}: 최상위가 객체가 아닙니다 — 빈 설정으로 봅니다.`);
      return {};
    }
    return obj;
  } catch (e) {
    console.warn(
      `[settings-file] ${file}: 읽지 못했습니다(${e instanceof Error ? e.message : String(e)}) — 빈 설정으로 봅니다.`,
    );
    return {};
  }
};

/**
 * **쓰기 전 읽기** — 깨져 있으면 **던진다.** 없거나 비었으면 `{}`(새로 만드는 정상 경로).
 *
 * ★이 함수가 이 파일의 요점이다. 여기서 `{}` 를 돌려주면 호출부가 그걸 파일에 덮고,
 *  그 순간 사용자의 다른 설정이 사라진다.
 */
export const readSettingsRootForWrite = (file: string): Record<string, unknown> => {
  if (!existsSync(file)) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new SettingsFileCorruptError(file, e instanceof Error ? e.message : String(e));
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    throw new SettingsFileCorruptError(file, e instanceof Error ? e.message : String(e));
  }
  const obj = asObject(parsed);
  if (obj === undefined) {
    throw new SettingsFileCorruptError(file, "최상위가 객체가 아닙니다(배열·스칼라)");
  }
  return obj;
};

/**
 * 원자 교체 — 임시 파일에 쓰고 `rename`. 부분 쓰기가 파일을 반쪽으로 만들지 않는다.
 *
 * ★이것도 아홉 곳에 복사돼 있던 관용구다. 한 곳에 두면 `tmp` 이름 규칙·`mkdir` 누락 같은
 *  것이 한 번만 존재한다.
 */
export const writeSettingsRootAtomic = (
  file: string,
  root: Record<string, unknown>,
): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
};
