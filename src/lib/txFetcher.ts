import { createPublicClient, http } from "viem";
import { getBackendConfig } from "./appConfig";

export interface TxData {
  txHash: string;
  from?: string;
  to?: string | null;
  value?: bigint;
  gasPrice?: bigint;
  gasLimit?: bigint;
  gasUsed?: bigint;
  data?: string;
  status?: "success" | "reverted";
}

export interface BlockData {
  blockNumber?: bigint;
  timestamp?: bigint;
  gasLimit?: bigint;
  baseFeePerGas?: bigint;
  beneficiary?: string;
  difficulty?: bigint;
  mixHash?: string;
}

// 用于传递给后端调试的数据结构
export interface TxDebugData {
  from: string;
  to: string;
  value: string;
  gasPrice: string;
  gasLimit: string;
  data: string;
}

export interface BlockDebugData {
  number: string;
  timestamp: string;
  baseFee: string;
  beneficiary: string;
  difficulty: string;
  mixHash: string;
  gasLimit: string;
}

export async function fetchTxInfo(txHash: string): Promise<{ tx: TxData; block: BlockData }> {
  const { rpcUrl } = getBackendConfig();

  if (!rpcUrl) {
    throw new Error("No RPC URL configured. Please enter an RPC URL.");
  }

  // Create viem client with selected RPC
  const client = createPublicClient({
    transport: http(rpcUrl),
  });

  // Fetch transaction and receipt in parallel
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash as `0x${string}` }),
    client.getTransactionReceipt({ hash: txHash as `0x${string}` }),
  ]);

  // Fetch block info
  const block = tx.blockNumber 
    ? await client.getBlock({ blockNumber: tx.blockNumber })
    : undefined;

  return {
    tx: {
      txHash,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      gasPrice: tx.gasPrice ?? undefined,
      gasLimit: tx.gas,
      gasUsed: receipt.gasUsed,
      data: tx.input,
      status: receipt.status === "success" ? "success" : "reverted",
    },
    block: {
      blockNumber: tx.blockNumber ?? undefined,
      timestamp: block?.timestamp,
      gasLimit: block?.gasLimit,
      baseFeePerGas: block?.baseFeePerGas ?? undefined,
      beneficiary: block?.miner,
      difficulty: block?.difficulty,
      mixHash: block?.mixHash,
    }
  };
}
