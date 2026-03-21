// RPC 配置

export interface RpcEndpoint {
  name: string;
  url: string;
  scan:string;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  icon?: string;
  rpcs: RpcEndpoint[];
}

export const chainConfigs: ChainConfig[] = [
  {
    chainId: 1,
    name: "Ethereum Mainnet",
    rpcs: [
      {
        name: "Infura",
        url: "",
        scan:""
      },
    ],
  },
];

// Tauri Store 持久化（替代 localStorage）
import { storeGet, storeSet } from "./tauriStore";

let _selectedChainId: number = chainConfigs[0].chainId;
let _selectedRpcUrl: string = chainConfigs[0].rpcs[0].url;
let _inited = false;

/** 应用启动时调用，从 Tauri Store 加载 RPC 配置到内存 */
export async function initRpcConfig(): Promise<void> {
  if (_inited) return;
  const [chainId, rpcUrl] = await Promise.all([
    storeGet<number>("selected_chain_id"),
    storeGet<string>("selected_rpc_url"),
  ]);
  if (chainId != null) _selectedChainId = chainId;
  if (rpcUrl != null) _selectedRpcUrl = rpcUrl;
  _inited = true;
}

export function getSelectedChain(): number {
  return _selectedChainId;
}

export function setSelectedChain(chainId: number): void {
  _selectedChainId = chainId;
  storeSet("selected_chain_id", chainId);
}

export function getSelectedRpc(): string {
  return _selectedRpcUrl;
}

export function setSelectedRpc(url: string): void {
  _selectedRpcUrl = url;
  storeSet("selected_rpc_url", url);
}

export function getChainById(chainId: number): ChainConfig | undefined {
  return chainConfigs.find((c) => c.chainId === chainId);
}

// 获取当前选择的完整配置
export function getCurrentConfig(): {
  chain: ChainConfig;
  rpc: RpcEndpoint;
} {
  const chainId = getSelectedChain();
  const rpcUrl = getSelectedRpc();
  
  const chain = getChainById(chainId) || chainConfigs[0];
  const rpc = chain.rpcs.find((r) => r.url === rpcUrl) || chain.rpcs[0];
  
  return { chain, rpc };
}
