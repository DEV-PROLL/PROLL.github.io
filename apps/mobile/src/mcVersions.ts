export const DEFAULT_MC_VERSION = "1.21.11";

export const SUPPORTED_MC_VERSIONS = [
  "1.19.2",
  "1.19.3",
  "1.19.4",
  "1.20",
  "1.20.1",
  "1.20.2",
  "1.20.4",
  "1.20.6",
  "1.21.1",
  "1.21.3",
  "1.21.4",
  "1.21.5",
  "1.21.6",
  "1.21.8",
  "1.21.9",
  "1.21.11",
] as const;

export const MC_VERSION_ALIASES: Record<string, string> = {
  "1.21": "1.21.1",
  "1.21.2": "1.21.3",
  "1.21.7": "1.21.8",
  "1.21.10": "1.21.9",
};

export function normalizeMcVersion(input: string): string | null {
  const trimmed = input.trim();
  if (!/^1\.\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return MC_VERSION_ALIASES[trimmed] ?? trimmed;
}

export function isSupportedMcVersion(input: string): boolean {
  const normalized = normalizeMcVersion(input);
  return normalized
    ? SUPPORTED_MC_VERSIONS.includes(
        normalized as (typeof SUPPORTED_MC_VERSIONS)[number],
      )
    : false;
}
