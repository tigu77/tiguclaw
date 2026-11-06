/**
 * 플러그인 발견이 동시에 몰려도 파일 open 은 유한하게 한다.
 * SubagentStop 1025건이 각자 전체 manifest 를 읽어 Windows에서 후속 소스 읽기까지
 * EMFILE 로 실패했다. 결과/발견 캐시가 아니다: 대기한 호출도 자기 파일을 새로 읽는다.
 * 따라서 켜기·끄기·내용 수정과 서로 다른 뿌리의 수명/격리 계약은 그대로다.
 */
import { promises as fs } from "node:fs";

const MAX_PLUGIN_READS = 16;
let active = 0;
const waiting: Array<() => void> = [];

export const readPluginText = async (file: string): Promise<string> => {
  await new Promise<void>((resolve) => {
    const enter = (): void => { active += 1; resolve(); };
    if (active < MAX_PLUGIN_READS) enter();
    else waiting.push(enter);
  });
  try {
    return await fs.readFile(file, "utf8");
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
};
