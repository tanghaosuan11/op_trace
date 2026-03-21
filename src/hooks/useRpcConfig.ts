import { useState, useCallback } from "react";
import {
  getCurrentConfig,
} from "@/lib/rpcConfig";

export function useRpcConfig() {
  const [config, setConfig] = useState(() => getCurrentConfig());

  /** 在 setSelectedChain / setSelectedRpc 后调用以刷新状态 */
  const refresh = useCallback(() => setConfig(getCurrentConfig()), []);

  return { ...config, refresh };
}
