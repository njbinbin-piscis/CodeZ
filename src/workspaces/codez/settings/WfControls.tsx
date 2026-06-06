import { useCallback } from "react";
import { useReactFlow, useStore } from "reactflow";
import { useTranslation } from "react-i18next";

/** Zoom / fit controls with i18n tooltips (replaces React Flow's English-only Controls). */
export default function WfControls() {
  const { t } = useTranslation();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const minZoomReached = useStore((s) => s.transform[2] <= s.minZoom);
  const maxZoomReached = useStore((s) => s.transform[2] >= s.maxZoom);

  const onFit = useCallback(() => {
    void fitView({ padding: 0.2, duration: 200 });
  }, [fitView]);

  return (
    <div className="wf-controls">
      <button type="button" title={t("workflow.controls.zoomIn")} disabled={maxZoomReached} onClick={() => zoomIn({ duration: 150 })}>
        +
      </button>
      <button type="button" title={t("workflow.controls.zoomOut")} disabled={minZoomReached} onClick={() => zoomOut({ duration: 150 })}>
        −
      </button>
      <button type="button" title={t("workflow.controls.fitView")} onClick={onFit}>
        ⊡
      </button>
    </div>
  );
}
