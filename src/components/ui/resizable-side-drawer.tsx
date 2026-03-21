import { useRef, useState, useEffect, useCallback } from "react";

interface ResizableSideDrawerProps {
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  children: React.ReactNode;
  className?: string;
}

/**
 * A resizable side panel rendered INLINE — no portal.
 * The nearest positioned ancestor must have `position: relative; overflow: hidden`.
 * It spans the full height of that ancestor (top-0 → bottom-0).
 * Width is resizable by dragging the handle on the far edge.
 * State (width) is preserved between open/close (panel stays in DOM, slides off-screen).
 */
export function ResizableSideDrawer({
  open,
  onClose,
  side = "left",
  defaultWidth = 280,
  minWidth = 160,
  maxWidth = 560,
  children,
  className = "",
}: ResizableSideDrawerProps) {
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(width);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  widthRef.current = width;

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = widthRef.current;
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta =
        side === "left"
          ? e.clientX - startX.current
          : startX.current - e.clientX;
      const next = Math.max(minWidth, Math.min(maxWidth, startW.current + delta));
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [side, minWidth, maxWidth]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Slide-out transform: left panel goes to -translateX(100%), right goes to +translateX(100%)
  const translate = open ? "translate-x-0" : side === "left" ? "-translate-x-full" : "translate-x-full";

  return (
    <>
      {/* Backdrop — fades in/out; covers full relative ancestor */}
      <div
        className={[
          "absolute inset-0 z-40 transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
        onClick={onClose}
      />

      {/* Panel — stays in DOM, slides with transform so width state is preserved */}
      <div
        className={[
          "absolute top-0 bottom-0 z-50 flex flex-col bg-background",
          side === "left" ? "border-r" : "border-l",
          "border-border",
          side === "left"
            ? "shadow-[4px_0_12px_rgba(0,0,0,0.18)]"
            : "shadow-[-4px_0_12px_rgba(0,0,0,0.18)]",
          "transition-transform duration-200 ease-in-out",
          translate,
          open ? "" : "pointer-events-none",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ width, [side]: 0 }}
      >
        {/* Drag handle on the far edge */}
        <div
          className={[
            "absolute top-0 bottom-0 w-1 cursor-ew-resize hover:bg-primary/30 transition-colors z-10",
            side === "left" ? "right-0" : "left-0",
          ].join(" ")}
          onMouseDown={onDragStart}
        />
        {children}
      </div>
    </>
  );
}
