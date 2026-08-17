import React, { useEffect, useRef, useState } from 'react';

import { useDeviceSettings } from '../../../../hooks/useDeviceSettings';
import { useProviderUsage } from '../../hooks/useProviderUsage';
import {
  PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT,
  PROVIDER_USAGE_DISABLED_PROVIDERS_KEY,
  PROVIDER_USAGE_LEGEND_COLLAPSED_KEY,
  PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT,
  isProviderUsageVisible,
} from '../../../../utils/providerUsagePreferences';

import {
  createProviderUsageLegendUi,
  ProviderUsageLegendContent,
  type ProviderUsageLegendUi,
} from './ProviderUsageLegendContent';

export { ProviderUsageLegendContent } from './ProviderUsageLegendContent';
export type { ProviderUsageLegendContentProps } from './ProviderUsageLegendContent';

export default function ProviderUsageLegend() {
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const uiRef = useRef<ProviderUsageLegendUi | null>(null);
  if (uiRef.current === null) {
    uiRef.current = createProviderUsageLegendUi();
  }
  const ui = uiRef.current;
  const [view, setView] = useState(ui.getState);
  const [now, setNow] = useState(() => Date.now());
  const [, setVisibilityRevision] = useState(0);
  const usage = useProviderUsage();

  useEffect(() => ui.subscribe(setView), [ui]);

  useEffect(() => {
    const syncCollapsed = () => {
      ui.syncCollapsedFromStorage();
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === PROVIDER_USAGE_LEGEND_COLLAPSED_KEY) syncCollapsed();
    };
    window.addEventListener(PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT, syncCollapsed);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT, syncCollapsed);
      window.removeEventListener('storage', syncStorage);
    };
  }, [ui]);

  useEffect(() => {
    const syncVisibility = () => setVisibilityRevision((revision) => revision + 1);
    const syncStorage = (event: StorageEvent) => {
      if (event.key === PROVIDER_USAGE_DISABLED_PROVIDERS_KEY) syncVisibility();
    };
    window.addEventListener(PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT, syncVisibility);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT, syncVisibility);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // The floating card / launcher overlaps the composer on phones; mobile is
  // emergency-use only, so the widget is hidden there entirely.
  if (isMobile) {
    return null;
  }

  return (
    <ProviderUsageLegendContent
      data={usage.data ? {
        ...usage.data,
        providers: usage.data.providers.filter(({ providerId }) => isProviderUsageVisible(providerId)),
      } : null}
      error={usage.error}
      refreshNotice={usage.refreshNotice}
      refreshing={usage.refreshing}
      collapsed={view.collapsed}
      expandedProvider={view.expandedProvider}
      now={now}
      onRefresh={() => void usage.refresh()}
      onToggleCollapsed={ui.toggleCollapsed}
      onToggleProvider={ui.toggleProvider}
    />
  );
}
