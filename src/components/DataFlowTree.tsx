import React, { useMemo, useRef, useEffect } from 'react';

export interface DataNodeInfo {
  id: number;
  global_step: number;
  pc: number;
  opcode: number;
  opcode_name: string;
  parent_ids: number[];
  stack_value_post?: string;
}

interface DataFlowTreeProps {
  root_id: number;
  nodes: DataNodeInfo[];
  onNodeClick?: (globalStep: number) => void;
}

interface NodePosition {
  nodeId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DataFlowTreeComponent: React.FC<DataFlowTreeProps> = ({
  root_id,
  nodes,
  onNodeClick,
}) => {
  const splitValueToThreeLines = (value: string): [string, string, string] => {
    const full = value.startsWith('0x') ? value : `0x${value}`;
    const padded = full.padEnd(66, '0').slice(0, 66);
    return [
      padded.slice(0, 22),
      padded.slice(22, 44),
      padded.slice(44, 66),
    ];
  };

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodeRefsMap = useRef<Map<number, HTMLElement>>(new Map());

  // 分层规则：按从 root 出发的最长路径深度分层 + barycenter 重排减少线交叉
  const layers: number[][] = useMemo(() => {
    const depthMap = new Map<number, number>();
    const queue: number[] = [root_id];
    depthMap.set(root_id, 0);

    while (queue.length > 0) {
      const childId = queue.shift()!;
      const childDepth = depthMap.get(childId) ?? 0;
      const child = nodeMap.get(childId);
      if (!child) continue;

      for (const parentId of child.parent_ids) {
        const nextDepth = childDepth + 1;
        const prev = depthMap.get(parentId);
        if (prev === undefined || nextDepth > prev) {
          depthMap.set(parentId, nextDepth);
          queue.push(parentId);
        }
      }
    }

    const maxDepth = Math.max(...Array.from(depthMap.values(), (d) => d), 0);
    const result: number[][] = Array.from({ length: maxDepth + 1 }, () => []);
    for (const [id, depth] of depthMap.entries()) {
      result[depth].push(id);
    }
    // 初始稳定排序：先按 step，再按 id
    for (const layer of result) {
      layer.sort((a, b) => {
        const na = nodeMap.get(a);
        const nb = nodeMap.get(b);
        const sa = na?.global_step ?? Number.MAX_SAFE_INTEGER;
        const sb = nb?.global_step ?? Number.MAX_SAFE_INTEGER;
        if (sa !== sb) return sa - sb;
        return a - b;
      });
    }

    const filtered = result.filter((layer) => layer.length > 0);
    if (filtered.length <= 2) return filtered;

    // 子 -> 父映射（已存在于 node.parent_ids）
    const parentMap = new Map<number, number[]>();
    const childMap = new Map<number, number[]>();
    for (const n of nodes) {
      parentMap.set(n.id, n.parent_ids);
      for (const p of n.parent_ids) {
        if (!childMap.has(p)) childMap.set(p, []);
        childMap.get(p)!.push(n.id);
      }
    }

    const indexOf = (layer: number[]) => {
      const m = new Map<number, number>();
      layer.forEach((id, i) => m.set(id, i));
      return m;
    };

    // 迭代 3 轮：top-down / bottom-up barycenter
    for (let iter = 0; iter < 3; iter++) {
      // top-down: 当前层按其父节点在下一层的位置均值排序
      for (let d = 0; d < filtered.length - 1; d++) {
        const cur = filtered[d];
        const next = filtered[d + 1];
        const nextIdx = indexOf(next);
        cur.sort((a, b) => {
          const pa = parentMap.get(a) ?? [];
          const pb = parentMap.get(b) ?? [];
          const ba = pa.length
            ? pa.reduce((s, id) => s + (nextIdx.get(id) ?? 0), 0) / pa.length
            : Number.MAX_SAFE_INTEGER;
          const bb = pb.length
            ? pb.reduce((s, id) => s + (nextIdx.get(id) ?? 0), 0) / pb.length
            : Number.MAX_SAFE_INTEGER;
          if (ba !== bb) return ba - bb;
          const sa = nodeMap.get(a)?.global_step ?? Number.MAX_SAFE_INTEGER;
          const sb = nodeMap.get(b)?.global_step ?? Number.MAX_SAFE_INTEGER;
          if (sa !== sb) return sa - sb;
          return a - b;
        });
      }
      // bottom-up: 当前层按其子节点在上一层的位置均值排序
      for (let d = filtered.length - 1; d >= 1; d--) {
        const cur = filtered[d];
        const prev = filtered[d - 1];
        const prevIdx = indexOf(prev);
        cur.sort((a, b) => {
          const ca = childMap.get(a) ?? [];
          const cb = childMap.get(b) ?? [];
          const ba = ca.length
            ? ca.reduce((s, id) => s + (prevIdx.get(id) ?? 0), 0) / ca.length
            : Number.MAX_SAFE_INTEGER;
          const bb = cb.length
            ? cb.reduce((s, id) => s + (prevIdx.get(id) ?? 0), 0) / cb.length
            : Number.MAX_SAFE_INTEGER;
          if (ba !== bb) return ba - bb;
          const sa = nodeMap.get(a)?.global_step ?? Number.MAX_SAFE_INTEGER;
          const sb = nodeMap.get(b)?.global_step ?? Number.MAX_SAFE_INTEGER;
          if (sa !== sb) return sa - sb;
          return a - b;
        });
      }
    }

    return filtered;
  }, [root_id, nodeMap]);

  // 更新节点位置并绘制连线（正交折线）
  useEffect(() => {
    if (!containerRef.current || !contentRef.current || !svgRef.current) return;

    const updateConnections = () => {
      const content = contentRef.current!;
      const svg = svgRef.current!;

      // 让 SVG 覆盖整个内容层（随内容滚动）
      const width = content.scrollWidth;
      const height = content.scrollHeight;
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.innerHTML = '';

      // 收集所有节点在 content 内的绝对坐标
      const positions: NodePosition[] = [];
      nodeRefsMap.current.forEach((el, nodeId) => {
        const x = el.offsetLeft;
        const y = el.offsetTop;
        positions.push({
          nodeId,
          x,
          y,
          width: el.offsetWidth,
          height: el.offsetHeight,
        });
      });

      const getNodePos = (nodeId: number) => positions.find(p => p.nodeId === nodeId);

      // 为同一 child 或同一 parent 的多条边分配不同锚点偏移，减少重叠
      const childEdgeCount = new Map<number, number>();
      const parentEdgeCount = new Map<number, number>();
      for (const n of nodes) {
        childEdgeCount.set(n.id, n.parent_ids.length);
        for (const p of n.parent_ids) {
          parentEdgeCount.set(p, (parentEdgeCount.get(p) ?? 0) + 1);
        }
      }
      const childEdgeIdx = new Map<number, number>();
      const parentEdgeIdx = new Map<number, number>();
      const offsetFor = (idx: number, total: number, spacing = 4) => {
        if (total <= 1) return 0;
        return (idx - (total - 1) / 2) * spacing;
      };

      nodeMap.forEach((node) => {
        const childPos = getNodePos(node.id);
        if (!childPos) return;

        const childRightX = childPos.x + childPos.width;
        const childCenterY = childPos.y + childPos.height / 2;

        for (const parentId of node.parent_ids) {
          const parentPos = getNodePos(parentId);
          if (!parentPos) continue;

          const parentLeftX = parentPos.x;
          const childTotal = childEdgeCount.get(node.id) ?? 1;
          const childIdx = childEdgeIdx.get(node.id) ?? 0;
          childEdgeIdx.set(node.id, childIdx + 1);
          const childY = childCenterY + offsetFor(childIdx, childTotal);

          const parentTotal = parentEdgeCount.get(parentId) ?? 1;
          const parentIdx = parentEdgeIdx.get(parentId) ?? 0;
          parentEdgeIdx.set(parentId, parentIdx + 1);
          const parentY = parentPos.y + parentPos.height / 2 + offsetFor(parentIdx, parentTotal);

          // 族谱风格：child 右侧 -> 中继列 -> parent 左侧
          const midX = childRightX + Math.max(10, (parentLeftX - childRightX) / 2);
          const pathData = [
            `M ${childRightX} ${childY}`,
            `L ${midX} ${childY}`,
            `L ${midX} ${parentY}`,
            `L ${parentLeftX} ${parentY}`,
          ].join(' ');

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', pathData);
          path.setAttribute('stroke', '#94a3b8');
          path.setAttribute('stroke-width', '1.2');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-linecap', 'square');
          path.setAttribute('opacity', '0.75');
          svg.appendChild(path);
        }
      });
    };

    updateConnections();
    const ro = new ResizeObserver(updateConnections);
    ro.observe(contentRef.current);
    window.addEventListener('resize', updateConnections);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateConnections);
    };
  }, [layers, nodeMap]);

  return (
    <div className="w-full h-full bg-white flex flex-col">
      {/* 头部信息 - 紧凑 */}
      <div className="px-2 py-1.5 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <div className="flex items-baseline gap-2">
          <h3 className="text-xs font-semibold text-gray-900">数据流树</h3>
          <span className="text-[10px] text-gray-600">step #{nodeMap.get(root_id)?.global_step} | {nodes.length} nodes</span>
        </div>
      </div>

      {/* 树形显示区域 - 水平滚动，紧凑间距 */}
      <div ref={containerRef} className="flex-1 overflow-auto relative bg-gradient-to-br from-gray-50 to-white">
        {/* 内容层 - 紧凑布局 */}
        <div ref={contentRef} className="min-w-max p-2 relative" style={{ zIndex: 1 }}>
          <svg
            ref={svgRef}
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 0 }}
          />
          {/* 按层级显示 */}
          <div className="flex gap-4 relative" style={{ zIndex: 1 }}>
            {layers.map((layer, layerIndex) => (
              <div key={`layer-${layerIndex}`} className="flex flex-col gap-1.5">
                {/* 本层所有节点 - 紧凑显示 */}
                <div className="flex flex-col gap-1.5">
                  {layer.map(nodeId => {
                    const node = nodeMap.get(nodeId);
                    if (!node) return null;

                    const isRoot = nodeId === root_id;

                    return (
                      <button
                        ref={(el) => {
                          if (el) nodeRefsMap.current.set(nodeId, el);
                          else nodeRefsMap.current.delete(nodeId);
                        }}
                        key={`node-${nodeId}`}
                        onClick={() => onNodeClick?.(node.global_step)}
                        className={`
                          px-2 py-1 rounded border text-left transition-all shadow-sm hover:shadow-md
                          ${isRoot 
                            ? 'border-blue-500 bg-blue-50 shadow-md' 
                            : 'border-gray-300 bg-white hover:border-blue-400 hover:shadow-md'
                          }
                          cursor-pointer min-w-[180px] hover:z-10 relative
                        `}
                      >
                        <div className="text-[10px] text-gray-700 mt-0.5 space-y-0.5 font-mono leading-tight">
                          <div className="text-gray-700">
                            <span className="text-blue-600 font-semibold">{`#${node.global_step}`}</span>
                            {" "}
                            <span className="text-emerald-700 font-semibold">{node.opcode_name}</span>
                            {" "}
                            <span className="text-gray-500">@{node.pc.toString(16).padStart(4, '0')}</span>
                          </div>
                          {node.stack_value_post ? (
                            (() => {
                              const [v1, v2, v3] = splitValueToThreeLines(node.stack_value_post);
                              return (
                                <>
                                  <div className="text-gray-600 break-all">{v1}</div>
                                  <div className="text-gray-600 break-all">{v2}</div>
                                  <div className="text-gray-600 break-all">{v3}</div>
                                </>
                              );
                            })()
                          ) : (
                            <>
                              <div className="text-gray-400">-</div>
                              <div className="text-gray-400">-</div>
                              <div className="text-gray-400">-</div>
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DataFlowTreeComponent;
