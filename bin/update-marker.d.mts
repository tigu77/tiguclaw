export const UPDATE_PENDING_MARKER: string;
export const UPDATE_CONFIRM_WAIT_MS: number;
export const UPDATE_SLOT_WAIT_MS: number;
export function updateSlotState(home: string, lstat?: (p: string) => unknown): "empty" | "occupied" | "unknown";
export function homePipeHash(homeAbs: string): string;
export function updateRunPipeName(homeAbs: string): string;
export function updateHandoffPipeName(homeAbs: string): string;
export function sameUpdateAttempt(a: unknown, b: unknown): boolean;
export interface UpdateBoot { instanceId: string; bootId: string; startedAt: number; revision?: string | null; }
export interface UpdateExpectation { instanceId: string; notBefore: number; oldBootIds: string[]; revision: string; }
export function updateBootMatches(expected: unknown, boot: unknown): boolean;
export function updateMarkerMatches(marker: unknown, boot: unknown): boolean;
export function consumeUpdateMarker(io: {read(name: string): Promise<string | null>; remove(name: string, raw: string): Promise<void>; boot: UpdateBoot; failed: boolean; sleep?(ms:number): Promise<void>; now?(): number}): Promise<{handled: boolean; data?: {notify?: {channel?: string; target?: string | null}}}>;
