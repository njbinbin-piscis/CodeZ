import { useEffect, useRef } from "react";
import "./ImagePreview.css";

interface ImagePreviewProps {
  src: string;
  name: string;
  size?: number;
}

export default function ImagePreview({ src, name, size }: ImagePreviewProps) {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    imgRef.current?.focus();
  }, [src]);

  return (
    <div className="codez-image-preview" tabIndex={0}>
      <div className="codez-image-preview-meta">
        <span>{name}</span>
        {size != null && size > 0 && (
          <span className="codez-image-preview-size">
            {(size / 1024).toFixed(size > 1024 * 1024 ? 1 : 0)}
            {size > 1024 * 1024 ? " MB" : " KB"}
          </span>
        )}
      </div>
      <div className="codez-image-preview-frame">
        <img ref={imgRef} src={src} alt={name} draggable={false} />
      </div>
    </div>
  );
}
