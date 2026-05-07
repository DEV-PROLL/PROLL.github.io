import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ServersScreen } from "./src/screens/ServersScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import {
  getBridgeUrl,
  getCachedUserId,
  clearBridgeUrl,
  clearCachedUserId,
} from "./src/store/settings";

type Phase =
  | { name: "loading" }
  | { name: "server" }
  | { name: "login"; bridgeUrl: string }
  | { name: "chat"; bridgeUrl: string; ign: string; userId: string };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  useEffect(() => {
    void (async () => {
      const url = await getBridgeUrl();
      if (!url) {
        setPhase({ name: "server" });
        return;
      }
      const cachedUserId = await getCachedUserId();
      if (cachedUserId) {
        // We don't auto-jump into chat — the LoginScreen will offer
        // a "Continue as <ign>" button that re-auths via cached tokens.
        setPhase({ name: "login", bridgeUrl: url });
      } else {
        setPhase({ name: "login", bridgeUrl: url });
      }
    })();
  }, []);

  return (
    <>
      <StatusBar style="light" />
      {phase.name === "loading" && null}

      {phase.name === "server" && (
        <ServersScreen
          onContinue={(bridgeUrl) => setPhase({ name: "login", bridgeUrl })}
        />
      )}

      {phase.name === "login" && (
        <LoginScreen
          bridgeUrl={phase.bridgeUrl}
          onAuthenticated={({ ign, userId }) =>
            setPhase({
              name: "chat",
              bridgeUrl: phase.bridgeUrl,
              ign,
              userId,
            })
          }
          onChangeServer={async () => {
            await clearBridgeUrl();
            await clearCachedUserId();
            setPhase({ name: "server" });
          }}
        />
      )}

      {phase.name === "chat" && (
        <ChatScreen
          bridgeUrl={phase.bridgeUrl}
          ign={phase.ign}
          userId={phase.userId}
          onLogout={() =>
            setPhase({ name: "login", bridgeUrl: phase.bridgeUrl })
          }
        />
      )}
    </>
  );
}
