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

const SUPPORTED = new Set<string>(SUPPORTED_MC_VERSIONS);

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

export function assertSupportedMcVersion(input: string): string {
  const normalized = normalizeMcVersion(input);
  if (!normalized) {
    throw new Error(`invalid Minecraft version: ${input}`);
  }
  if (!SUPPORTED.has(normalized)) {
    throw new Error(
      `unsupported Minecraft version: ${input}. Supported: ${SUPPORTED_MC_VERSIONS.join(
        ", ",
      )}`,
    );
  }
  return normalized;
}
