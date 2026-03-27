import React, { useRef, useState } from 'react';
import { DataFlowTreeComponent, type DataNodeInfo } from './DataFlowTree';

interface DataFlowDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  rootId: number;
  nodes: DataNodeInfo[];
  onStepSelect?: (globalStep: number) => void;
}

export const DataFlowDrawer: React.FC<DataFlowDrawerProps> = ({
  isOpen,
  onClose,
  rootId,
  nodes,
  onStepSelect,
}) => {
  const [height, setHeight] = useState(window.innerHeight * 0.5);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  if (!isOpen || nodes.length === 0) return null;

  const handleDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;
      const deltaY = moveEvent.clientY - startYRef.current;
      const newHeight = Math.max(150, Math.min(600, startHeightRef.current - deltaY));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-300 shadow-2xl z-40 flex flex-col"
      style={{ height: `${height}px` }}
    >
      {/* 拖动条 */}
      <div
        onMouseDown={handleDragStart}
        className="h-1.5 bg-gray-300 hover:bg-blue-400 cursor-ns-resize flex-shrink-0 transition-colors"
        title="拖拽改变大小"
      />

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <DataFlowTreeComponent
          root_id={rootId}
          nodes={nodes}
          onNodeClick={(globalStep) => {
            console.log('[DataFlowDrawer] Jumping to step:', globalStep);
            onStepSelect?.(globalStep);
          }}
        />
      </div>

      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        className="absolute top-2 right-2 px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-900 text-sm rounded transition-colors"
        title="关闭"
      >
        ✕
      </button>
    </div>
  );
};

export default DataFlowDrawer;
