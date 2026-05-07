import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDebugStore } from "@/store/debugStore";
import { disassemble } from "@/lib/opcodes";

export function TestDialog() {
  const isOpen = useDebugStore((s) => s.isTestDialogOpen);
  const testBytecode = useDebugStore((s) => s.testBytecode);
  const testOpcodes = useDebugStore((s) => s.testOpcodes);
  const { sync } = useDebugStore.getState();

  const handleOpenChange = useCallback((open: boolean) => sync({ isTestDialogOpen: open }), []);
  const handleBytecodeChange = useCallback((v: string) => sync({ testBytecode: v }), []);

  const handleDisassemble = useCallback(() => {
    try {
      let bytecodeStr = useDebugStore.getState().testBytecode.trim();
      if (bytecodeStr.startsWith("0x")) bytecodeStr = bytecodeStr.slice(2);
      bytecodeStr = bytecodeStr.replace(/\s+/g, "");
      const bytes = new Uint8Array(
        bytecodeStr.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
      );
      sync({ testOpcodes: disassemble(bytes) });
    } catch (error) {
      console.error("解析字节码失败:", error);
      sync({ testOpcodes: [] });
    }
  }, []);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>测试字节码解析</DialogTitle>
          <DialogDescription>
            输入十六进制字节码（可以带或不带 0x 前缀）
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex flex-col gap-4 min-h-0">
          <div className="flex-shrink-0">
            <Textarea
              placeholder="例如: 0x6080604052..."
              value={testBytecode}
              onChange={(e) => handleBytecodeChange(e.target.value)}
              className="font-mono text-sm min-h-[120px]"
            />
            <Button
              onClick={handleDisassemble}
              className="mt-2"
              disabled={!testBytecode.trim()}
            >
              解析
            </Button>
          </div>

          {testOpcodes.length > 0 && (
            <div className="flex-1 border rounded-md overflow-auto min-h-0">
              <div className="text-sm font-semibold p-2 border-b bg-muted/50">
                解析结果 ({testOpcodes.length} 条指令)
              </div>
              <div className="p-2">
                <table className="w-full text-sm font-mono">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 w-20">PC</th>
                      <th className="text-left p-2 w-32">操作码</th>
                      <th className="text-left p-2">数据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testOpcodes.map((op, idx) => (
                      <tr key={idx} className="border-b hover:bg-muted/30">
                        <td className="p-2 text-muted-foreground">{op.pc}</td>
                        <td className="p-2 font-semibold">{op.name}</td>
                        <td className="p-2 text-muted-foreground break-all">
                          {op.data || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
