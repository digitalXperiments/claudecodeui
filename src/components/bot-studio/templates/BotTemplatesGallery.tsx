import type { JSX } from 'react';

import type { CreateMcSectionInput } from '../../mission-control/api/missionControlApi';

export interface BotTemplate {
  key: string;
  name: string;
  icon: string;
  purpose: string;
  category: 'comms' | 'engineering' | 'content' | 'ops';
  requiredMcp: string[];
  section: Partial<CreateMcSectionInput>;
  legacySeed?: boolean;
}

export interface BotTemplatesGalleryProps {
  connectedMcpServers: string[];
  onUse: (template: BotTemplate) => void;
}

/** Temporary merge-safe contract implementation; the templates worker replaces this surface. */
export default function BotTemplatesGallery(props: BotTemplatesGalleryProps): JSX.Element {
  void props;
  return <div className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-muted-foreground">Bot templates will appear here.</div>;
}
