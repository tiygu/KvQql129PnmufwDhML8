import { useEffect, useCallback, useState, useRef } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const WHEEL_STEP = 0.0015;

export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Reset scale when image changes
  useEffect(() => { setScale(1); setNaturalSize(null); }, [src]);

  const handleKey = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    setScale((prev) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev - event.deltaY * WHEEL_STEP)));
  }, []);

  const zoomIn = () => setScale((prev) => Math.min(MAX_SCALE, prev * 1.4));
  const zoomOut = () => setScale((prev) => Math.max(MIN_SCALE, prev / 1.4));
  const resetZoom = () => setScale(1);

  const isDefault = scale === 1;
  const imgStyle: React.CSSProperties = isDefault
    ? {}
    : {
        maxWidth: "none",
        maxHeight: "none",
        width: (naturalSize?.w ?? 100) * scale,
        height: (naturalSize?.h ?? 100) * scale,
      };

  return (
    <div className="lightbox-backdrop" onMouseDown={onClose}>
      <div
        className="lightbox-panel"
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
        onWheel={handleWheel}
      >
        <div className="lightbox-toolbar">
          <button onClick={zoomOut} disabled={scale <= MIN_SCALE} aria-label="缩小"><Minus size={16} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button onClick={zoomIn} disabled={scale >= MAX_SCALE} aria-label="放大"><Plus size={16} /></button>
          <button onClick={resetZoom} disabled={isDefault} aria-label="重置"><RotateCcw size={16} /></button>
          <button onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        <img
          src={src}
          alt={alt ?? ""}
          style={imgStyle}
          onLoad={(event) => {
            const img = event.currentTarget;
            setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
      </div>
    </div>
  );
}
