/**
 * **셸 출력 디코더** — 자식 셸이 파이프에 쓴 바이트를 글자로 (2026-10-23, 설계 docs/decisions/2026-10-23-windows-shell-output-encoding.md).
 *
 * ★왜: Windows 의 콘솔 프로그램·cmd 내장 명령은 파이프에 **OEM 코드 페이지**(한국어 949) 바이트를 쓰는데, 셸 출력을 읽는 세 자리
 *  (Bash 포그라운드·백그라운드·훅)가 조각마다 `toString("utf8")` 로 읽어 `ping`·`echo 한글`·`dir` 오류가 U+FFFD 로 깨졌다(집 Windows 실측).
 *  UTF-8 로 쓰는 프로그램(node 등)과 한 출력에 섞일 수 있어 **줄마다** «온전한 UTF-8 이면 UTF-8, 아니면 OEM» 으로 정한다.
 *
 * 계약(스트림 하나 = 디코더 하나):
 *  - `write(chunk)` — 이번에 **확정된** 글자. `end()` — 남은 것을 확정하고 비운다(멱등, 그 뒤 `write` 는 새 줄처럼 이어진다).
 *  - `pending()` — 아직 확정 안 한 꼬리의 **잠정** 해석(확정하지 않는다 — `until` 매칭 전용, 약한 계약).
 *  - ★같은 바이트면 조각을 어디서 나눠 받아도 `write…end` 결과가 같다(판정이 «그 줄의 몇 번째 바이트» 로만 정해진다).
 *
 * Windows 아닌 곳·OEM 을 모르는 Windows(65001·미지원 코드 페이지): UTF-8 스트림 — 지금과 같은 해석이고 조각 경계의 멀티바이트만 잡아 둔다.
 */
import { spawnSync } from "node:child_process";

export interface ShellOutputDecoder {
  write(chunk: Buffer): string;
  end(): string;
  pending(): string;
}

/** 줄이 안 끝난 보류분을 이만큼 넘게 잡지 않는다 — 넘는 순간 첫 이만큼으로 인코딩을 정하고 그 줄 끝까지 스트림으로 푼다. */
export const SHELL_HOLD_MAX = 4096;

/**
 * 코드 페이지 번호 → `TextDecoder` 이름. ICU 가 숫자 별칭을 모르는 넷(932·936·949·950)은 적어 두고, 나머지는 `windows-<n>`·`ibm<n>` 별칭을
 *  시도한다(874·1250~1258·866). 65001(UTF-8)·모르는 것(437·850 등)은 null = OEM 해석 없음.
 */
export const oemDecoderLabel = (codePage: number): string | null => {
  if (!Number.isInteger(codePage) || codePage <= 0 || codePage === 65001) return null;
  const named: Record<number, string> = { 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5" };
  for (const label of [named[codePage], `windows-${codePage}`, `ibm${codePage}`]) {
    if (label === undefined) continue;
    try {
      return new TextDecoder(label).encoding;
    } catch {
      /* 이 기계의 ICU 가 모르는 이름 — 다음 */
    }
  }
  return null;
};

/** 자식 셸이 받는 콘솔의 코드 페이지 — 셸과 같은 방식으로 띄운 `chcp` 의 숫자(ASCII). 프로세스당 한 번. 못 재면 null. */
let measured: { label: string | null } | undefined;
const windowsOemLabel = (): string | null => {
  if (measured !== undefined) return measured.label;
  let label: string | null = null;
  try {
    const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, timeout: 5000 });
    const nums = (r.stdout ?? Buffer.alloc(0)).toString("latin1").match(/\d+/g);
    if (nums !== null && nums.length > 0) label = oemDecoderLabel(Number(nums[nums.length - 1]));
  } catch {
    label = null;
  }
  measured = { label };
  return label;
};

/** 검사용 — 플랫폼·OEM 을 주입한다(제품 호출부는 인자 없이). `undefined` 로 되돌린다. */
let forced: { platform: string; oemLabel: string | null } | undefined;
export const __forceShellDecoderForTest = (v: { platform: string; oemLabel: string | null } | undefined): void => {
  forced = v;
};

const isUtf8 = (b: Uint8Array): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};
/** 온전한 UTF-8 접두인가 — 끝의 미완 시퀀스는 허용(스트림 모드). */
const isUtf8Prefix = (b: Uint8Array): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: true });
    return true;
  } catch {
    return false;
  }
};

/**
 * ★`ignoreBOM: true` — 기본 `TextDecoder` 는 맨 앞 U+FEFF 를 지운다. 종전 `Buffer.toString("utf8")` 은 보존했으므로 같게 둔다(GPT R1 —
 *  맥 출력이 바뀌고, Windows 잠금 줄에선 안전 바이트 뒤의 U+FEFF 까지 사라졌다). 문자열을 내는 UTF-8 디코더는 전부 이것으로.
 */
const utf8Decoder = (): TextDecoder => new TextDecoder("utf-8", { ignoreBOM: true });

const utf8Stream = (): ShellOutputDecoder => {
  const d = utf8Decoder();
  return {
    write: (chunk) => d.decode(chunk, { stream: true }),
    end: () => d.decode(),
    pending: () => "",
  };
};

/**
 * 줄 판정 디코더(Windows + OEM).
 *  - 줄 경계 = `\n`·`\r`(UTF-8·DBCS 의 트레일 바이트 범위 밖 — 문자 중간이 아니다).
 *  - 줄 머리부터 처음 «안전하지 않은» 바이트 전까지는 바로 낸다. 안전 = 0x00~0x7F 중 OEM 디코더가 UTF-8 과 같은 글자로 푸는 것(디코더에 실제로 물어
 *    정한다 — `shift_jis`·`ibm866` 은 0x1A·0x1C·0x7F 가 다르다). 그 뒤(«보류분»)는 줄 경계까지 잡아 한 번에 판정한다.
 *  - 보류분이 SHELL_HOLD_MAX 를 넘는 순간 그 첫 SHELL_HOLD_MAX 바이트로 인코딩을 정해 그 줄 끝까지 스트림 디코더로 푼다.
 */
const lineDecoder = (oemLabel: string): ShellOutputDecoder => {
  const oem = new TextDecoder(oemLabel);
  const safe: boolean[] = [];
  for (let b = 0; b < 128; b += 1) safe[b] = new TextDecoder(oemLabel).decode(Uint8Array.of(b)) === String.fromCharCode(b);
  let held: Buffer = Buffer.alloc(0);
  let locked: TextDecoder | null = null;
  const decide = (b: Buffer): string => (isUtf8(b) ? b.toString("utf8") : oem.decode(b));
  const lock = (): string => {
    locked = isUtf8Prefix(held.subarray(0, SHELL_HOLD_MAX)) ? utf8Decoder() : new TextDecoder(oemLabel);
    const out = locked.decode(held, { stream: true });
    held = Buffer.alloc(0);
    return out;
  };
  const boundaryFrom = (c: Buffer, from: number): number => {
    for (let i = from; i < c.length; i += 1) if (c[i] === 0x0a || c[i] === 0x0d) return i;
    return -1;
  };
  return {
    write(chunk) {
      let out = "";
      let pos = 0;
      while (pos < chunk.length) {
        if (locked !== null) {
          const b = boundaryFrom(chunk, pos);
          if (b === -1) {
            out += locked.decode(chunk.subarray(pos), { stream: true });
            pos = chunk.length;
          } else {
            out += locked.decode(chunk.subarray(pos, b + 1));
            locked = null;
            pos = b + 1;
          }
          continue;
        }
        if (held.length === 0) {
          // 줄 머리의 안전 바이트(경계 포함)는 바로 — 두 해석이 같은 글자다.
          let i = pos;
          while (i < chunk.length && chunk[i]! < 0x80 && safe[chunk[i]!] === true) i += 1;
          if (i > pos) out += chunk.subarray(pos, i).toString("latin1");
          pos = i;
          if (pos >= chunk.length) break;
          // 안전하지 않은 바이트 — 여기부터 보류분이다(아래 갈래로).
        }
        const b = boundaryFrom(chunk, pos);
        const until = b === -1 ? chunk.length : b; // 보류분에 들어갈 몫(경계 제외)
        const room = SHELL_HOLD_MAX + 1 - held.length; // 이만큼 더 받으면 «넘는 순간»
        if (until - pos >= room) {
          // 경계보다 앞에서 상한을 넘는다 — 넘는 바이트까지 넣고 잠근다(판정은 첫 SHELL_HOLD_MAX 바이트).
          held = Buffer.concat([held, chunk.subarray(pos, pos + room)]);
          pos += room;
          out += lock();
          continue;
        }
        if (b === -1) {
          held = Buffer.concat([held, chunk.subarray(pos)]);
          pos = chunk.length;
        } else {
          out += decide(Buffer.concat([held, chunk.subarray(pos, b + 1)]));
          held = Buffer.alloc(0);
          pos = b + 1;
        }
      }
      return out;
    },
    end() {
      let out = "";
      if (locked !== null) {
        out += locked.decode();
        locked = null;
      }
      if (held.length > 0) {
        out += decide(held);
        held = Buffer.alloc(0);
      }
      return out;
    },
    pending() {
      if (locked !== null || held.length === 0) return "";
      return isUtf8Prefix(held) ? utf8Decoder().decode(held, { stream: true }) : oem.decode(held);
    },
  };
};

/** 스트림 하나에 디코더 하나. 인자는 검사용 주입뿐. */
export const createShellOutputDecoder = (opts?: { platform?: string; oemLabel?: string | null }): ShellOutputDecoder => {
  const platform = opts?.platform ?? forced?.platform ?? process.platform;
  if (platform !== "win32") return utf8Stream();
  const label = opts !== undefined && "oemLabel" in opts ? (opts.oemLabel ?? null) : forced !== undefined ? forced.oemLabel : windowsOemLabel();
  return label === null ? utf8Stream() : lineDecoder(label);
};
