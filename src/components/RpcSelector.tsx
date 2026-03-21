import { useState, useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  chainConfigs,
  getSelectedChain,
  setSelectedChain,
  getSelectedRpc,
  setSelectedRpc,
  getChainById,
} from "@/lib/rpcConfig";

export function RpcSelector() {
  const [selectedChainId, setSelectedChainIdState] = useState<number>(() =>
    getSelectedChain()
  );
  const [selectedRpcUrl, setSelectedRpcUrlState] = useState<string>(() =>
    getSelectedRpc()
  );

  const selectedChain = getChainById(selectedChainId);

  useEffect(() => {
    // 当选择的链变化时，检查当前选择的 RPC 是否属于这条链
    if (selectedChain) {
      const rpcExists = selectedChain.rpcs.some(
        (rpc) => rpc.url === selectedRpcUrl
      );
      if (!rpcExists && selectedChain.rpcs.length > 0) {
        // 如果当前 RPC 不属于新选择的链，切换到该链的第一个 RPC
        const newRpcUrl = selectedChain.rpcs[0].url;
        setSelectedRpcUrlState(newRpcUrl);
        setSelectedRpc(newRpcUrl);
      }
    }
  }, [selectedChainId, selectedChain, selectedRpcUrl]);

  const handleChainChange = (value: string) => {
    const newChainId = parseInt(value, 10);
    setSelectedChainIdState(newChainId);
    setSelectedChain(newChainId);
  };

  const handleRpcChange = (value: string) => {
    setSelectedRpcUrlState(value);
    setSelectedRpc(value);
  };

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        {/* <Label htmlFor="chain-select" className="whitespace-nowrap">
          Chain
        </Label> */}
        <Select value={selectedChainId.toString()} onValueChange={handleChainChange}>
          <SelectTrigger id="chain-select" className="w-[200px]">
            <SelectValue placeholder="Select a chain" />
          </SelectTrigger>
          <SelectContent>
            {chainConfigs.map((chain) => (
              <SelectItem key={chain.chainId} value={chain.chainId.toString()}>
                {chain.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        {/* <Label htmlFor="rpc-select" className="whitespace-nowrap">
          RPC
        </Label> */}
        <Select value={selectedRpcUrl} onValueChange={handleRpcChange}>
          <SelectTrigger id="rpc-select" className="w-[250px]">
            <SelectValue placeholder="Select an RPC endpoint" />
          </SelectTrigger>
          <SelectContent>
            {selectedChain?.rpcs.map((rpc, index) => (
              <SelectItem key={`${rpc.url}-${index}`} value={rpc.url}>
                {rpc.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
