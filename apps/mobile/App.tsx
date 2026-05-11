import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ServersScreen } from "./src/screens/ServersScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import {
  getBridgeUrl,
  clearBridgeUrl,
  getMcVersion,
  getServerAddress,
} from "./src/store/settings";
import { DEFAULT_MC_VERSION } from "./src/mcVersions";
import { DEFAULT_SERVER_ADDRESS } from "./src/appConfig";

type Phase =
  | { name: "loading" }
  | { name: "server" }
  | {
      name: "login";
      bridgeUrl: string;
      mcVersion: string;
      serverAddress: string;
    }
  | {
      name: "chat";
      bridgeUrl: string;
      mcVersion: string;
      serverAddress: string;
      ign: string;
      userId: string;
      uuid?: string;
    };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  useEffect(() => {
    void (async () => {
      const url = await getBridgeUrl();
      const mcVersion = (await getMcVersion()) ?? DEFAULT_MC_VERSION;
      const serverAddress = (await getServerAddress()) ?? DEFAULT_SERVER_ADDRESS;
      if (!url) {
        setPhase({ name: "server" });
        return;
      }
      setPhase({ name: "login", bridgeUrl: url, mcVersion, serverAddress });
    })();
  }, []);

  return (
    <>
      <StatusBar style="light" />
      {phase.name === "loading" && null}

      {phase.name === "server" && (
        <ServersScreen
          onContinue={(bridgeUrl, mcVersion, serverAddress) =>
            setPhase({ name: "login", bridgeUrl, mcVersion, serverAddress })
          }
        />
      )}

      {phase.name === "login" && (
        <LoginScreen
          bridgeUrl={phase.bridgeUrl}
          mcVersion={phase.mcVersion}
          serverAddress={phase.serverAddress}
          onAuthenticated={({ ign, userId, uuid }) =>
            setPhase({
              name: "chat",
              bridgeUrl: phase.bridgeUrl,
              mcVersion: phase.mcVersion,
              serverAddress: phase.serverAddress,
              ign,
              userId,
              uuid,
            })
          }
          onChangeServer={async () => {
            await clearBridgeUrl();
            setPhase({ name: "server" });
          }}
        />
      )}

      {phase.name === "chat" && (
        <ChatScreen
          bridgeUrl={phase.bridgeUrl}
          mcVersion={phase.mcVersion}
          serverAddress={phase.serverAddress}
          ign={phase.ign}
          userId={phase.userId}
          uuid={phase.uuid}
          onLogout={() =>
            setPhase({
              name: "login",
              bridgeUrl: phase.bridgeUrl,
              mcVersion: phase.mcVersion,
              serverAddress: phase.serverAddress,
            })
          }
        />
      )}
    </>
  );
}
