import { TestDialog } from "@/components/TestDialog";
import { GlobalLogDrawer } from "@/components/GlobalLogDrawer";
import { UtilitiesDrawer } from "@/components/UtilitiesDrawer";
import { AnalysisDrawer } from "@/components/AnalysisDrawer";
import { SymbolicSolveDrawer } from "@/components/SymbolicSolveDrawer";

interface DrawerHostProps {
  onSeekToWithHistory: (index: number) => void;
  /** Insert PC breakpoints at each step index found in the analysis result JSON/text. */
  onInsertBreakpointsFromAnalysisResult?: (resultText: string) => void;
  /** Replace step playback queue with indices from analysis result (Analysis Play). */
  onReplacePlaybackFromAnalysisResult?: (resultText: string) => void;
}

export function DrawerHost({
  onSeekToWithHistory,
  onInsertBreakpointsFromAnalysisResult,
  onReplacePlaybackFromAnalysisResult,
}: DrawerHostProps) {
  return (
    <>
      <TestDialog />
      <GlobalLogDrawer onSeekTo={onSeekToWithHistory} />
      <UtilitiesDrawer />
      <AnalysisDrawer
        onInsertBreakpointsFromResult={onInsertBreakpointsFromAnalysisResult}
        onReplaceStepsToPlaybackFromResult={onReplacePlaybackFromAnalysisResult}
      />
      <SymbolicSolveDrawer />
    </>
  );
}
