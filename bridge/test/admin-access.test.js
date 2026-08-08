const assert = require("node:assert/strict");
const test = require("node:test");

const { isAdminRequestAllowed } = require("../dist/admin-access");

test("allows a direct Tailscale IPv4 admin request", () => {
  const allowed = isAdminRequestAllowed(
    "100.72.252.90",
    "100.104.132.2:8080",
    {},
  );

  assert.equal(allowed, true);
});

test("allows a direct Tailscale IPv6 admin request", () => {
  const allowed = isAdminRequestAllowed(
    "fd7a:115c:a1e0::1234",
    "podomini-macmini.tail49057c.ts.net:8080",
    {},
  );

  assert.equal(allowed, true);
});

test("allows the loopback side of a Tailscale TCP proxy", () => {
  const allowed = isAdminRequestAllowed(
    "127.0.0.1",
    "100.104.132.2:8080",
    {},
  );

  assert.equal(allowed, true);
});

test("keeps forwarded admin requests private", () => {
  const allowed = isAdminRequestAllowed(
    "100.72.252.90",
    "100.104.132.2:8080",
    { "x-forwarded-for": "100.72.252.90" },
  );

  assert.equal(allowed, false);
});

test("rejects non-Tailscale remote admin requests", () => {
  const allowed = isAdminRequestAllowed(
    "192.168.0.10",
    "100.104.132.2:8080",
    {},
  );

  assert.equal(allowed, false);
});

