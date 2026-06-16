import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./sessions.js";

export type BridgeTokenRole = "read" | "write" | "admin";

export interface IssuedToken {
  id: number;
  token: string;
  expiresAt: number | null;
}

export interface VerifiedToken {
  id: number;
  role: BridgeTokenRole;
}

export interface ActiveTokenRow {
  id: number;
  label: string;
  role: BridgeTokenRole;
  createdAt: number;
  expiresAt: number | null;
}

interface DbActiveRow {
  id: number;
  label: string;
  role: string;
  created_at: number;
  expires_at: number | null;
}

interface DbVerifyRow {
  id: number;
  role: string;
  expires_at: number | null;
  revoked_at: number | null;
}

const hash = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

export const issueToken = (
  label: string,
  role: BridgeTokenRole,
  expiresInMs?: number,
): IssuedToken => {
  const handle = getDb();
  const raw = randomBytes(32).toString("hex");
  const tokenHash = hash(raw);
  const now = Date.now();
  const expiresAt =
    expiresInMs !== undefined && expiresInMs > 0 ? now + expiresInMs : null;

  const result = handle
    .prepare(
      `INSERT INTO bridge_tokens (token_hash, label, role, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(tokenHash, label, role, now, expiresAt);

  return {
    id: Number(result.lastInsertRowid),
    token: raw,
    expiresAt,
  };
};

export const verifyToken = (presented: string): VerifiedToken | null => {
  // V1 호환 — env HTTP_BRIDGE_TOKEN 폴백 (admin role)
  const envToken = process.env.HTTP_BRIDGE_TOKEN;
  if (
    envToken !== undefined &&
    envToken.length > 0 &&
    presented === envToken
  ) {
    return { id: 0, role: "admin" };
  }

  const handle = getDb();
  const now = Date.now();
  const row = handle
    .prepare(
      `SELECT id, role, expires_at, revoked_at FROM bridge_tokens
       WHERE token_hash = ?`,
    )
    .get(hash(presented)) as DbVerifyRow | undefined;

  if (row === undefined) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;

  return { id: row.id, role: row.role as BridgeTokenRole };
};

export const listActive = (): ActiveTokenRow[] => {
  const handle = getDb();
  const now = Date.now();
  const rows = handle
    .prepare(
      `SELECT id, label, role, created_at, expires_at FROM bridge_tokens
       WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id ASC`,
    )
    .all(now) as DbActiveRow[];

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    role: r.role as BridgeTokenRole,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
};

export const revokeToken = (id: number): boolean => {
  const handle = getDb();
  const now = Date.now();
  const result = handle
    .prepare(
      `UPDATE bridge_tokens SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(now, id);
  return result.changes > 0;
};
