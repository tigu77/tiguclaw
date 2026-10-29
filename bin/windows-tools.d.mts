export function applyWindowsTools(
  env?: NodeJS.ProcessEnv,
  platform?: string,
  exists?: (file: string) => boolean,
  hasGit?: () => boolean,
): void;
