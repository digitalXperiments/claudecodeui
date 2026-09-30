import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import BotRoster from './BotRoster';
import RuntimeDisabledCard from './runtime/RuntimeDisabledCard';

const render = (runtimeV2?: boolean) => renderToStaticMarkup(<BotRoster bots={[]} selectedBotId={null} search="" onSelect={() => undefined} runtimeV2={runtimeV2} />);

test('roster shows only the classic sections while the runtime flag is off', () => {
  const html = render();
  for (const label of ['Overview', 'Inbox', 'Board', 'Activity']) assert.match(html, new RegExp(`>${label}<`));
  for (const label of ['Brief', 'Channels', 'Teams']) assert.doesNotMatch(html, new RegExp(`>${label}<`));
  assert.equal(render(false), html);
});

test('roster adds Brief, Channels and Teams when the runtime flag is on', () => {
  const html = render(true);
  for (const label of ['Overview', 'Inbox', 'Board', 'Activity', 'Brief', 'Channels', 'Teams']) assert.match(html, new RegExp(`>${label}<`));
});

test('the disabled card names the page and points at Settings → Appearance', () => {
  const html = renderToStaticMarkup(<RuntimeDisabledCard pageLabel="Brief" />);
  assert.match(html, /Brief needs Bot runtime v2/);
  assert.match(html, /Enable Bot runtime v2 in Settings → Appearance/);
});

test('runtime pages render their loading state without crashing', async () => {
  const [{ default: BriefView }, { default: ChannelsView }, { default: TeamsView }] = await Promise.all([
    import('./runtime/BriefView'),
    import('./runtime/ChannelsView'),
    import('./runtime/TeamsView'),
  ]);
  assert.match(renderToStaticMarkup(<BriefView bots={[]} onNavigate={() => undefined} />), /Brief/);
  assert.match(renderToStaticMarkup(<ChannelsView bots={[]} />), /Always on/);
  assert.match(renderToStaticMarkup(<TeamsView bots={[]} onNavigate={() => undefined} />), /Teams/);
});
