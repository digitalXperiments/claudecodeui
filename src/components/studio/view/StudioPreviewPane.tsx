import { useEffect, useRef } from 'react';

import { injectSelectBridge, parseSelectMessage, selectModeMessage, STUDIO_FRAME_WIDTHS } from '../preview/selectBridge';
import type { StudioPreviewFrame, StudioSelectedElement } from '../types';

type StudioPreviewPaneProps = {
  title: string;
  html: string;
  frame: StudioPreviewFrame;
  selectMode: boolean;
  onSelectElement: (element: StudioSelectedElement) => void;
};

export default function StudioPreviewPane({
  title,
  html,
  frame,
  selectMode,
  onSelectElement,
}: StudioPreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = injectSelectBridge(html);
  const width = STUDIO_FRAME_WIDTHS[frame];

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const element = parseSelectMessage(event.data);
      if (element) onSelectElement(element);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelectElement]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(selectModeMessage(selectMode), '*');
  }, [selectMode, srcDoc]);

  return (
    <div
      data-studio-pane="preview"
      data-frame={frame}
      className={`mx-auto h-full min-h-0 overflow-hidden rounded-xl border border-border bg-white shadow-sm ${
        frame === 'mobile' ? 'rounded-[28px]' : ''
      }`}
      style={{ width: width ? `${width}px` : '100%', maxWidth: '100%' }}
    >
      <iframe
        ref={iframeRef}
        title={title}
        sandbox="allow-scripts allow-forms allow-modals"
        className="h-full w-full border-0"
        srcDoc={srcDoc}
        onLoad={() => {
          iframeRef.current?.contentWindow?.postMessage(selectModeMessage(selectMode), '*');
        }}
      />
    </div>
  );
}
