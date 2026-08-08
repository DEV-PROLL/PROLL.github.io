const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
process.env.HEAD_DEBUG = "1";
const {
  McSession,
  extractHeadInfo,
  inspectHeadInfo,
  summarizeItemForDebug,
} = require("../dist/mc-session.js");

const TEXTURE_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PLAYER_UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

function encodedTexture(url = `https://textures.minecraft.net/texture/${TEXTURE_ID}`) {
  return Buffer.from(
    JSON.stringify({ textures: { SKIN: { url } } }),
    "utf8",
  ).toString("base64");
}

function modernHead(profile) {
  return {
    name: "player_head",
    displayName: "Player Head",
    count: 1,
    type: 1,
    componentMap: new Map([["profile", profile]]),
  };
}

function nonCanonicalTexture() {
  const canonical = Buffer.from(
    `${JSON.stringify({
      textures: {
        SKIN: {
          url: `https://textures.minecraft.net/texture/${TEXTURE_ID}`,
        },
      },
    })} `,
    "utf8",
  ).toString("base64");
  assert.match(canonical, /A==$/);
  return canonical.replace(/A==$/, "B==");
}

test("extracts a complete 1.21.11 profile component", () => {
  const head = extractHeadInfo(
    modernHead({
      type: "complete",
      uuid: PLAYER_UUID,
      name: "Notch",
      properties: [{ name: "textures", value: encodedTexture() }],
    }),
  );

  assert.deepEqual(head, {
    playerUuid: PLAYER_UUID,
    playerName: "Notch",
    textureId: TEXTURE_ID,
  });
});

test("prioritizes prismarine-item componentMap over generic fallbacks", () => {
  const item = modernHead({
    type: "complete",
    uuid: PLAYER_UUID,
    name: "Notch",
    properties: [{ name: "textures", value: encodedTexture() }],
  });
  item.components = [
    {
      type: "profile",
      data: {
        type: "partial",
        name: "Shadow",
        properties: [],
      },
    },
  ];

  assert.deepEqual(extractHeadInfo(item), {
    playerUuid: PLAYER_UUID,
    playerName: "Notch",
    textureId: TEXTURE_ID,
  });
});

test("extracts a namespaced wrapped 1.21.11 componentMap profile", () => {
  const item = modernHead(undefined);
  item.componentMap = new Map([
    [
      "minecraft:profile",
      {
        type: "profile",
        data: {
          type: "complete",
          uuid: PLAYER_UUID.replaceAll("-", ""),
          name: "Dinnerbone",
          properties: [
            {
              name: "textures",
              value: encodedTexture(
                `http://textures.minecraft.net/texture/${TEXTURE_ID}`,
              ),
            },
          ],
        },
      },
    ],
  ]);

  assert.deepEqual(extractHeadInfo(item), {
    playerUuid: PLAYER_UUID,
    playerName: "Dinnerbone",
    textureId: TEXTURE_ID,
  });
});

test("extracts textures from a partial profile without identity", () => {
  const head = extractHeadInfo(
    modernHead({
      type: "partial",
      properties: [{ name: "textures", value: encodedTexture() }],
    }),
  );

  assert.deepEqual(head, { textureId: TEXTURE_ID });
});

test("keeps sanitized partial identity when texture JSON is malformed", () => {
  const head = extractHeadInfo(
    modernHead({
      type: "partial",
      name: "Dinnerbone",
      uuid: PLAYER_UUID.replaceAll("-", ""),
      properties: [{ name: "textures", value: "bm90LWpzb24=" }],
    }),
  );

  assert.deepEqual(head, {
    playerUuid: PLAYER_UUID,
    playerName: "Dinnerbone",
  });
});

test("accepts historical HTTP Mojang texture URLs for id parsing", () => {
  const result = inspectHeadInfo(
    modernHead({
      type: "partial",
      properties: [
        {
          name: "textures",
          value: encodedTexture(
            `http://textures.minecraft.net/texture/${TEXTURE_ID}`,
          ),
        },
      ],
    }),
  );

  assert.deepEqual(result.head, { textureId: TEXTURE_ID });
  assert.equal(result.diagnostic.failureReason, undefined);
});

test("classifies rejected texture schemes and hosts without echoing URLs", () => {
  const cases = [
    [
      "bad-scheme",
      `ftp://textures.minecraft.net/texture/${TEXTURE_ID}`,
    ],
    [
      "bad-host",
      `https://textures.minecraft.net.evil.com/texture/${TEXTURE_ID}`,
    ],
    [
      "bad-host",
      `http://evil.example/texture/${TEXTURE_ID}`,
    ],
  ];

  for (const [failureReason, url] of cases) {
    const diagnostic = inspectHeadInfo(
      modernHead({
        type: "partial",
        properties: [{ name: "textures", value: encodedTexture(url) }],
      }),
    ).diagnostic;
    const serialized = JSON.stringify(diagnostic);

    assert.equal(diagnostic.failureReason, failureReason);
    assert.doesNotMatch(serialized, /textures\.minecraft\.net|evil\.example/);
    assert.doesNotMatch(serialized, new RegExp(TEXTURE_ID));
  }
});

test("rejects texture URL credentials, suffixes, and invalid ids", () => {
  const urls = [
    `data:image/png;base64,${TEXTURE_ID}`,
    "file:///etc/passwd",
    `https://127.0.0.1/texture/${TEXTURE_ID}`,
    `https://textures.minecraft.net@127.0.0.1/texture/${TEXTURE_ID}`,
    `https://user@textures.minecraft.net/texture/${TEXTURE_ID}`,
    `https://textures.minecraft.net/texture/${TEXTURE_ID}?download=1`,
    `https://textures.minecraft.net/texture/${TEXTURE_ID}#fragment`,
    `https://textures.minecraft.net/texture/${TEXTURE_ID}/extra`,
    `https://textures.minecraft.net/texture/${TEXTURE_ID.toUpperCase()}`,
    `https://textures.minecraft.net/texture/${TEXTURE_ID}0`,
    "https://textures.minecraft.net/texture/not-a-texture-id",
  ];

  for (const url of urls) {
    assert.equal(
      extractHeadInfo(
        modernHead({
          type: "partial",
          properties: [{ name: "textures", value: encodedTexture(url) }],
        }),
      ),
      undefined,
    );
  }
});

test("rejects encoded texture payloads larger than 8KB", () => {
  const head = extractHeadInfo(
    modernHead({
      type: "partial",
      properties: [{ name: "textures", value: "A".repeat(8 * 1024 + 4) }],
    }),
  );

  assert.equal(head, undefined);
});

test("extracts legacy SkullOwner identity and texture NBT", () => {
  const head = extractHeadInfo({
    name: "player_head",
    nbt: {
      type: "compound",
      value: {
        SkullOwner: {
          type: "compound",
          value: {
            Id: { type: "string", value: PLAYER_UUID },
            Name: { type: "string", value: "LegacyUser" },
            Properties: {
              type: "compound",
              value: {
                textures: {
                  type: "list",
                  value: {
                    type: "compound",
                    value: [
                      {
                        Value: {
                          type: "string",
                          value: encodedTexture(),
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  assert.deepEqual(head, {
    playerUuid: PLAYER_UUID,
    playerName: "LegacyUser",
    textureId: TEXTURE_ID,
  });
});

test("falls back to legacy SkullOwner when profile component is empty", () => {
  const item = modernHead(undefined);
  item.nbt = {
    type: "compound",
    value: {
      SkullOwner: {
        type: "compound",
        value: {
          Name: { type: "string", value: "LegacyUser" },
        },
      },
    },
  };

  const result = inspectHeadInfo(item);

  assert.deepEqual(result.head, { playerName: "LegacyUser" });
  assert.equal(result.diagnostic.branch, "legacy-nbt");
});

test("extracts lowercase legacy skullOwner string profiles", () => {
  const result = inspectHeadInfo({
    name: "player_wall_head",
    nbt: {
      type: "compound",
      value: {
        skullOwner: {
          type: "string",
          value: "LegacyUser",
        },
      },
    },
  });

  assert.deepEqual(result.head, { playerName: "LegacyUser" });
  assert.equal(result.diagnostic.branch, "legacy-nbt");
});

test("never throws for malformed profile component shapes", () => {
  const hostile = {};
  hostile.value = hostile;

  assert.doesNotThrow(() => extractHeadInfo(modernHead(hostile)));
  assert.equal(extractHeadInfo(modernHead(hostile)), undefined);
  assert.equal(extractHeadInfo({ name: "stone" }), undefined);
  assert.equal(extractHeadInfo(null), undefined);
});

test("classifies privacy-safe head branches without exposing identities", () => {
  const component = {
    name: "player_head",
    components: [
      {
        type: "profile",
        data: {
          name: "Dinnerbone",
        },
      },
    ],
  };
  const legacy = {
    name: "player_head",
    nbt: {
      type: "compound",
      value: {
        SkullOwner: {
          type: "compound",
          value: {
            Id: { type: "string", value: PLAYER_UUID },
            Name: { type: "string", value: "LegacyUser" },
          },
        },
      },
    },
  };

  const componentMapDiagnostic = inspectHeadInfo(
    modernHead({
      type: "complete",
      uuid: PLAYER_UUID,
      name: "Notch",
      Notch: "identity-bearing-key",
      [PLAYER_UUID]: "identity-bearing-key",
      properties: [{ name: "textures", value: encodedTexture() }],
    }),
  ).diagnostic;
  const componentDiagnostic = inspectHeadInfo(component).diagnostic;
  const legacyDiagnostic = inspectHeadInfo(legacy).diagnostic;
  const missingDiagnostic = inspectHeadInfo({ name: "player_head" }).diagnostic;

  assert.deepEqual(componentMapDiagnostic, {
    branch: "componentMap",
    profileKeys: [
      "<redacted:key:36>",
      "<redacted:key:5>",
      "name",
      "properties",
      "type",
      "uuid",
    ],
    hasUuid: true,
    hasName: true,
    hasTextures: true,
    nameValid: true,
    uuidValid: true,
    textureIdHash8: createHash("sha256").update(TEXTURE_ID).digest("hex").slice(0, 8),
  });
  assert.equal(componentDiagnostic.branch, "component");
  assert.equal(componentDiagnostic.hasName, true);
  assert.equal(legacyDiagnostic.branch, "legacy-nbt");
  assert.equal(legacyDiagnostic.hasUuid, true);
  assert.deepEqual(missingDiagnostic, {
    branch: "none",
    profileKeys: [],
    hasUuid: false,
    hasName: false,
    hasTextures: false,
    nameValid: false,
    uuidValid: false,
    failureReason: "no-profile",
  });

  const serialized = JSON.stringify([
    componentMapDiagnostic,
    componentDiagnostic,
    legacyDiagnostic,
  ]);
  assert.doesNotMatch(serialized, new RegExp(PLAYER_UUID, "i"));
  assert.doesNotMatch(serialized, /Notch|Dinnerbone|LegacyUser/);
  assert.doesNotMatch(serialized, /eyJ/);
});

test("classifies every texture extraction failure", () => {
  const cases = [
    ["bad-base64", "%%%"],
    ["non-canonical", nonCanonicalTexture()],
    ["oversize", "A".repeat(8 * 1024 + 4)],
    ["bad-json", Buffer.from("not-json", "utf8").toString("base64")],
    [
      "bad-host",
      encodedTexture(
        `https://textures.minecraft.net.evil.com/texture/${TEXTURE_ID}`,
      ),
    ],
    [
      "bad-scheme",
      encodedTexture(
        `ftp://textures.minecraft.net/texture/${TEXTURE_ID}`,
      ),
    ],
    [
      "bad-id",
      encodedTexture("https://textures.minecraft.net/texture/not-a-texture-id"),
    ],
  ];

  for (const [failureReason, value] of cases) {
    const result = inspectHeadInfo(
      modernHead({
        type: "partial",
        properties: [{ name: "textures", value }],
      }),
    );
    assert.equal(result.head, undefined);
    assert.equal(result.diagnostic.failureReason, failureReason);
  }
});

test("redacts profile identity and texture values from GUI debug summaries", () => {
  const encoded = encodedTexture();
  const item = modernHead({
    type: "complete",
    uuid: PLAYER_UUID,
    id: PLAYER_UUID.replaceAll("-", ""),
    name: "Notch",
    profileName: "Dinnerbone",
    profileId: PLAYER_UUID,
    Notch: "identity-bearing-key",
    [PLAYER_UUID]: "identity-bearing-key",
    properties: [{ name: "textures", value: encoded }],
  });

  const serialized = JSON.stringify(
    summarizeItemForDebug(item, "Decorative menu head", []),
  );

  assert.doesNotMatch(serialized, new RegExp(PLAYER_UUID, "i"));
  assert.doesNotMatch(serialized, new RegExp(PLAYER_UUID.replaceAll("-", ""), "i"));
  assert.doesNotMatch(serialized, /Notch|Dinnerbone/);
  assert.doesNotMatch(serialized, /identity-bearing-key/);
  assert.doesNotMatch(serialized, new RegExp(encoded));
  assert.match(serialized, /<redacted:(?:uuid|name|texture):\d+>/);
});

test("counts head outcomes locally without sending diagnostics to clients", (t) => {
  const session = new McSession({
    host: "example.invalid",
    port: 25565,
    version: "1.21.11",
    username: "tester",
    profilesFolder: "/tmp/proll-test-auth",
  });
  t.after(() => session.shutdown("test complete"));
  const messages = [];
  session.on("message", (message) => messages.push(message));
  const validHead = modernHead({
    type: "partial",
    properties: [{ name: "textures", value: encodedTexture() }],
  });
  const rejectedHead = modernHead({
    type: "partial",
    properties: [
      {
        name: "textures",
        value: encodedTexture(
          `https://textures.minecraft.net.evil.com/texture/${TEXTURE_ID}`,
        ),
      },
    ],
  });
  const ordinaryItem = {
    name: "stone",
    displayName: "Stone",
    count: 1,
    type: 2,
  };

  session.emitWindowSnapshot("window_open", {
    id: 1,
    type: "minecraft:generic_9x1",
    title: "Heads",
    slots: [validHead, rejectedHead, ordinaryItem],
    inventoryStart: 3,
    inventoryEnd: 3,
    hotbarStart: 3,
  });

  const diagnostics = session.headDiagnostics();
  assert.equal(diagnostics.headsSeen, 2);
  assert.equal(diagnostics.headsWithHeadField, 0);
  assert.equal(diagnostics.byBranch.componentMap, 2);
  assert.equal(diagnostics.byFailureReason["bad-host"], 1);
  assert.equal(messages.length, 1);
  const clientPayload = JSON.stringify(messages[0]);
  assert.doesNotMatch(clientPayload, /headDiagnostics|failureReason|profileKeys/);
  assert.doesNotMatch(clientPayload, /Notch|Dinnerbone/);
  assert.doesNotMatch(clientPayload, /eyJ/);
});
