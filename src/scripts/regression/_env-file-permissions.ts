/** Inspect only the caller's synthetic secret fixture; never change machine/global ACL policy. */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

/**
 * POSIX: mode 0600. Windows: a **sufficient** no-leak condition, not an effective-access calculation —
 *  the DACL is protected (no inheritance) and has no inherited ACE, every Allow ACE (any mask) is for the process token
 *  user / SYSTEM / Administrators, there is at least one Allow, and the owner is in the same set (an owner can rewrite
 *  the DACL). Deny ACEs only remove access, so ignoring them can only make this stricter. SIDs come from
 *  GetAccessRules(SecurityIdentifier) — no account-name translation (orphaned SIDs stay visible). The product side
 *  (`src/core/secret-file.ts`) grants exactly this set; the full ACE list is returned so a log alone shows why.
 */
export const secretFilePermissions = (file: string): { ok: boolean; got: string } => {
  if (process.platform !== "win32") {
    const mode = (statSync(file).mode & 0o777).toString(8);
    return { ok: mode === "600", got: `POSIX mode=${mode}` };
  }
  const script = `
$ErrorActionPreference = 'Stop'
$sidT = [System.Security.Principal.SecurityIdentifier]
$acl = Get-Acl -LiteralPath $env:TIGUCLAW_ACL_FIXTURE
$owner = $acl.GetOwner($sidT).Value
$self = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($self, 'S-1-5-18', 'S-1-5-32-544')
$aces = @($acl.GetAccessRules($true, $true, $sidT) | ForEach-Object {
  [pscustomobject]@{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType; mask = [int64]$_.FileSystemRights;
    inherited = $_.IsInherited; inheritanceFlags = [string]$_.InheritanceFlags; propagationFlags = [string]$_.PropagationFlags } })
$allow = @($aces | Where-Object { $_.type -eq 'Allow' })
$outside = @($allow | Where-Object { $_.sid -notin $allowed } | ForEach-Object { $_.sid })
$inherited = @($aces | Where-Object { $_.inherited })
$ok = $acl.AreAccessRulesProtected -and $inherited.Count -eq 0 -and $allow.Count -gt 0 -and $outside.Count -eq 0 -and ($owner -in $allowed)
[pscustomobject]@{ ok = [bool]$ok; protected = $acl.AreAccessRulesProtected; owner = $owner; self = $self; outside = $outside; aces = $aces } | ConvertTo-Json -Compress -Depth 4
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
    env: { ...process.env, TIGUCLAW_ACL_FIXTURE: file },
  });
  try {
    const got = JSON.parse(r.stdout.trim()) as { ok?: boolean };
    return { ok: r.status === 0 && got.ok === true, got: `Windows DACL ${r.stdout.trim()}` };
  } catch {
    return { ok: false, got: `Windows DACL unverified: status=${r.status} signal=${r.signal} error=${r.error?.message ?? "none"} ${r.stderr?.trim().slice(-300)}` };
  }
};
