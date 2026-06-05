import { useEffect, useRef } from "react";
import { extensionService } from "../extensionService";
import type { WebviewState } from "../extensionUiStore";

/**
 * Hosts an extension webview's HTML inside a sandboxed iframe. Messages flow:
 *   extension -> $postMessage -> "codez-webview-post" event -> iframe
 *   iframe -> postMessage -> here -> extensionService.postWebviewMessage
 */
export default function WebviewHost({ webview }: { webview: WebviewState }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onPost = (e: Event) => {
      const detail = (e as CustomEvent).detail as { handle: string; message: unknown };
      if (detail.handle !== webview.handle) return;
      iframeRef.current?.contentWindow?.postMessage(detail.message, "*");
    };
    window.addEventListener("codez-webview-post", onPost);

    const onMessage = (e: MessageEvent) => {
      if (e.source === iframeRef.current?.contentWindow) {
        extensionService.postWebviewMessage(webview.handle, e.data);
      }
    };
    window.addEventListener("message", onMessage);

    return () => {
      window.removeEventListener("codez-webview-post", onPost);
      window.removeEventListener("message", onMessage);
    };
  }, [webview.handle]);

  // Inject the acquireVsCodeApi() shim the webview script expects.
  const shim = `<script>
    (function(){
      const vscode = {
        postMessage: (m) => parent.postMessage(m, '*'),
        getState: () => { try { return JSON.parse(localStorage.getItem('vscode-state')||'null'); } catch { return null; } },
        setState: (s) => { try { localStorage.setItem('vscode-state', JSON.stringify(s)); } catch {} return s; },
      };
      window.acquireVsCodeApi = () => vscode;
    })();
  </script>`;
  const srcDoc = shim + webview.html;

  return (
    <iframe
      ref={iframeRef}
      className="codez-webview-frame"
      title={webview.title}
      sandbox="allow-scripts allow-forms allow-same-origin"
      srcDoc={srcDoc}
    />
  );
}
