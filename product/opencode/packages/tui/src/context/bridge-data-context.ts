import { createContext, useContext } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";

const BridgeDataContextInternal = createContext<Plugin.Context["data"]>();

export function useBridgeData(): Plugin.Context["data"] {
  const value = useContext(BridgeDataContextInternal);
  if (!value) throw new Error("useBridgeData must be used inside the bridge data provider");
  return value;
}

export const bridgeDataContext = BridgeDataContextInternal;
