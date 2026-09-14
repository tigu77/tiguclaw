import { realpath } from "node:fs/promises";
import path from "node:path";

// 서버/턴이 달라도 같은 프로세스의 동일 파일 수정은 읽기부터 쓰기까지 한 단위다.
// 다른 파일은 기다리지 않는다. 외부 편집기·셸·다른 프로세스의 쓰기 잠금은 아니다.
const tails = new Map<string, Promise<unknown>>();

export const withFileMutation = async <T>(absolutePath: string, run: () => Promise<T>): Promise<T> => {
  let key: string;
  try {
    key = await realpath(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Write는 부모 생성 후 들어온다. 새 파일도 부모 심링크의 별칭을 정규화한다.
    key = path.join(await realpath(path.dirname(absolutePath)), path.basename(absolutePath));
  }
  const pending = (tails.get(key) ?? Promise.resolve()).then(run, run);
  tails.set(key, pending);
  try {
    return await pending;
  } finally {
    if (tails.get(key) === pending) tails.delete(key);
  }
};
