import { createContext, useContext } from "solid-js";

import type { BridgeClientGroups } from "../../../bridge-core/src/bridge-opencode-client.ts";

const BridgeClientContextInternal = createContext<BridgeClientGroups>();

export function useBridgeClient(): BridgeClientGroups {
  const value = useContext(BridgeClientContextInternal);
  if (!value) throw new Error("useBridgeClient must be used inside the bridge client provider");
  return value;
}

export const bridgeClientContext = BridgeClientContextInternal;
