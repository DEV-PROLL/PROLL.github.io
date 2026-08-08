const assert = require("node:assert/strict");
const test = require("node:test");
const { extractHeadInfo } = require("../dist/mc-session.js");

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
    componentMap: new Map([["profile", profile]]),
  };
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

test("rejects hostile, non-https, and invalid texture URLs", () => {
  const urls = [
    `https://textures.minecraft.net.evil.com/texture/${TEXTURE_ID}`,
    `http://textures.minecraft.net/texture/${TEXTURE_ID}`,
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

test("never throws for malformed profile component shapes", () => {
  const hostile = {};
  hostile.value = hostile;

  assert.doesNotThrow(() => extractHeadInfo(modernHead(hostile)));
  assert.equal(extractHeadInfo(modernHead(hostile)), undefined);
  assert.equal(extractHeadInfo({ name: "stone" }), undefined);
  assert.equal(extractHeadInfo(null), undefined);
});
