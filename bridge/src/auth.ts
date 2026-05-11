import path from "path";
import fs from "fs/promises";
import { Authflow, Titles } from "prismarine-auth";

// One pending device-code flow per WS connection (keyed externally).
// We use prismarine-auth's deviceCodeCallback to surface the code to the app.

export interface AuthResult {
  // Stable identifier we use to key per-user token caches and sessions.
  // We choose the Microsoft account email (the Authflow username), since
  // mineflayer expects a username string and prismarine-auth caches by it.
  userId: string;
  // The exact identifier used when creating prismarine-auth cache files.
  // This must be passed back into mineflayer so it can find the cached token.
  cacheUserId: string;
  // The minecraft IGN the user just authed as.
  ign: string;
  uuid: string;
  // Where the prismarine-auth cache lives for this user (folder, NOT file).
  // Pass this as `profilesFolder` to mineflayer.createBot so it reuses tokens.
  profilesFolder: string;
}

export interface DeviceCode {
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

export class AuthService {
  constructor(private readonly tokensRoot: string) {}

  // Called once per app user. Returns a promise that resolves when the user
  // finishes the device-code flow in their browser. `onCode` is invoked
  // synchronously when the device code is issued so the bridge can forward
  // it to the app over WS.
  async loginWithDeviceCode(
    sessionKey: string,
    onCode: (c: DeviceCode) => void,
  ): Promise<AuthResult> {
    // Stage tokens under a temporary "session" folder until we know the
    // resulting Minecraft username, then move them under that username so
    // future logins by the same user reuse the cache.
    const cacheUserId = sessionKey;
    const stagingFolder = path.join(this.tokensRoot, `_pending-${sessionKey}`);
    await fs.rm(stagingFolder, { recursive: true, force: true });
    await fs.mkdir(stagingFolder, { recursive: true });

    const flow = new Authflow(
      // prismarine-auth requires *some* username for cache filenames. The
      // real identity is determined by the MS login performed in the browser;
      // this string is just a local cache key for the staging folder.
      cacheUserId,
      stagingFolder,
      {
        flow: "live",
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: "Nintendo",
      },
      (data) => {
        onCode({
          user_code: data.user_code,
          verification_uri: data.verification_uri,
          expires_in: data.expires_in,
        });
      },
    );

    try {
      const mcToken = await flow.getMinecraftJavaToken({ fetchProfile: true });
      const ign = mcToken.profile?.name;
      const uuid = mcToken.profile?.id;
      if (!ign || !uuid) {
        throw new Error("Minecraft profile missing — does this account own MC Java?");
      }

      // Move staging cache under a stable per-user folder keyed by IGN.
      const userFolder = path.join(this.tokensRoot, ign);
      await fs.rm(userFolder, { recursive: true, force: true });
      await fs.rename(stagingFolder, userFolder);
      await fs.writeFile(
        path.join(userFolder, "auth-meta.json"),
        JSON.stringify({ cacheUserId, ign, uuid }, null, 2),
      );

      return { userId: ign, cacheUserId, ign, uuid, profilesFolder: userFolder };
    } catch (err) {
      await fs.rm(stagingFolder, { recursive: true, force: true });
      throw err;
    }
  }

  // Try to load an existing cached login by user IGN. Returns null if the
  // cache directory does not exist or contains no usable tokens. We do NOT
  // refresh here — mineflayer/prismarine-auth will do that when it boots
  // the bot.
  async loadCached(userId: string): Promise<AuthResult | null> {
    const folder = path.join(this.tokensRoot, userId);
    let meta: { cacheUserId?: string; ign?: string; uuid?: string };
    try {
      const entries = await fs.readdir(folder);
      if (entries.length === 0) return null;
      const rawMeta = await fs.readFile(path.join(folder, "auth-meta.json"), "utf8");
      meta = JSON.parse(rawMeta) as typeof meta;
    } catch {
      return null;
    }
    // We don't have profile info without exchanging tokens; mineflayer will
    // surface the IGN/UUID via bot.username/bot.uuid once it logs in. The
    // caller can use that to update the auth_ok payload.
    if (!meta.cacheUserId) return null;
    return {
      userId,
      cacheUserId: meta.cacheUserId,
      ign: meta.ign ?? userId,
      uuid: meta.uuid ?? "",
      profilesFolder: folder,
    };
  }
}
