export interface IdentityInput { home: string; repoRoot: string; runtime?: string; }
export interface ProcessIdentity { readonly instanceId: string; readonly bootId: string; readonly startedAt: number; readonly revision: string | null; }
export function instanceIdFor(input: IdentityInput): string;
export function getProcessIdentity(input: IdentityInput): ProcessIdentity;
export function setBootRevision(revision: string | null): void;
