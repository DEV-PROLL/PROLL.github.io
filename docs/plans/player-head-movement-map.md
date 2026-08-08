# Plan: Dynamic Player-Head Textures, Reliable Movement, Contextual Top-Down Map

- Task: `task_ef9eccdb5f8d` / dispatch `ctx_3b969543ab53` (Fable planning worker)
- Revision: 2026-08-08 under `task_45fdf66be8eb` / dispatch `ctx_77c7cf14f472` — coordinator-verified corrections
  applied (direct head rendering as default, monotonic movement epochs, map read/slice budgets, raw palette-index
  encoding decision).
- Revision: 2026-08-08 under `task_1d168f29dfb7` / dispatch `ctx_609912893d07` — refined from LIVE SIMULATOR
  EVIDENCE after first implementation commits landed. Ordinary item textures render, but some `player_head` slots
  still show the lettered "PH" fallback. Adds: implemented-state ledger (sections 1.8, 2.6), PH-fallback
  root-cause matrix with a verified missing-asset fact, privacy-safe head diagnostics (H5), evidence-gated
  extraction hardening + terminal render tier (H6), a live position-evidence protocol for movement, and explicit
  simulator + production acceptance gates for all three tracks (sections 1.8.6, 2.6.2, 3.7).
- Date: 2026-08-08
- Repo state: branch `DEV-PROLL/player-head-movement-map-plan` @ `7005328` — three implementation commits now sit
  on top of the original plan commit `0a8b815`: `911535e` (feat: render custom player head textures = phases
  H1+H3), `7005328` (fix: overlay legacy player head hats), `31561b3` (Instrument movement diagnostics = phase
  M1). Line citations in revision sections were verified against this worktree state.
- Status: PLAN ONLY. No production code, dependency, lockfile, or deployment changes are made by this document.
- Verified against installed sources in the main checkout (`/Users/prolls/Desktop/PROLL.github.io/node_modules`):
  mineflayer 4.37.1, minecraft-protocol 1.66.2, prismarine-item 1.18.0, prismarine-chunk 1.40.0,
  prismarine-world 3.7.0, minecraft-data 3.113.0, prismarine-windows 2.10.0, prismarine-nbt 2.8.0,
  prismarine-physics 1.11.0, prismarine-auth 3.1.1. Declared ranges: `bridge/package.json` (mineflayer ^4.37.1,
  minecraft-protocol ^1.66.2, minecraft-data ^3.113.0), Node >= 20, npm workspaces (`package.json`).

## 0. System context and shared architecture

```
[iPhone PWA / Expo RN app]  --WSS(JSON, 64KB max frame)-->  [bridge on Mac mini]  --MC 1.21.11 protocol-->  [99999.kr (proxy/limbo) -> game server]
   apps/mobile/src/*                                          bridge/src/*                                    per-user mineflayer bot
```

- Wire protocol is a hand-mirrored pair of TS unions: `bridge/src/types.ts` and `apps/mobile/src/protocol.ts`
  ("Keep in sync with bridge/src/types.ts", `apps/mobile/src/protocol.ts:1`). Every new message/field must be added
  in both files.
- Message size ceiling: `MAX_WS_MESSAGE_BYTES = 64 * 1024` (`bridge/src/ws-server.ts:17`). All new payloads must fit.
- The bridge already streams: `position` every 250 ms when changed (`POSITION_SYNC_MS`, `bridge/src/mc-session.ts:38`,
  `positionSnapshot()` at `mc-session.ts:842`), `player_list`, `player_state`, `boss_bars`, GUI `window_*`.
- Deployment surface (unchanged by this plan): Mac mini bridge behind Cloudflare Tunnel (`wss://bridge.proit.kr`),
  PWA on GitHub Pages, one-time `/client-ticket` WS auth (`README.md`, `bridge/ops/macmini/run-bridge.zsh`).

### Global non-goals

- No world persistence, no anvil storage, no unbounded chunk dump or full-world map.
- No modification of the Minecraft server or proxy in any phase of this plan (server-side options are listed as
  explicitly blocked alternatives).
- No new always-on background work in the bridge when no client is subscribed.
- No third-party analytics or new external services holding user data.

---

## Track 1 — Dynamic/custom player-head textures in the GUI

### 1.1 Current behavior (evidence)

- GUI items reach the app as `GuiItem { name, displayName, count, type, metadata, lore }`
  (`bridge/src/types.ts:179-188`, mirrored `apps/mobile/src/protocol.ts:179-188`). No skull/profile data survives
  serialization: `serializeItem()` (`bridge/src/mc-session.ts:1164-1201`) only extracts custom name/lore components.
- The app renders slot icons purely from `item.name` via static texture URLs:
  `MinecraftItemIcon` -> `minecraftTextureUrls(base, mcVersion, itemName)` builds
  `<assets>/data/<ver>/items/<name>.png` then `blocks/<name>.png`
  (`apps/mobile/src/components/MinecraftItemIcon.tsx:33-38`, `apps/mobile/src/itemTextures.ts:53-63`), against
  `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master` (`itemTextures.ts:1-2`). So every
  `player_head` renders the same generic icon (or the `#d9b18c` fallback color, `ChatScreen.tsx:2092`), which is why
  custom-head server menus look wrong.
- Player avatars (not GUI items) already use `https://mc-heads.net/avatar/<uuid>` keyed by real player UUID
  (`apps/mobile/src/components/RudulgiUI.tsx:114`) with a drawn fallback face.

### 1.2 Metadata trace: where head textures actually live in 1.21.11

1. Protocol: 1.21.11 slots carry data components; component id 68 is `profile`
   (`node_modules/minecraft-data/minecraft-data/data/pc/1.21.11/protocol.json`, SlotComponentType mapper).
   Its payload is `ResolvableProfile`:
   - `type`: `partial` -> `PartialResolvableProfile { name?: string, uuid?: UUID, properties: GameProfileProperty[] }`
   - `type`: `complete` -> `GameProfile { uuid, name, properties }`
   - plus `skinPatch: PlayerSkinPatch { body?, cape?, elytra?, model? }` (all optional strings / mapper).
   `GameProfileProperty` = `{ name, value, signature? }`; for `name == "textures"`, `value` is base64 JSON containing
   `textures.SKIN.url` pointing at `http(s)://textures.minecraft.net/texture/<hex>`.
2. Decoding: minecraft-protocol decodes the component natively (schema above); prismarine-item keeps raw components:
   `fromNotch()` stores `item.components` and `item.componentMap` keyed by component `type`
   (`node_modules/prismarine-item/index.js:152-162`, map built at `:157`). prismarine-item has NO `profile` accessor
   (grep confirms zero matches), so the bridge must read `componentMap.get('profile')` itself.
3. Bridge: `serializeItem()` already has generic component plumbing (`readItemComponent`,
   `componentSources`, `unwrapNbtValue` at `bridge/src/mc-session.ts:1351-1420`) and a debug channel
   (`DEBUG_GUI_ITEMS=1`, `mc-session.ts:37`, `debugGuiItem` at `:1212`) that prints `componentKeys` — use it in QA to
   confirm the exact shape the target server sends (partial vs complete, property casing).
4. Bonus source (for chat/player-list heads on servers with offline/custom skins): mineflayer already computes
   `player.skinData = { url, model }` from tab-list properties
   (`node_modules/mineflayer/lib/plugins/entities.js:616,676-677,936-954`). `serializePlayerList()`
   (`bridge/src/mc-session.ts:1038`) currently drops it.

### 1.3 Design

Add an optional, backward-compatible `head` descriptor to `GuiItem`, extracted bridge-side; render it in the PWA via a
strictly allowlisted pipeline that loads the skin PNG DIRECTLY from `https://textures.minecraft.net/texture/<id>`.
Direct rendering is the default head path; a bridge-hosted proxy exists in this plan only as a deferred optional
fallback (Phase H2) and is not built unless live QA proves direct rendering fails.

New `GuiItem` field (both `bridge/src/types.ts` and `apps/mobile/src/protocol.ts`):

```ts
head?: {
  playerUuid?: string;    // dashed UUID if profile carried one
  playerName?: string;    // profile name if present (<=16 chars, [A-Za-z0-9_])
  textureId?: string;     // hex id parsed from textures.minecraft.net URL, ^[0-9a-f]{40,64}$
}
```

Rendering priority in `MinecraftItemIcon` when `itemName` matches `player_head|player_wall_head` and `head` exists:

1. `textureId` -> direct `https://textures.minecraft.net/texture/<textureId>` (host hardcoded, id regex-validated),
   rendered as an 8x8 face crop + hat overlay done client-side with scaled `Image` + `overflow: hidden` (skin layout
   is fixed: face at (8,8)..(16,16), hat at (40,8)..(48,16) of the 64x64 skin), `imageRendering: "pixelated"` as
   already done in `MinecraftItemIcon.tsx:79-84`. This CSS/Image cropping never reads pixels back, so it needs no
   canvas and no CORS headers from the texture host — same mechanism as the existing cross-origin `mc-heads.net`
   `Image` avatars; works on RN web and native. Going direct keeps the Mac mini out of the serving path entirely:
   no public proxy endpoint to attack or overload.
2. else `playerUuid` -> existing `https://mc-heads.net/avatar/<uuid>` path (same source `MinecraftHead` already trusts,
   `RudulgiUI.tsx:114`).
3. else `playerName` -> `https://mc-heads.net/avatar/<name>` (same host, name validated).
4. else current behavior: static `player_head` texture from minecraft-assets, then lettered color fallback.

Note (unverified, labeled): mc-heads.net may accept raw texture ids on some endpoints; this plan does not rely on
that. Direct `textures.minecraft.net` loading is the default path for `textureId`; the deferred H2 proxy below
exists only for the case where live QA disproves direct rendering in the deployed PWA.

Deferred optional fallback — bridge `/head-texture` proxy (Phase H2; built ONLY if live QA proves direct rendering
fails; would live in `bridge/src/ws-server.ts` `handleHttpRequest`, next to `/status`):

- `GET /head-texture/:id?t=<ticket>` — requires `:id` to match `^[0-9a-f]{40,64}$` AND a valid short-lived signed
  ticket (reuse the one-time `/client-ticket` HMAC pattern) so the endpoint is never an anonymous public fetch
  surface on the Mac mini; unticketed/expired requests get 404 before any fetch or cache work. Fetches
  `https://textures.minecraft.net/texture/<id>` (hardcoded host; no redirects followed off-host), max response
  128 KB, content-type `image/png` enforced; responds with `Cache-Control: public, max-age=604800, immutable`,
  `X-Content-Type-Options: nosniff`, CORS via the existing `protectedCorsHeaders` origin logic (`ws-server.ts:523`).
- In-memory LRU cache: max 256 entries / 16 MB, TTL 7 days; misses rate-limited with the existing
  `isRateLimited` helper (`ws-server.ts:585`) under a new `head` area, 60/min per IP.

Bridge extraction (in `bridge/src/mc-session.ts`):

- New helper `extractHeadInfo(item: Item): GuiItem["head"] | undefined`:
  - Only when `item.name === "player_head"` (cheap gate).
  - Read `componentMap.get('profile')` (then `readItemComponent(item, ["minecraft:profile", "profile"])` as fallback,
    plus legacy NBT `SkullOwner` for pre-1.20.5 servers the bridge also supports, `mc-versions.ts:1-18`).
  - Parse `properties[] -> name === "textures"`: base64-decode `value` (reject > 8 KB before decode), `JSON.parse`,
    take `textures.SKIN.url`, require URL host exactly `textures.minecraft.net`, extract trailing hex id. Any parse
    failure -> return whatever uuid/name fields validated, never throw.
  - Wire into `serializeItem()` result.

### 1.4 Phases

Phase H1 — Bridge extraction + protocol field (feature-flagged)
- Files: `bridge/src/mc-session.ts` (extractHeadInfo + serializeItem), `bridge/src/types.ts` (GuiItem.head),
  `apps/mobile/src/protocol.ts` (mirror).
- Flag: `HEAD_METADATA_ENABLED=1` env in bridge config (`bridge/src/config.ts`, default off initially, flip to
  default-on after QA).
- Backward compatibility: `head` is optional; current app ignores unknown fields (JSON parse into TS interface).
- Rollback: unset flag; field disappears; app falls back to current rendering.

Phase H2 (deferred, optional) — Bridge `/head-texture` fallback proxy
- Entry condition: only if H3 live QA proves direct `textures.minecraft.net` rendering fails in the deployed PWA
  (e.g. the CDN starts requiring headers an `Image` load cannot send). Do not build speculatively — the default
  direct path deliberately avoids adding any public attack/load surface on the Mac mini.
- Files: `bridge/src/ws-server.ts` (route + LRU), new `bridge/src/head-texture.ts` (fetch/validate/cache/ticket,
  unit-testable pure parts), `bridge/test/head-texture.test.js` (proxy cases).
- Flag: `HEAD_TEXTURE_PROXY_ENABLED=1`; when off (the default), route returns 404 and the app never attempts it.
- Rollback: disable flag; direct rendering and tiers 2-4 still work.

Phase H3 — PWA rendering
- Files: `apps/mobile/src/components/MinecraftItemIcon.tsx` (head branch + face/hat crop subcomponent),
  `apps/mobile/src/itemTextures.ts` (pure helpers: `headTextureUrl(textureId)` -> direct
  `https://textures.minecraft.net/texture/<id>`, `isValidTextureId`, `mcHeadsAvatarUrl`), `apps/mobile/src/screens/ChatScreen.tsx` (pass `item.head` through
  `GuiSlotCell` and the detail card, `ChatScreen.tsx:1522,1988`).
- Flag: `EXPO_PUBLIC_HEAD_RENDER_ENABLED` mirroring the `MOVEMENT_PANEL_ENABLED` pattern
  (`apps/mobile/src/appConfig.ts:6-16`).
- Rollback: flag off -> old static icon path untouched.

Phase H4 (optional, after H1/H3 stable) — player-list/chat heads for custom skins
- Add `skinTextureId?: string` to `PlayerSummary` from `bot.players[x].skinData.url`
  (`entities.js:616`), rendered through the same direct `textures.minecraft.net` path; improves `MinecraftHead` on
  servers whose UUIDs are not premium-resolvable. Same allowlist and budgets.

### 1.5 Security / privacy budget

- Allowlist: exactly `textures.minecraft.net` (direct client `Image` fetch, display-only) and `mc-heads.net`
  (fallback tiers, already in use). No other hosts; `data:` URLs rejected; base64 payload capped at 8 KB; texture id
  regex-anchored; URLs constructed from validated ids, never echoed from server-supplied strings.
- Attack/load surface: the default (direct) path adds NO new public endpoint on the Mac mini — nothing to flood,
  cache-poison, or abuse as an open proxy. This is the primary reason direct rendering is the default.
- Deferred proxy budget (H2 only, if ever activated): 16 MB RAM cache / 256 entries, 128 KB per texture,
  60 fetch/min/IP, 7-day TTL, short-lived signed ticket required on every URL. On any budget breach: serve 404,
  never queue.
- Privacy: direct rendering exposes client IPs to Mojang's texture CDN on image load — the same exposure class as
  the existing `mc-heads.net` avatars, accepted as the trade-off for keeping the mini unexposed. If H2 is ever
  activated it inverts this (only the mini contacts Mojang) at the cost of running a public endpoint.
- No signature verification of `GameProfileProperty.signature` (not needed for display; do not treat as trusted).

### 1.6 Tests

Automated:
- `bridge/test/head-texture.test.js` (node --test, mirrors `bridge/test/movement-control.test.js` style): fixture
  `componentMap` entries — complete profile, partial with only textures property, hostile URL host
  (`textures.minecraft.net.evil.com`), oversized base64, malformed JSON, legacy `SkullOwner` NBT; assert extraction
  and rejection. Proxy cases (ticket validation, content-type rejection, cache eviction; pure functions, no live
  network) are added only if the deferred H2 proxy is activated.
- `apps/mobile/tests/itemTextures.test.mjs` additions: `headTextureUrl` shape (direct `textures.minecraft.net`
  URL), `isValidTextureId` reject paths
  (`../`, uppercase, short ids), tier selection function given a `head` object.

Simulator/manual QA (Mac + iOS Simulator flow from `README.md`):
- Local 1.21.11 server; `/give @p minecraft:player_head[profile={name:"..."}]` and a textures-property head from a
  head database command; open a chest GUI; verify: custom texture renders, premium-name head renders, vanilla steve
  fallback on garbage profile, `DEBUG_GUI_ITEMS=1` log shows `profile` in `componentKeys`.
- Live QA gate for the deferred proxy decision: confirm direct `textures.minecraft.net` `Image` loads render in the
  deployed PWA (GitHub Pages origin) on iPhone Safari; only a reproducible failure here activates H2.
- Airplane-mode/asset-outage check: `textures.minecraft.net` unreachable -> tiers degrade to static icon without
  layout shift.

### 1.7 Blockers and readiness

- No plugin/proxy/user blockers: everything needed arrives in the window items the bridge already receives.
- Risk: the live server may send `partial` profiles with only `name` for menu heads; tier 3 covers it.
- Verdict: READY TO IMPLEMENT (H1 then H3, direct rendering; H2 deferred fallback pending live QA; H4 optional).
  Superseded by section 1.8: H1+H3 have since landed; the remaining work is H5 (diagnosis) then H6 (hardening).

### 1.8 Revision: implemented state and the remaining "PH fallback" gap (live simulator evidence)

#### 1.8.1 What is implemented now (verified in this worktree)

- Bridge extraction (H1, commit `911535e`): `extractHeadInfo()` at `bridge/src/mc-session.ts:1378`, gated by
  `HEAD_METADATA_ENABLED === "1"` (`bridge/src/config.ts:5`, default OFF) and wired into `serializeItem()` at
  `mc-session.ts:1357`. Covers component-map `profile`/`minecraft:profile`, `readItemComponent` fallback, legacy
  `SkullOwner` NBT, uuid int-array/hex forms, textures-property base64 parse with exact-host + anchored-id gates.
  Unit tests exist: `bridge/test/head-metadata.test.js`.
- App rendering (H3, commits `911535e` + `7005328`): tiered sources in `playerHeadTextureTiers()`
  (`apps/mobile/src/itemTextures.ts:115-129`) — direct `textures.minecraft.net` skin crop, then `mc-heads.net`
  by uuid, then by name — consumed by `MinecraftItemIcon` with per-source `onError` advance
  (`MinecraftItemIcon.tsx:77-80`), gated by `EXPO_PUBLIC_HEAD_RENDER_ENABLED` (`appConfig.ts:23-24`, default OFF).
  Legacy 64x32 skins get the hat-overlay aspect handling (`minecraftSkinAspectRatio`).
- The lettered fallback ("PH") renders whenever NO source in the tier list loads (`MinecraftItemIcon.tsx:84-97`).

#### 1.8.2 Verified fact: there is no static player_head item texture

Probed 2026-08-08 against the exact URL builder the app uses (`minecraftTextureUrls`, `itemTextures.ts:79-92`):
`data/<v>/items/player_head.png` and `data/<v>/blocks/player_head.png` return HTTP 404 for v in
{1.21.11, 1.21.4, 1.21.1} on `raw.githubusercontent.com/PrismarineJS/minecraft-assets/master`, while
`data/1.21.11/items/diamond_sword.png` returns 200. Consequence: for `player_head` the "static texture" tiers are
guaranteed dead — the tier list is effectively ONLY the head-metadata tiers. Any head slot whose `head` field is
absent, or whose head tiers all error, MUST show the PH letter fallback. This exactly matches the simulator
symptom (ordinary items render; some heads fall back) and is the frame for the matrix below.

#### 1.8.3 PH-fallback root-cause matrix (run top to bottom; verdict rules are observable)

| # | Hypothesis | Where | Observable signal | Verdict rule |
|---|---|---|---|---|
| H-A | Bridge flag off: `HEAD_METADATA_ENABLED` unset in the running bridge env | deploy config | EVERY player_head in a WS `window_*` payload lacks `head` | Inspect one frame (simulator: log WS JSON; prod: `DEBUG_GUI_ITEMS` summary) — all-missing => CONFIRMED, fix is config not code |
| H-B | App flag off: `EXPO_PUBLIC_HEAD_RENDER_ENABLED` unset at build/export time | deploy config | `head` present in WS frames but app never issues textures/mc-heads requests (network tab empty) | Confirm via network inspector; all-or-nothing symptom like H-A |
| H-C | Extraction miss: the server's decoded `profile` component shape is not covered by `profileRecord()` candidates (e.g. option-wrapped fields, `partial`/`complete` discriminant nesting from the 1.21.11 `ResolvableProfile` mapper, or `skinPatch`-only heads) | `mc-session.ts` | Slot-selective: `componentKeys` contains `profile` but serialized item lacks `head` | H5 shape log shows branch=`none` or reason=`no-profile` for exactly the PH slots => CONFIRMED |
| H-D | Base64 strictness: `textureIdFromEncodedProfile` rejects values with whitespace/newlines, url-safe alphabet, or non-canonical padding via the canonical re-encode equality check (`mc-session.ts:1602-1603`) | `mc-session.ts` | Slot-selective: `head` absent (or uuid/name-only) though the profile carries a textures property | H5 reason=`bad-base64`/`non-canonical` on PH slots => CONFIRMED; fix in H6 |
| H-E | Tier exhaustion: extraction succeeded but yields only an anonymous/offline `playerUuid` or placeholder `playerName` — `mc-heads.net` 404s (uuid not premium-resolvable), no textureId tier exists | render path | `head` present on the PH slot; app-side tier trace shows every tier erroring | Dev tier-outcome trace (H5 app half) shows exhaustion => CONFIRMED; fix is H6 terminal tier |
| H-F | Name-gate rejection: menu heads carrying decorative names that fail `[A-Za-z0-9_]{1,16}` so the name tier is dropped and nothing else exists | both | `head` absent though profile had only a name | H5 reason booleans (`hasName` true, name invalid) => CONFIRMED; behavior is CORRECT (do not loosen the gate), route to H6 terminal tier |
| H-G | Transient network/outage on textures/mc-heads hosts | environment | PH appears intermittently for slots that rendered before | Retry after connectivity check; not a code defect |

Interpretation order: H-A/H-B first (they are cheap all-or-nothing config checks), then H-C/H-D (bridge-side,
slot-selective), then H-E/H-F (render-side). "Some slots render, some don't" on one screen rules OUT H-A/H-B for
that deployment and points at H-C..H-F.

#### 1.8.4 Phase H5 — privacy-safe head diagnostics (implement before any hardening)

Goal: attribute every PH slot to exactly one matrix row WITHOUT logging identities or secrets. Constraint that
drives the design: profile data IS identity data — player names, UUIDs, and the base64 textures value (which
decodes to JSON embedding `profileId`/`profileName`) must never appear in logs, counters, or client-bound
messages. Diagnostics stay on the Mac mini (console + localhost-only `/admin/status`); nothing new is sent to the
PWA or any third party.

- Known leak to close first: the existing `DEBUG_GUI_ITEMS=1` summarizer (`summarizeItemForDebug`,
  `mc-session.ts:1640`) prints raw component values truncated at 220 chars (`mc-session.ts:1685`) — for heads that
  includes the base64 textures prefix, whose decode contains `profileId`/`profileName`, plus raw `name`/`uuid`
  profile fields. Before H5 QA runs, redact within the summarizer: for any `properties[].value`, any field named
  `uuid`/`UUID`/`id`/`Id`/`name`/`Name` under a profile/SkullOwner subtree, and any string matching the dashed or
  32-hex uuid patterns or a base64 `eyJ` JSON prefix, emit `"<redacted:kind:len>"` instead of the value. Structure
  (keys, types, lengths) remains — shape is what diagnosis needs.
- New head-shape log, flag `HEAD_DEBUG=1` (bridge env, independent of `DEBUG_GUI_ITEMS`): one line per DISTINCT
  head shape (dedupe by shape signature, cap 40 like `debugGuiItem`): `{ branch: "componentMap" | "component" |
  "legacy-nbt" | "none", profileKeys: string[], hasUuid: boolean, hasName: boolean, hasTextures: boolean,
  nameValid: boolean, uuidValid: boolean, failureReason?: "no-profile" | "bad-base64" | "non-canonical" |
  "oversize" | "bad-json" | "bad-host" | "bad-id", textureIdHash8?: string }` where `textureIdHash8` is the first
  8 hex chars of sha256(textureId) — enough to correlate bridge extraction with app-side rendering of the same
  head, not reversible to the id (the id itself is not secret, but hashing keeps the log free of any value that
  could be replayed into a URL). `failureReason` requires threading a reason out of the existing never-throw
  helpers instead of bare `undefined` returns — keep the never-throw contract; reasons are strictly for logs.
- Aggregate counters in `movement`-style diagnostics surfaced through `/admin/status` (localhost-only,
  `ws-server.ts` guard `isLocalAdminRequest`): `{ headsSeen, headsWithHeadField, byBranch: {...},
  byFailureReason: {...} }` — numbers only, no strings from item data.
- App half (dev builds only, `__DEV__`-gated, no new env flag): per player_head mount, `console.debug` one line
  when the tier list is exhausted or a tier errors: `{ tiersTried, exhausted, headPresent, textureIdHash8? }` —
  compute the same sha256 prefix client-side from `head.textureId`; never log uuid/name or URLs. Console only;
  never transmitted.
- Files: `bridge/src/mc-session.ts` (redaction + shape log + counters), `bridge/src/session-manager.ts` +
  `bridge/src/ws-server.ts` (`/admin/status` passthrough), `apps/mobile/src/components/MinecraftItemIcon.tsx`
  (dev trace). Tests: extend `bridge/test/head-metadata.test.js` — redaction never emits a uuid/name/base64
  fixture value verbatim; failure reasons map correctly per fixture; counters increment.
- Rollback: both flags off restores today's behavior; redaction of the existing debug channel is kept (it is a
  leak fix, not a feature).

#### 1.8.5 Phase H6 — extraction hardening + terminal render tier (each item gated on H5 evidence)

- Base64 tolerance (activate on H-D evidence): before validation, strip ASCII whitespace and translate the
  url-safe alphabet (`-_` -> `+/`); DROP the canonical re-encode equality check (`mc-session.ts:1602-1603`). The
  canonicality check was defense-in-depth on an input that is fully re-validated after decode (JSON shape, `https`
  scheme, exact `textures.minecraft.net` host, anchored 40-64 hex id, no search/hash/credentials) — those gates
  all stay; the 8 KB pre-decode cap stays.
- Profile-shape coverage (activate on H-C evidence): extend `profileRecord()`/`componentPayload()` ONLY with
  shapes actually observed in H5 `profileKeys` logs from the simulator and production runs — no speculative
  shapes. Each new shape lands with a fixture in `head-metadata.test.js` copied from the (redacted) observed
  structure with dummy values.
- Terminal generic-head tier (activate on H-E/H-F evidence, or unconditionally as UX polish): append a final tier
  to `playerHeadTextureTiers()` for every player_head — a generic Steve-class head from an ALREADY-allowlisted
  host (candidate: `https://mc-heads.net/avatar/MHF_Steve`; the exact identifier is an implementation detail —
  whatever is chosen MUST be probed for HTTP 200 during QA from both the simulator and the deployed PWA origin
  before shipping, since 1.8.2 proves the minecraft-assets path can never backstop heads). Result: the PH letter
  fallback for player_head becomes an offline-only state. No new hosts are added to the allowlist.
- Explicitly rejected: loosening the player-name gate (H-F names are decorative, not identities to resolve);
  adding new texture hosts; logging raw profile payloads to "see what servers send" (H5's shape log answers that
  privately).

#### 1.8.6 Track 1 acceptance gates

Simulator (local 1.21.11 server per README flow, `HEAD_METADATA_ENABLED=1`, `EXPO_PUBLIC_HEAD_RENDER_ENABLED=1`):
- S-H1: chest with four heads — (i) textures-property head, (ii) premium-name head, (iii) uuid-only head,
  (iv) garbage-profile head. PASS = (i) shows its custom texture, (ii) shows the player's face, (iii) shows a
  face or the H6 generic head, (iv) shows the H6 generic head; ZERO lettered PH cells while online. Evidence:
  screenshot + `/admin/status` head counters with `headsSeen >= 4`.
- S-H2 (privacy): run S-H1 with `HEAD_DEBUG=1 DEBUG_GUI_ITEMS=1`; grep the full bridge log for (a) any 32-hex or
  dashed-uuid string, (b) any `eyJ` base64-JSON prefix, (c) the known test account name. PASS = zero matches
  outside `<redacted:...>` markers. This gate is mandatory before the flags are ever enabled in production.
- S-H3 (offline degrade): block `textures.minecraft.net` and `mc-heads.net` (hosts file); heads degrade to the PH
  letter fallback without layout shift or render loop; restore network, heads recover on next window open.

Production (live server via the deployed PWA + Mac mini bridge):
- P-H1: open the exact server GUI that exhibited PH slots in the simulator evidence. PASS = every player_head
  slot renders a head texture (custom, avatar, or generic terminal tier); ANY remaining PH slot must have a
  same-session H5 log line whose `failureReason` explains it (i.e. zero unexplained fallbacks).
- P-H2: `/admin/status` (from the mini, localhost) shows `headsWithHeadField / headsSeen` ratio consistent with
  P-H1; the mini's logs pass the S-H2 grep. No client-visible diagnostics are present in the deployed app
  (dev-only trace compiled out).

---

## Track 2 — Reliable movement (why buttons "work" but vmfhf's coordinates don't change)

### 2.1 How movement is supposed to work in this stack (evidence)

- App: `MovementPanel` sends `movement_control {control, pressed, holdMs:1500}` on press, re-sends every 500 ms
  heartbeat, sends `pressed:false` on release, `movement_stop_all` on background/hide
  (`apps/mobile/src/components/MovementPanel.tsx:17-19,96-125`). Gated client-side to cohort flag + IGN `vmfhf`
  (`appConfig.ts:11-23`, `ChatScreen.tsx:752-754`).
- Bridge: `ws-server.ts:1296-1325` checks `MOVEMENT_ALLOWED_IGNS` (fail-closed, `movement-control.ts:152-158`,
  `config.ts:58`), rate-gates (24/s, `movement-control.ts:24-26`), then `McSession.setMovementControl` leases the
  control (max hold 2000 ms, `movement-control.ts:22-24`) and `syncMovementControls()` (`mc-session.ts:895-914`):
  sets mineflayer control states, `bot.physicsEnabled = true`, and writes a `player_input` packet
  (`writeMovementInput`, `mc-session.ts:916-928`; flags mapping `movement-control.ts:138-150`; packet schema
  `pc/1.21.11/protocol.json` `packet_player_input` bitflags). Every `physicsTick` re-writes `player_input`
  (`mc-session.ts:191-194`).
- mineflayer: actual displacement is CLIENT-SIDE physics + serverbound `position`/`position_look` packets.
  `tickPhysics` (`node_modules/mineflayer/lib/plugins/physics.js:78-89`):
  - `:79` bail if entity/position not finite;
  - `:80` bail if `bot.blockAt(bot.entity.position) == null` (chunk not loaded) — NOTHING moves and NO position
    packets are sent;
  - `:81` simulate only when `bot.physicsEnabled && shouldUsePhysics`;
  - `shouldUsePhysics` starts false and only becomes true after a clientbound `position` (teleport) packet
    (`physics.js:435,446`); it is reset to false on `login`, `respawn`, `death`, `mount`
    (`physics.js:477-487`). Whether the live proxy's `start_configuration` handoff re-fires mineflayer's `login`
    (and thus this reset) is UNPROVEN for this stack — M1 instruments the exact event sequence instead of assuming
    it.
- IMPORTANT protocol fact: in 1.21.3+ the serverbound `player_input` packet informs the server of input state
  (sneak/sprint/vehicle steering; vanilla parity) but does NOT itself move the player on a vanilla/Paper server —
  the server still moves players from serverbound `position*` packets. mineflayer itself only uses `player_input`
  for sneak (`physics.js:261-268`). So "send player_input 20x/s" without a running physics sim cannot change
  coordinates. The bridge's own session defaults are physics-off for CPU reasons (`disableUnusedSimulation`,
  `mc-session.ts:156-164`) and only movement presses enable it.
- Existing diagnostics already exposed per session: `movementDiagnostics()` returns `controls`, `botControls`,
  `physicsEnabled`, `blockLoaded` (== the `physics.js:80` gate), `gameMode`, `velocity`
  (`mc-session.ts:527-553`), surfaced through `/admin/status` (`session-manager.ts:26-40`, localhost-only route at
  `ws-server.ts:468`, guard `isLocalAdminRequest` at `:625`).

### 2.2 Evidence-first diagnostic matrix

Run with: movement pressed for 3+ s while polling `curl -s localhost:8080/admin/status | jq '.sessions.sessions[]'`
on the Mac mini, plus the app's coordinate readout (`MovementPanel` position strip) and, when possible, a vanilla
spectator client watching vmfhf.

| # | Hypothesis | Where the gap is | Observable signal (from existing telemetry) | Verdict rule |
|---|---|---|---|---|
| A | Chunk not loaded under bot (limbo/void world, or server never sent chunks) | server/proxy environment, hits `physics.js:80` | `blockLoaded:false` while `physicsEnabled:true`, `velocity` stays `0,0,0`, position frozen | If `blockLoaded:false` during press -> CONFIRMED; movement is impossible client-side until chunks arrive |
| B | `shouldUsePhysics` stuck false after proxy `login`/configuration restart (no teleport packet since) | mineflayer state machine (`physics.js:477-487`), invisible to current telemetry | `blockLoaded:true`, `physicsEnabled:true`, correct `botControls`, but `velocity` stays 0 AND no `position` messages ever tick in app since last "configuration restart" system line (`mc-session.ts` emits it, `:355`) | Needs Phase M1 epoch instrumentation (`forcedMove` bound to the current movement epoch) to confirm directly; strong suspect if A is false |
| C | Server accepts packets but rubber-bands (anticheat, frozen player, adventure-mode region, proxy swallowing serverbound position) | server/proxy policy | `velocity` nonzero, position advances briefly then snaps back; app coordinates jitter around a fixed point; server console may log "moved wrongly" | Observe from spectator client + app jitter; bridge cannot fix — becomes a server-owner ask |
| D | Wrong gamemode/state (spectator can't be moved by physics as expected, dead player, in vehicle) | player state | `gameMode` field; death screen text in chat; `mount` resets `shouldUsePhysics` (`physics.js:477`) | Read `gameMode`/chat; if spectator/dead -> expected behavior, not a bug |
| E | Lease/heartbeat churn releases controls early (transport-layer suspicion) | bridge/app | `controls` empties while button held; `movementRateLimited` counter climbing (`/admin/status` counters, `ws-server.ts:109,1312-1317`) | Counters flat + `controls` stable -> transport EXONERATED (unit tests already cover leases: `bridge/test/movement-control.test.js:68-130,199-236`) |
| F | Control-state churn: every heartbeat re-press runs `clearControlStates()` then re-sets (`mc-session.ts:899`), re-queueing jump and momentarily zeroing controls between sim ticks | bridge implementation hygiene | Sawtooth `velocity`; forward motion slower than expected but nonzero | Only relevant once motion exists at all; fix in Phase M3 |
| G | `player_input` flood (20/s identical packets from `mc-session.ts:191-194`) tripping proxy packet limiter | proxy policy | Kicks/disconnects correlated with press ("recentKicks" in `/admin/status`) | If kicks correlate -> throttle to on-change writes (Phase M3) |

Interpretation order: A -> B -> D -> C. E/F/G are secondary. The button pipeline itself (WS -> lease -> controls ->
packets) is already covered by passing unit tests, so "transport succeeds" is expected even when every one of A-D
holds — this is exactly the reported symptom.

### 2.3 Phases

Phase M1 — Instrumentation (no behavior change, ship first)
- `bridge/src/mc-session.ts`: extend `movementDiagnostics()` with:
  - `movementEpoch`: a monotonic counter incremented on every event that can invalidate teleport sync —
    `start_configuration` (hook already exists in `wireProtocolCompat`, `mc-session.ts:333-408`), `login`,
    `respawn`, `death`, `mount` — plus `epochEvents`: per-event fire counts and last timestamps, so live evidence
    shows exactly which of these events the 99999.kr proxy chain actually fires (none is assumed),
  - `teleportEpoch` + `lastForcedMoveAt` (listener on `bot.on('forcedMove')` — records the `movementEpoch` value
    current when the clientbound teleport was processed, proving `shouldUsePhysics === true` for THAT epoch),
  - `lastPhysicsTickAt` (from the existing `physicsTick` handler at `:191`),
  - `loadedColumns` (`bot.world.getColumns().length`, API verified at
    `node_modules/prismarine-world/src/worldsync.js:78`),
  - `positionDelta3s` (ring of last 12 position snapshots).
- `bridge/src/session-manager.ts`: pass-through in `ManagedSessionSummary` (`:26-40`).
- Optional client surface behind flag `MOVEMENT_DEBUG=1`: new ServerMessage
  `{ type: "movement_debug", blockLoaded, physicsTicking, teleportSynced, gameMode, ts }` (`teleportSynced` :=
  `teleportEpoch === movementEpoch`) emitted at most 1/s while
  any lease is active; app shows it as a small line in `MovementPanel` (dev builds only,
  `EXPO_PUBLIC_MOVEMENT_DEBUG`).
- Backward compat: additive fields; message only sent when flag on AND client authenticated for movement.
- Rollback: flags off.

Phase M2 — Deterministic readiness gate (fix for A/B class failures)
- Definition of "movement-ready": `connected && blockLoaded && teleportEpoch === movementEpoch` — epoch binding,
  never a same-millisecond timestamp comparison (two events landing in one ms would make a `>` on timestamps
  undecidable). The epoch event list above is provisional until M1 evidence confirms which events actually fire on
  the live proxy: instrument first, then finalize readiness. Compute in
  `McSession`; emit `{ type: "movement_ready", ready: boolean, reason?: "chunks" | "teleport" | "disconnected" }`
  on transitions; `MovementPanel` disables controls and shows the reason instead of silently eating presses
  (replace the bare `connected` prop gate at `MovementPanel.tsx:97`).
- If diagnosis shows B (no teleport since the last epoch bump) is common on the live proxy: after enabling physics
  on first press, if `teleportEpoch < movementEpoch` hold the press in "pending" and surface reason `teleport`. Do NOT
  fabricate a serverbound position without a server teleport — that risks "moved wrongly" kicks; there is no safe
  client-side workaround for B. (If B is confirmed as the blocker on 99999.kr, the resolution is a server-owner
  conversation: ensure players are actually spawned into a world, not parked in limbo, for the movement cohort.)
- Files: `bridge/src/mc-session.ts`, `bridge/src/types.ts`, `apps/mobile/src/protocol.ts`,
  `apps/mobile/src/components/MovementPanel.tsx`, `apps/mobile/src/screens/ChatScreen.tsx` (route new message).
- Rollback: message emission behind `MOVEMENT_READY_ENABLED=1`; app treats absence of the message as today's
  behavior.

Phase M3 — Hygiene fixes (only after M1 data)
- `syncMovementControls()`: diff desired vs current control states instead of `clearControlStates()` + re-set
  (removes jump re-queue churn, hypothesis F).
- `writeMovementInput`: write only when flags changed since last write (hypothesis G); keep the neutral-on-release
  guarantees that tests lock in (`bridge/test/movement-control.test.js:199-254`).
- Anti-AFK look nudge (`mc-session.ts:686-697`) skipped while movement leases active (avoid yaw drift mid-press).
- Rollback: each is an isolated commit; revert individually.

### 2.4 Tests

- Unit (extend `bridge/test/movement-control.test.js`, same fake-bot pattern at `:17-52`): movement-ready state
  machine (chunks/teleport/disconnect transitions; every epoch-bumping event — `start_configuration`, `login`,
  `respawn`, `death`, `mount` — invalidates readiness until the next `forcedMove` in that epoch); player_input
  written only on flag change; control-state diffing
  keeps a held `forward` set across heartbeat re-press; diagnostics fields populated.
- Integration (manual but scripted, Mac local): vanilla 1.21.11 server per README local-test flow; assert via app
  that X/Z advance during a 2 s forward press, stop within 250 ms of release (position stream cadence,
  `POSITION_SYNC_MS`), and no server "moved wrongly" logs. This is the only environment where the full physics loop
  is provable without the live proxy's unknowns.
- Simulator QA on live server (vmfhf account): run the 2.2 matrix top to bottom, capture `/admin/status` JSON
  snapshots as the evidence artifact for the fix decision.
- Test discipline: no timing-luck sleeps in unit tests — the lease-expiry test pattern that awaits a 300 ms wall
  clock (`movement-control.test.js:228-236`) should be migrated to injected clocks when touched.

### 2.5 Blockers and readiness

- User/account blocker: live diagnosis requires the vmfhf cohort account and `MOVEMENT_ALLOWED_IGNS` set on the
  Mac mini bridge (server-side allowlist, `config.ts:58`).
- Proxy/server blocker (likely, to be proven by M1): 99999.kr fronted by a proxy/limbo (code already handles
  `start_configuration` restarts, cookies, `transfer`, and Korean "접속대기중" limbo boss bars —
  `wireProtocolCompat` at `mc-session.ts:333-408`, `isTransientLimboBossBar` at `:1093`). If players sit in a
  void/limbo world (matrix row A/B) or an anticheat rejects bot movement (row C), no bridge change can move the
  player; that requires the server owner.
- Verdict: DIAGNOSIS READY (M1 is pure instrumentation, implement immediately). FIX CONDITIONALLY READY —
  M2/M3 are fully specified but their activation depends on which matrix row the M1 evidence confirms.

### 2.6 Revision: M1 implemented; live position-evidence protocol

#### 2.6.1 Implemented state (verified in this worktree, commit `31561b3`)

`movementDiagnostics()` now reports `movementEpoch`/`teleportEpoch` (fields at `bridge/src/mc-session.ts:93-94`,
epoch bump at `:651`, `forcedMove` binding at `:280,660`), `epochEvents` per-event counts (`:634-636`),
`lastPhysicsTickAt` (`:166,272`), `loadedColumns` via `bot.world.getColumns().length` (`:644`), and
`positionDelta3s` (`:645,687`), all passed through `ManagedSessionSummary`
(`bridge/src/session-manager.ts:45,244`) to `/admin/status`. Unit tests extended in
`bridge/test/movement-control.test.js`. The optional client-facing `movement_debug` message from M1 is NOT
implemented — acceptable: the evidence protocol below reads the admin surface directly and does not need it.

#### 2.6.2 Live position-evidence protocol and acceptance gates

Every movement claim from here on must cite this artifact set — "buttons work" is never again accepted without
position evidence:

- Artifact A (bridge truth): two `/admin/status` snapshots taken >= 3 s apart while the control is held —
  `curl -s localhost:8080/admin/status | jq '{t: now, s: [.sessions.sessions[] | {ign, blockLoaded,
  physicsEnabled, movementEpoch, teleportEpoch, loadedColumns, positionDelta3s, controls}]}'` — saved to files.
- Artifact B (app truth): the `MovementPanel` coordinate strip before/during/after the press (screenshots or
  screen recording), which reflects the `position` stream (250 ms cadence).
- Concordance rule: a run counts as MOVEMENT CONFIRMED only when A and B agree — `positionDelta3s` horizontal
  distance > 0 in consecutive snapshots AND the app strip shows the same-direction coordinate change. A shows
  motion but B does not => position stream bug (bridge->app); B shows motion but A does not => impossible, re-take
  A. Neither => walk the 2.2 matrix with the same snapshots (they contain every signal the matrix needs).

Simulator acceptance gate S-M1 (local 1.21.11 server): hold forward 2 s. PASS = horizontal displacement >= 2
blocks across Artifacts A+B, motion stops within one position-sync period (250 ms) of release, zero "moved
wrongly" lines in the server console, and `teleportEpoch === movementEpoch` with `blockLoaded: true` throughout.

Production acceptance gate P-M1 (vmfhf on the live server, `MOVEMENT_ALLOWED_IGNS` set): same press protocol.
PASS = concordant nonzero displacement. If displacement is zero, the run is still a VALID diagnostic success when
the snapshots pin exactly one matrix row (A: `blockLoaded:false`; B: `teleportEpoch < movementEpoch` with
`epochEvents` showing which proxy event bumped it; C: delta oscillates around a fixed point; D: `gameMode`
non-survival) — that row's verdict then routes M2/M3 or the server-owner escalation per 2.5. "Zero displacement,
no row pinned" is the only FAIL state, and means the diagnostics themselves need extending.

---

## Track 3 — Contextual top-down map (iPhone PWA + Mac mini)

### 3.1 Options compared

| Option | How | Pros | Cons | Fit |
|---|---|---|---|---|
| A. Bounded loaded-chunk sampling (bridge-side) | Sample the columns mineflayer already holds (`bot.world.getColumn/getBlock`, `worldsync.js:78-101`; columns arrive via `map_chunk`, `mineflayer/lib/plugins/blocks.js:264-307`; unloaded on `unload_chunk`/dimension switch `blocks.js:41,513-534`) into a small color grid around the player | No server access needed; data already in RAM; bounded by server view distance; works through the proxy | Only shows loaded area; needs a block->color table; CPU cost must be budgeted; void/limbo shows nothing (same signal as movement row A) | CHOSEN |
| B. Server plugin / plugin-messaging API | Custom Paper plugin streams map data | Authoritative, any radius | Requires installing code on 99999.kr — not in our control; violates "no server changes" non-goal | BLOCKED (server owner) |
| C. Dynmap / BlueMap embed | iframe/tile layer from a web map the server hosts | Zero bridge work; beautiful | Same server-owner blocker; heavy RAM/CPU on the game server; public URL leaks world data broadly | BLOCKED (server owner); optional Stage 3 if ever offered |

Decision: Option A, staged, with hard budgets. Options B/C are recorded as blocked alternatives, not fallbacks.

### 3.2 Staged architecture

Stage 0 (exists): position + heading already stream to the app (`position` message with `x,y,z,yaw,direction,
dimension,grounded`, `positionSnapshot` at `mc-session.ts:842`, sync timer `:868-889`; rendered in `MovementPanel`
coordinate strip, `MovementPanel.tsx:175-181,235-245`).

Stage 1 — Compass/position card (app-only, no protocol change)
- New `apps/mobile/src/components/PositionCompass.tsx`: rotating heading arrow (`yaw`), coordinates, dimension
  badge, staleness dot (fresh < 1 s, stale >= 10 s using `position.ts`). Mount in `ChatScreen` next to the
  movement modal. Pure UI; ships independently.

Stage 2 — Local top-down map from loaded chunks
- Bridge, new module `bridge/src/map-sampler.ts`:
  - On `map_subscribe`, sample a square of `2R+1 x 2R+1` block columns centered on the player at stride `step`
    (default R=32/step 1 = 65x65 output cells). Server-side clamp regardless of client request: the OUTPUT grid is
    capped at 65x65 cells, i.e. `ceil((2R+1)/step) <= 65` (so R=64 forces step 2); no configuration can exceed it.
  - Per column: top non-air block via `column.getBlockStateId` scanning down from the dimension max
    (verified per-column APIs in `prismarine-chunk/src/pc/1.18/ChunkColumn.js:154-183`; heightmaps are passed into
    columns at `blocks.js:306` but 1.18+ column heightmap accessors are not exposed, so scan-down with an early-out
    y-window around the player: `[y+48, y-64]`, then widen once if all air). Bounding is enforced, not hoped: the
    sampler counts block reads and a completed frame may consume <= 250,000 reads total; hitting the ceiling
    finishes the frame immediately (remaining cells = unknown index 0) and adaptively degrades step/radius for the
    next frame. Sampling work is sliced to <= 5 ms per event-loop turn (frame assembled incrementally across
    `setImmediate` slices), so a frame build can never stall the WS or protocol loops. The previously drafted
    129x129/~1.9M-read initial frame is explicitly rejected: the FIRST frame obeys the same read and slice budgets
    as every other frame.
  - Color: map `stateId -> blockName` via registry, then a ~256-entry block-family color table (new
    `bridge/src/map-colors.ts`, generated once from minecraft-data block list into source, not at runtime) with a
    single default for unknowns; y-shading +-10% for depth cues.
  - Output: `{ type: "map_frame", centerX, centerZ, radius, step, dimension, cols, rows, palette: string[],
    cells: string (base64 of one palette index per cell), heading: yaw, stale: boolean, ts }`.
    65x65 cells = 4,225 bytes raw, ~5.7 KB base64, + palette — comfortably under the 64 KB WS cap. Encoding
    decision (explicit, resolving an earlier draft contradiction): `cells` is RAW one-byte palette indices,
    base64-encoded — NOT run-length encoded. At <= 4,225 cells the raw form always fits the budget, keeps the
    encoder/decoder trivial on both sides, and makes frame size a pure function of grid dimensions (property tests
    can assert exact sizes). Schema, tests, and budgets all assume this raw form. Reject any config that would
    exceed 48 KB serialized.
  - Cadence: full frame on subscribe and then at most every 2000 ms, and only if the player moved >= 4 blocks,
    rotated >= 30 deg, or >= 1 sampled chunk got dirty (`blockUpdate`/`chunkColumnLoad` listeners are forwarded on
    the bot, `blocks.js:581-583`; keep a dirty-chunk `Set<chunkKey>` intersected with the sampled square).
  - Unloaded columns inside the square render as palette index 0 ("unknown"): the frame is always complete,
    never blocks on loading, and NEVER triggers chunk requests — the bridge only reads what the server already sent
    (this is the no-unbounded-dump guarantee).
- Protocol (both `types.ts` and `protocol.ts`):
  - Client: `{ type: "map_subscribe", radius?: number }`, `{ type: "map_unsubscribe" }`.
  - Server: `map_frame` (above) and `{ type: "map_state", state: "loading" | "live" | "stale" | "unsupported",
    reason?: string, ts }` (`unsupported`: no loaded chunks after 5 s (limbo/void), feature flag off, or version
    gap; `stale`: last frame > 10 s old, e.g. during configuration restart — reuse the `clearBossBars`-style hooks
    at `mc-session.ts:346-360`).
  - Subscription is per WS client and torn down on `close`/`error` exactly like movement
    (`stopMovementForClient` pattern in the `ws.on("close")` handler, `ws-server.ts:292-315`).
- App, new `apps/mobile/src/components/TopDownMap.tsx`:
  - Render the palette grid (always <= 65x65 cells); RN-web: decode to a data-URI PNG via offscreen canvas on web;
    on native a 65x65 `View` grid (4,225 views) is borderline — gate Stage 2 to the web PWA first (primary user
    surface is the iPhone PWA). Decision: web-first canvas, native shows Stage 1 card until a later pass.
  - Overlays: player arrow (heading from `position.yaw`), N indicator, stale/loading/unsupported states with the
    same visual language as `MovementPanel`'s OFFLINE pill.
  - Flag: `EXPO_PUBLIC_MAP_ENABLED` + cohort gating identical to movement (`appConfig.ts` pattern).

Stage 3 (optional, external) — BlueMap embed if the server owner ever installs it; app adds a plain link/iframe
card. No bridge work. Explicitly out of scope until the owner agrees.

### 3.3 Hard budgets (enforced in code, not aspirational)

- Output: <= 65x65 cells per frame, enforced server-side by the radius/step clamp (no client input can raise it).
- CPU (Mac mini bridge): <= 250,000 block reads per completed frame (counted, not estimated; ceiling hit -> frame
  completes with remaining cells unknown and the sampler adaptively degrades step/radius, floor R=16); <= 5 ms of
  sampling work per event-loop slice, frames assembled incrementally across slices; the first frame obeys the same
  budgets — there is no privileged large initial frame; frames <= 0.5/s per session; max 2 map-subscribed sessions
  bridge-wide (`MAP_MAX_SUBSCRIBERS=2`), others get `map_state: unsupported, reason: "capacity"`.
- Benchmark gate: these ceilings may only be RAISED after a scripted benchmark on the actual Mac mini (a
  `map-sampler` bench printing reads/frame and ms/slice against a worst-case synthetic world) demonstrates
  headroom, with the measured numbers recorded in the change that raises them.
- RAM: zero extra chunk storage (reads mineflayer's existing columns only); sampler state <= 2 MB per subscriber
  (dirty set + last frame + palette); enforced by construction (fixed-size buffers).
- Network: <= 48 KB per frame ceiling (a typical 65x65 frame is ~6 KB), <= 0.5 frame/s active, ~0 when unsubscribed
  or position/chunks unchanged -> <= 24 KB/s worst case per client, typically < 2 KB/s.
- Battery/app: canvas redraw only on new frame; no client-side polling loops (frames are pushed).

### 3.4 Security / privacy

- Map data is derived from chunks the server already sent this player's client; no other players' positions are
  included in `map_frame` (entity layer is explicitly out of scope v1) — so it reveals nothing the user's own
  vanilla client wouldn't.
- `map_subscribe` allowed only for authenticated sessions; radius server-clamped; subscribe attempts rate-limited
  via the existing per-client gate pattern (`MovementRateGate`, `movement-control.ts:120-136`, generalized or
  duplicated as `MapRateGate`: 4 subscribes/min).
- Feature flag `MAP_ENABLED=1` bridge-side; off -> `map_subscribe` answered with `unsupported`.

### 3.5 Phases, files, rollback

- Phase P1 (Stage 1): `apps/mobile/src/components/PositionCompass.tsx`, `ChatScreen.tsx` mount. No protocol change.
  Rollback: remove component.
- Phase P2: protocol messages + no-op bridge handler answering `unsupported` (both `types.ts`/`protocol.ts`,
  `ws-server.ts` switch — note its `default` arm is an exhaustiveness check at `ws-server.ts:1371-1376`, so new
  client message types MUST be added to the union in the same change). Old apps never send `map_subscribe`; old
  bridges never receive it from flag-gated apps -> clean two-sided compatibility.
- Phase P3: `bridge/src/map-sampler.ts`, `bridge/src/map-colors.ts`, wiring in `mc-session.ts` (subscribe registry,
  dirty listeners, frame timer following the `positionTimer` pattern at `mc-session.ts:868-889`) +
  `bridge/test/map-sampler.test.js`.
- Phase P4: `TopDownMap.tsx` web-first UI + `ChatScreen` routing + `EXPO_PUBLIC_MAP_ENABLED`.
- Rollback at any phase: flags off; P2's message types are inert without P3/P4.

### 3.6 Tests

- Unit (bridge): raw one-byte-palette-index base64 encoder round-trip (no RLE, matching the 3.2 encoding decision);
  radius/step clamping (output never exceeds 65x65 cells); read-budget cutoff (frame completes at 250k reads with
  remaining cells = unknown index 0); slice budget (sampler yields within 5 ms of injected work); frame-size
  ceiling property test (never > 48 KB for any allowed config, exact size for a given grid); dirty-chunk
  intersection; scan-down top-block on a synthetic
  `prismarine-chunk` ChunkColumn fixture (build via `new Chunk({minY:-64, worldHeight:384})` + `setBlockStateId`,
  APIs verified above) including all-air columns and unloaded columns -> index 0.
- Unit (app): frame decoder (base64 -> grid), state machine loading/live/stale/unsupported transitions driven by
  injected timestamps (no wall-clock sleeps).
- Simulator/manual: local 1.21.11 server — walk with movement controls and watch the map pan; force
  `stale` by suspending the server process; force `unsupported` by connecting before chunks load; verify frame
  cadence and sizes via `DEBUG` log line per frame (bytes, build ms).

### 3.7 Acceptance gates (revision)

Nothing in Track 3 is implemented yet; these gates bind the future implementation and are phrased against
observables only.

Simulator:
- S-P1 (Stage 1): compass card shows live coordinates/heading matching the F3-equivalent position of the bot on a
  local server; staleness dot flips to stale within 10 s of suspending the bridge process.
- S-P2 (Stage 2): with the bot walking via movement controls, the map pans; every frame's DEBUG line reports
  bytes <= 49,152 and block reads <= 250,000; frame cadence never exceeds 0.5/s; columns outside server view
  distance render as the unknown palette index; suspending the server flips `map_state` to `stale` <= 12 s;
  connecting before chunk load yields `unsupported` within 5 s.
- S-P3 (budget regression): the map-sampler unit suite (3.6) passes in a single run — the 65x65 clamp, read
  ceiling, slice yield, and exact-frame-size property tests are the executable form of the 3.3 budgets.

Production:
- P-P1: on the live server, either a live map frame renders (chunks loaded) or the map shows `unsupported`
  (limbo/void) — BOTH are passes; the fail state is a spinner/blank with neither a frame nor a state message.
  Cross-check: `unsupported` here must coincide with `blockLoaded:false`/`loadedColumns:0` in the Track 2
  snapshots (same environment signal, two readouts).
- P-P2: Mac mini stays healthy under map load — with 2 subscribers active, bridge CPU and memory (Activity
  Monitor or `ps`) show no monotonic growth over 10 min, and a 3rd `map_subscribe` receives
  `unsupported/capacity`.

### 3.8 Blockers and readiness

- Same environmental unknown as Track 2 row A: if the live proxy parks players in a void limbo, the map will
  correctly show `unsupported` (that is the designed behavior, and doubles as a diagnostic for movement).
- Stage 3 blocked on server owner (Dynmap/BlueMap installation). Options B/C blocked as stated.
- Verdict: Stage 1 READY; Stage 2 READY with budgets (implement after Track 2 M1 confirms the environment actually
  loads chunks — otherwise ship Stage 1 + `unsupported` state first); Stage 3 BLOCKED (external).

---

## Cross-cutting

### Recommended execution order (revised for current repo state)

H1, H3, and M1 have landed (`911535e`, `7005328`, `31561b3`). The order for the REMAINING work — written
model-agnostic: any implementation worker executes it from this document alone, using the cited files, flags, and
gates, with no dependency on which model/agent runs it:

1. Track 1 / H5 diagnostics + debug-channel redaction (closes the identity-leak in `DEBUG_GUI_ITEMS` and
   attributes every PH slot to a 1.8.3 matrix row; smallest, highest information).
2. Track 1 / H6 hardening items, each activated by its H5 evidence rule; then run gates S-H1..3, P-H1..2.
3. Track 2 / live evidence run per 2.6.2 (simulator S-M1 first, then production P-M1); route M2/M3 or the
   server-owner escalation from the pinned matrix row.
4. Track 3 / P1 compass (independent, anytime), then P2-P4 once the P-M1 snapshots confirm chunks load on the
   live server; bind implementation to the 3.7 gates.
5. Track 1 / H2 proxy remains deferred (only on a reproducible direct-render failure); H4 optional.

### Consolidated security/privacy budget table

| Area | Budget | Enforcement point |
|---|---|---|
| Head rendering (default, direct) | client `Image` loads from textures.minecraft.net + mc-heads.net only; ids regex-anchored; URLs constructed, never echoed; zero new bridge endpoints | `itemTextures.ts` URL builders |
| Head fallback proxy (deferred H2 only) | 16 MB / 256 textures / 7 d TTL / 128 KB per item; short-lived signed ticket per URL; 60 fetch/min/IP; textures.minecraft.net only, no off-host redirects | `head-texture.ts` (only if activated) |
| Profile parsing | base64 <= 8 KB, regex-anchored ids, never-throw | `extractHeadInfo` |
| Movement | unchanged: fail-closed IGN allowlist + 24 cmd/s + 2 s lease cap | existing (`movement-control.ts`) |
| Map frames | <= 65x65 cells, <= 250k block reads/frame, <= 5 ms/event-loop slice, <= 48 KB/frame, <= 0.5 fps, 2 subscribers, 0 extra chunk storage; ceilings raised only past the Mac mini benchmark gate | `map-sampler.ts` constructor + send path |
| Wire ceiling | 64 KB per WS message (existing) | `ws-server.ts:17` |
| Tokens/PII | no change: MS tokens stay in `TOKENS_DIR` on the mini; direct head rendering exposes client IPs to Mojang's texture CDN on image load only (same class as existing mc-heads.net avatars) | design |

### Automated test inventory (all `node --test`, matching existing commands `bridge: npm test`, `mobile: npm test`)

- `bridge/test/head-texture.test.js` (new), `bridge/test/map-sampler.test.js` (new),
  `bridge/test/movement-control.test.js` (extended), `apps/mobile/tests/itemTextures.test.mjs` (extended),
  `apps/mobile/tests/map-frame.test.mjs` (new). Plus `npm run typecheck` in both workspaces and the
  `SECURITY.md` audit gate (`npm audit --workspace bridge --omit=dev`); note the bridge gains an outbound fetch only
  if the deferred H2 proxy is ever activated.
  `bridge/test/head-texture.test.js` ships with H1 (extraction cases); its proxy cases land only with H2.

### Blocker register (single view)

| Blocker | Tracks | Owner | Detection |
|---|---|---|---|
| Proxy/limbo world without chunks or teleport sync | 2 (rows A/B), 3 | server owner (99999.kr) | M1 `blockLoaded` + `teleportEpoch` vs `movementEpoch`; map `unsupported` |
| Server anticheat rejecting bot movement | 2 (row C) | server owner | rubber-band signature in M1 + spectator observation |
| vmfhf not in `MOVEMENT_ALLOWED_IGNS` on the mini | 2 | operator (us) | bridge error "movement is not enabled for this account" |
| Dynmap/BlueMap installation | 3 Stage 3 | server owner | n/a (parked) |
| None for player heads | 1 | — | — |

### Readiness verdicts

| Track | Verdict |
|---|---|
| 1. Player-head textures | H1+H3 LANDED; H5 diagnostics READY now (with mandatory debug redaction); H6 hardening evidence-gated per 1.8.5; H2 deferred; H4 optional |
| 2. Movement | M1 LANDED; next step is the 2.6.2 evidence run; M2/M3 activation contingent on the pinned matrix row; possible external blocker |
| 3. Top-down map | Stage 1 READY now; Stage 2 READY, gated on P-M1 environment confirmation and bound to 3.7 gates; Stage 3 BLOCKED (external) |

---

## Self-review

- Every protocol/library claim above was checked against the installed sources this repo builds with, not memory:
  1.21.11 `profile` component id 68 + `ResolvableProfile`/`PlayerSkinPatch` shapes (protocol.json),
  `packet_player_input` bitflags, prismarine-item `componentMap` (index.js:152-162), mineflayer physics gates
  (physics.js:78-89, 435-487), skinData extraction (entities.js:936-954), world column APIs (worldsync.js:78-101,
  blocks.js:264-307). All repo file:line citations in this document were re-verified by script against this
  worktree after drafting (a first pass had 4 drifted line numbers; they were corrected — e.g. `config.ts:58`,
  `ws-server.ts:109/523/585`, `mc-session.ts:37/899/1093/1212`).
- Deliberate scope cuts: no entity/other-player layer on the map (privacy + budget), no server-side movement
  workaround for missing teleport sync (kick risk), no reliance on unverified mc-heads texture-id endpoints
  (labeled as unverified), no canvas pipeline on native in map v1 (web PWA is the stated primary surface).
- Known weaknesses honestly held: (a) M2's "pending press" UX depends on M1 confirming which failure row dominates —
  the plan intentionally refuses to pick a fix before evidence; (b) the block-color table is a maintenance cost —
  mitigated by family-level colors + default; (c) `protocol.ts`/`types.ts` manual mirroring is a standing
  drift risk — every phase lists both files to keep the sync explicit.
- Process note: a parallel dispatch (`task_f2210c7e6c46`) wrote a competing draft to this same path mid-flight;
  that draft was preserved outside the repo before this reviewed version was restored. No claim is made that the
  worktree contains exactly one untracked path: agent runtime artifacts (e.g. `.senpi/`) may exist alongside the
  deliverable and are not part of it.
- Constraint compliance: this plan's DELIVERABLE is exactly one file (`docs/plans/player-head-movement-map.md`); no
  production code, dependencies, lockfiles, or deployment configuration were touched; budgets are hard-coded
  numbers, not "reasonable limits"; no unbounded chunk dump exists in any stage.
- Revision self-review (2026-08-08, `task_1d168f29dfb7`): all new claims in sections 1.8/2.6/3.7 were verified
  against the worktree at `7005328` or by direct probe this session: the minecraft-assets `player_head.png` 404s
  (vs `diamond_sword.png` 200) were fetched live; every cited line (`config.ts:5`, `appConfig.ts:23-24`,
  `mc-session.ts:1357/1378/1602-1603/1640/1685`, `itemTextures.ts:79-92/115-129`, `MinecraftItemIcon.tsx:77-97`,
  epoch/diagnostic fields in `mc-session.ts` and `session-manager.ts:45,244`) was read in the current sources, not
  recalled. The PH-fallback matrix deliberately front-loads the two config-flag rows because both feature flags
  default OFF — a deployment where the flags were never set is indistinguishable from an extraction bug without
  checking them first. Privacy stance tightened: the existing debug channel's identity leak is treated as a
  defect to fix BEFORE diagnostics run in production, and gate S-H2 makes the no-identities-in-logs property an
  executable check rather than a promise. No implementation was performed under this revision; the deliverable
  remains this single document, and all instructions are file/flag/gate-based so any default-routed implementation
  worker can execute them without model-specific assumptions.
- Revision self-review (2026-08-08, `task_45fdf66be8eb`): re-checked every budget and readiness statement against
  the coordinator corrections. Direct `textures.minecraft.net` rendering is the default head path everywhere it
  appears (design, phases, security table, execution order, verdicts), with the proxy consistently marked
  deferred + ticketed. Movement readiness uses monotonic epoch binding (`teleportEpoch === movementEpoch`) with no
  timestamp comparison, and the unproven `start_configuration`->`login` refire claim was removed in favor of M1
  event instrumentation. Every map budget mention agrees on <= 65x65 cells / <= 250k reads per frame / <= 5 ms per
  slice / no large initial frame / benchmark gate before raising limits. The map encoding is uniformly raw one-byte
  palette indices; RLE appears only as the explicitly rejected alternative. Grep-checked after editing for stale
  `129x129` budgets, `1.9M` worst cases, RLE encoders, and `lastForcedMoveAt`-vs-`lastLoginAt` comparisons.
