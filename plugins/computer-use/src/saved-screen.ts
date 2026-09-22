/** 기존 화면 파일에 대한 서명된 읽기 영수증. 화면/입력 드라이버와 프레임 장부에 접근하지 않는다. */
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { FRAME_MAX_BYTES } from "./observe.js";

const KEY_FILE = ".saved-screen-key";
const digest = (data: string | Buffer): string => createHash("sha256").update(data).digest("base64url");
// 대화 ID는 서명 입력에만 묶는다. 참조에 중복 저장하지 않아 노출·전송량을 줄인다.
type Receipt = { v: 1; file: string; at: string; sha256: string };

const keyFor = async (dir: string, create: boolean): Promise<Buffer> => {
  const file = path.join(dir, KEY_FILE);
  try {
    const key = await fs.readFile(file);
    if (key.length !== 32) throw new Error("저장본 서명 키가 유효하지 않습니다.");
    return key;
  } catch (e) {
    if (!create || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // 완성된 키만 공개한다. 병렬 최초 캡처도 서로 다른 키로 서명하지 않는다.
  const temp = path.join(dir, `${KEY_FILE}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, randomBytes(32), { mode: 0o600, flag: "wx" });
    try { await fs.link(temp, file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  } finally { await fs.rm(temp, { force: true }); }
  return keyFor(dir, false);
};

export const sealSavedScreen = async (dir: string, file: string, owner: string, at: Date, bytes: Buffer): Promise<string> => {
  if (path.resolve(path.dirname(file)) !== path.resolve(dir)) throw new Error("화면 저장 위치가 다릅니다.");
  const receipt: Receipt = { v: 1, file: path.basename(file), at: at.toISOString(),
    sha256: digest(bytes) };
  const payload = Buffer.from(JSON.stringify(receipt)).toString("base64url");
  const signature = createHmac("sha256", await keyFor(dir, true)).update(JSON.stringify([owner, payload])).digest("hex");
  return `${payload}.${signature}`;
};

export const readSavedScreen = async (dir: string, owner: string, reference: string): Promise<{ bytes: Buffer; mimeType: string; at: string }> => {
  if (reference.length > 4096 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(reference)) throw new Error("저장본 참조 형식이 유효하지 않습니다.");
  const [payload, signature] = reference.split(".") as [string, string];
  const expected = createHmac("sha256", await keyFor(dir, false)).update(JSON.stringify([owner, payload])).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new Error("이 대화에 유효한 저장본 서명이 아닙니다.");
  const receipt = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Receipt;
  if (receipt.v !== 1) throw new Error("이 대화의 저장본이 아닙니다.");
  if (typeof receipt.file !== "string" || /[\\/]/.test(receipt.file) || receipt.file === "." || receipt.file === ".." || !/\.(jpg|png)$/.test(receipt.file)) throw new Error("저장본 파일명이 유효하지 않습니다.");
  const file = path.join(dir, receipt.file);
  const root = await fs.realpath(dir);
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || await fs.realpath(file) !== path.join(root, receipt.file)) throw new Error("저장본이 원래 저장 위치의 일반 파일이 아닙니다.");
  const fh = await fs.open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size > FRAME_MAX_BYTES) throw new Error("저장본을 이미지로 읽을 수 없습니다.");
    // 읽는 동안 커지는 파일도 무제한 할당하지 않는다.
    const buf = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buf.length) {
      const { bytesRead } = await fh.read(buf, length, buf.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buf.subarray(0, length);
    if (length !== stat.size || digest(bytes) !== receipt.sha256) throw new Error("저장본이 촬영 당시와 달라졌습니다.");
    return { bytes, mimeType: receipt.file.endsWith(".jpg") ? "image/jpeg" : "image/png", at: receipt.at };
  } finally { await fh.close(); }
};
