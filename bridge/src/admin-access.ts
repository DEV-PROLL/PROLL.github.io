import type { IncomingHttpHeaders } from "http";

const TAILSCALE_IPV6_PREFIX = "fd7a:115c:a1e0:";

export function isAdminRequestAllowed(
  remoteAddress: string | undefined,
  host: string | undefined,
  headers: IncomingHttpHeaders,
): boolean {
  if (hasProxyForwardingHeaders(headers)) return false;
  if (isLoopbackAddress(remoteAddress)) {
    return hasLocalHostHeader(host) || hasTailscaleHostHeader(host);
  }
  return isTailscaleAddress(remoteAddress) && hasTailscaleHostHeader(host);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isTailscaleAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized.startsWith(TAILSCALE_IPV6_PREFIX)) return true;

  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function hasLocalHostHeader(host: string | undefined): boolean {
  const hostname = parseHostName(host);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function hasTailscaleHostHeader(host: string | undefined): boolean {
  const hostname = parseHostName(host);
  return hostname != null && (isTailscaleAddress(hostname) || hostname.endsWith(".ts.net"));
}

function parseHostName(host: string | undefined): string | null {
  if (!host) return null;
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    const closingBracket = normalized.indexOf("]");
    return closingBracket > 1 ? normalized.slice(1, closingBracket) : null;
  }
  const colon = normalized.lastIndexOf(":");
  return colon >= 0 && colon === normalized.indexOf(":")
    ? normalized.slice(0, colon)
    : normalized;
}

function hasProxyForwardingHeaders(headers: IncomingHttpHeaders): boolean {
  return [
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "cdn-loop",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ].some((name) => headers[name] !== undefined);
}
