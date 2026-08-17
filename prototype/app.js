const icons = {
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  layers: 'M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 17l9 5 9-5',
  activity: 'M3 12h4l2-7 4 14 2-7h6',
  git: 'M6 3a3 3 0 1 0 0 6h1v6.1a3 3 0 1 0 2 0V9h6v3a3 3 0 1 0 2 0V8a2 2 0 0 0-2-2H9V6a3 3 0 0 0-3-3Z',
  review: 'm5 12 4 4L19 6M4 20h16',
  swarm: 'M12 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM4 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm16 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 11v4M7 12l3 3m4 0 3-3',
  board: 'M4 4h5v16H4zM11 4h5v10h-5zM18 4h2v7h-2z',
  folder: 'M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M3 12h2m14 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4',
  search: 'm20 20-4.5-4.5M10.8 18a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4Z',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  chevron: 'm9 18 6-6-6-6',
  sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  terminal: 'm5 7 4 5-4 5m7 0h7',
  file: 'M6 3h8l4 4v14H6zM14 3v5h5',
  bolt: 'm13 2-9 12h7l-1 8 9-12h-7l1-8Z',
  alert: 'M12 9v4m0 4h.01M10.3 3.8 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z',
  spark: 'm12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
};

function icon(name, size = 16) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.spark}" /></svg>`;
}

const workspaces = [
  { id: 'ws-landing', name: 'Landing page refresh', project: 'CloudCLI Web', provider: 'Claude', providerKey: 'claude', status: 'running', statusLabel: 'Running', branch: 'feat/landing-page-refresh', task: 'Redesign the public landing page with a calm command-center feel.', progress: 68, changes: '+428 −96', event: 'Implementing responsive hero', time: '2m ago', color: 'purple' },
  { id: 'ws-auth', name: 'OAuth recovery flow', project: 'CloudCLI Core', provider: 'Codex', providerKey: 'codex', status: 'review', statusLabel: 'Needs review', branch: 'fix/oauth-session-recovery', task: 'Recover interrupted provider auth without losing the active session.', progress: 100, changes: '+186 −42', event: 'Review requested', time: '14m ago', color: 'cyan' },
  { id: 'ws-usage', name: 'Provider usage legend', project: 'CloudCLI Core', provider: 'Cursor', providerKey: 'cursor', status: 'running', statusLabel: 'Running', branch: 'feat/provider-usage-legend', task: 'Add transparent spend and token usage to every active session.', progress: 42, changes: '+231 −18', event: 'Running component tests', time: '21m ago', color: 'blue' },
  { id: 'ws-studio', name: 'Studio prototype', project: 'CloudCLI Studio', provider: 'Grok', providerKey: 'grok', status: 'done', statusLabel: 'Ready to ship', branch: 'feat/studio-prototypes', task: 'Prototype a visual ideation flow for product concepts.', progress: 100, changes: '+712 −120', event: 'CI passed', time: '1h ago', color: 'yellow' },
  { id: 'ws-mcp', name: 'MCP catalog isolation', project: 'CloudCLI Core', provider: 'Kimi', providerKey: 'kimi', status: 'review', statusLabel: 'Needs review', branch: 'fix/mcp-provider-isolation', task: 'Keep catalog definitions separate from provider-native config fanout.', progress: 91, changes: '+304 −77', event: '2 comments unresolved', time: '2h ago', color: 'green' },
  { id: 'ws-docs', name: 'Onboarding polish', project: 'CloudCLI Web', provider: 'OpenCode', providerKey: 'opencode', status: 'done', statusLabel: 'Archived', branch: 'chore/onboarding-polish', task: 'Clarify first-run setup and provider connection steps.', progress: 100, changes: '+154 −38', event: 'Merged yesterday', time: 'yesterday', color: 'blue' },
];

const activities = [
  { icon: 'bolt', title: 'Claude completed a tool cycle', detail: 'Landing page refresh · edited src/components/Hero.tsx', time: '2m ago', tone: 'blue' },
  { icon: 'review', title: 'Review requested', detail: 'OAuth recovery flow · 3 files changed', time: '14m ago', tone: 'yellow' },
  { icon: 'check', title: 'Checks passed', detail: 'Studio prototype · 42 tests · 1m 18s', time: '1h ago', tone: 'green' },
  { icon: 'alert', title: 'Permission needed', detail: 'MCP catalog isolation · access to gh pr view', time: '2h ago', tone: 'red' },
  { icon: 'git', title: 'Workspace archived', detail: 'Onboarding polish · merged to main', time: 'yesterday', tone: 'purple' },
];

const needs = [
  { id: 'n1', kind: 'Permission', title: 'Allow GitHub CLI access', detail: 'MCP catalog isolation wants to inspect the pull request checks.', action: 'Review permission', tone: 'yellow' },
  { id: 'n2', kind: 'Review', title: 'Review OAuth recovery flow', detail: 'Codex has prepared 6 commits and is waiting for your diff review.', action: 'Open review', tone: 'blue' },
  { id: 'n3', kind: 'Configuration', title: 'Reconnect Kimi provider', detail: 'The provider token expired while the usage legend workspace was running.', action: 'Open settings', tone: 'red' },
];

const tasks = [
  { id: 't1', col: 'backlog', priority: 'P1', title: 'Workspace-first navigation', detail: 'Make the workspace the primary unit of work.', assignee: 'RM', provider: 'Claude', color: 'purple' },
  { id: 't2', col: 'progress', priority: 'P0', title: 'Unified activity timeline', detail: 'Join sessions, runs, checks, and interrupts.', assignee: 'CO', provider: 'Codex', color: 'green' },
  { id: 't3', col: 'progress', priority: 'P1', title: 'Inline diff comments', detail: 'Send review feedback directly back to the agent.', assignee: 'CL', provider: 'Cursor', color: 'blue' },
  { id: 't4', col: 'review', priority: 'P0', title: 'Ship pipeline states', detail: 'Test → PR → CI → merge → archive.', assignee: 'GR', provider: 'Grok', color: 'yellow' },
  { id: 't5', col: 'done', priority: 'P1', title: 'Needs you action center', detail: 'Separate human decisions from operational telemetry.', assignee: 'RM', provider: 'Claude', color: 'purple' },
  { id: 't6', col: 'done', priority: 'P2', title: 'Usage and cost surfaces', detail: 'Show spend context without breaking flow.', assignee: 'KI', provider: 'Kimi', color: 'cyan' },
];

const projects = [
  { name: 'CloudCLI Web', path: '~/Development/cloudcli-fork', description: 'The primary React/Vite application and responsive command center.', active: 3, branch: 'main', color: 'purple' },
  { name: 'CloudCLI Core', path: '~/Development/cloudcli-core', description: 'Node server modules, provider adapters, run ledger, and workspace lifecycle.', active: 4, branch: 'main', color: 'cyan' },
  { name: 'CloudCLI Studio', path: '~/Development/cloudcli-studio', description: 'Prototype and design exploration surface for new product experiences.', active: 1, branch: 'main', color: 'yellow' },
];

const state = {
  screen: 'dashboard',
  workspaceId: 'ws-landing',
  workspaceTab: 'overview',
  mobileOpen: false,
  modal: null,
  theme: 'dark',
  filter: 'all',
  toggles: { notifications: true, autoArchive: false, reducedMotion: false },
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const workspace = () => workspaces.find((item) => item.id === state.workspaceId) || workspaces[0];

function providerBadge(item) {
  return `<span class="provider-logo ${item.providerKey || item.provider?.toLowerCase() || 'claude'}">${escapeHtml((item.provider || 'CL').slice(0, 2).toUpperCase())}</span>`;
}

function statusTag(item) {
  const tone = item.status === 'running' ? 'blue' : item.status === 'review' ? 'yellow' : 'green';
  return `<span class="tag ${tone}"><span class="status-dot ${item.status}"></span>${escapeHtml(item.statusLabel || item.status)}</span>`;
}

function navItem(id, label, iconName, shortcut = '', badge = '') {
  const active = state.screen === id || (id === 'workspaces' && state.screen === 'workspace') ? 'active' : '';
  return `<button class="nav-item ${active}" data-screen="${id}">${icon(iconName)}<span class="nav-text">${label}</span>${badge ? `<span class="count-badge">${badge}</span>` : ''}${shortcut ? `<span class="shortcut">${shortcut}</span>` : ''}</button>`;
}

function renderSidebar() {
  return `<aside class="sidebar ${state.mobileOpen ? 'open' : ''}">
    <div class="brand"><span class="brand-mark">C</span><span class="brand-name">CloudCLI</span><span class="brand-badge">prototype</span></div>
    <button class="workspace-switcher" data-screen="workspace">
      <span class="project-dot"></span><span><strong>${escapeHtml(workspace().name)}</strong><small>${escapeHtml(workspace().project)} · ${escapeHtml(workspace().branch)}</small></span>${icon('chevron', 14)}
    </button>
    <div class="section-label">Command center</div>
    <nav class="nav-list">
      ${navItem('dashboard', 'Overview', 'grid', '⌘1')}
      ${navItem('workspaces', 'Workspaces', 'layers', '⌘2', workspaces.filter((item) => item.status === 'running').length)}
      ${navItem('activity', 'Activity', 'activity', '⌘3')}
      ${navItem('review', 'Review queue', 'review', '', '2')}
    </nav>
    <div class="section-label">Operate</div>
    <nav class="nav-list">
      ${navItem('swarm', 'Agent Swarm', 'swarm')}
      ${navItem('kanban', 'Kanban', 'board')}
      ${navItem('projects', 'Projects', 'folder')}
      ${navItem('studio', 'Studio', 'spark')}
    </nav>
    <div class="section-label">Active work</div>
    <div class="mini-workspaces">${workspaces.slice(0, 4).map((item) => `<button class="mini-workspace" data-workspace="${item.id}"><span class="status-dot ${item.status}"></span><span class="mini-title">${escapeHtml(item.name)}</span><small>${item.progress}%</small></button>`).join('')}</div>
    <div class="sidebar-spacer"></div>
    <div class="sidebar-footer">
      ${navItem('needs', 'Needs you', 'alert', '', '3')}
      ${navItem('onboarding', 'Setup checklist', 'check')}
      ${navItem('settings', 'Settings', 'settings')}
      <div class="profile"><span class="avatar">RM</span><span><strong>Ram Manohar</strong><small>Local workspace</small></span>${icon('dots', 16)}</div>
    </div>
  </aside>`;
}

function renderTopbar() {
  const title = state.screen === 'workspace' ? workspace().name : ({ dashboard: 'Command Center', workspaces: 'Workspaces', activity: 'Activity', review: 'Review queue', swarm: 'Agent Swarm', kanban: 'Kanban', projects: 'Projects', needs: 'Needs you', studio: 'Studio', settings: 'Settings', onboarding: 'Setup checklist' }[state.screen] || 'CloudCLI');
  return `<header class="topbar"><button class="icon-button mobile-menu" data-action="mobile-menu" aria-label="Open menu">${icon('menu')}</button><div class="crumbs"><span>CloudCLI</span><span class="crumb-separator">/</span><strong>${escapeHtml(title)}</strong></div><label class="top-search">${icon('search', 15)}<input id="global-search" placeholder="Search workspaces, runs, files…" /><kbd>⌘ K</kbd></label><div class="top-actions"><button class="ghost-button" data-action="command">${icon('spark', 14)} Command</button><button class="icon-button" data-action="toggle-theme" title="Toggle theme">${icon(state.theme === 'dark' ? 'sun' : 'moon')}</button><button class="icon-button" data-screen="needs" title="Needs you">${icon('alert')}</button><button class="avatar" data-screen="settings" title="Profile">RM</button></div></header>`;
}

function pageHeading(eyebrow, title, description, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="subheading">${description}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
}

function workspaceCard(item) {
  return `<article class="card workspace-card"><div class="workspace-title">${providerBadge(item)}<div><h3>${escapeHtml(item.name)}</h3><div class="branch">${escapeHtml(item.project)} · ${escapeHtml(item.branch)}</div></div>${statusTag(item)}</div><p class="subheading">${escapeHtml(item.task)}</p><div class="workspace-meta"><span class="tag">${escapeHtml(item.event)}</span><span class="tag">${escapeHtml(item.changes)} lines</span></div><div class="progress" style="margin-top:15px"><span style="width:${item.progress}%"></span></div><div class="workspace-footer"><span class="meta">${escapeHtml(item.time)} · ${item.progress}% complete</span><button class="ghost-button" data-workspace="${item.id}">Open ${icon('arrow', 13)}</button></div></article>`;
}

function activityList(items = activities) {
  return `<div class="activity-list">${items.map((item) => `<div class="activity-item"><span class="activity-icon">${icon(item.icon, 14)}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div><time class="activity-time">${escapeHtml(item.time)}</time></div>`).join('')}</div>`;
}

function renderDashboard() {
  return `${pageHeading('Monday · August 17, 2026', 'Good morning, Ram', 'Your agents are moving across 6 workspaces. Two decisions are waiting for you.', `<button class="ghost-button" data-screen="activity">${icon('activity', 14)} View activity</button><button class="primary-button" data-action="new-workspace">${icon('plus', 15)} New workspace</button>`)}
    <div class="grid grid-4" style="margin-bottom:22px"><div class="card stat-card"><span class="stat-label">Active workspaces</span><div class="stat-value">3</div><span class="stat-trend">↑ 2 since yesterday</span></div><div class="card stat-card"><span class="stat-label">Awaiting your review</span><div class="stat-value">2</div><span class="stat-trend warning">Needs attention</span></div><div class="card stat-card"><span class="stat-label">Agent spend today</span><div class="stat-value">$4.82</div><span class="stat-trend">↓ 18% vs. average</span></div><div class="card stat-card"><span class="stat-label">Merged this week</span><div class="stat-value">8</div><span class="stat-trend">↑ 3 from last week</span></div></div>
    <div class="split" style="margin-bottom:14px"><section class="card"><div class="card-header"><div><h2>Active workspaces</h2><span class="muted">Independent streams of work</span></div><button class="ghost-button" data-screen="workspaces">View all ${icon('arrow', 13)}</button></div><div class="grid grid-2" style="padding:14px">${workspaces.filter((item) => item.status !== 'done').slice(0, 4).map(workspaceCard).join('')}</div></section><section class="card"><div class="card-header"><div><h2>Needs you</h2><span class="muted">Only decisions and fixes</span></div><button class="tag red" data-screen="needs">3 open</button></div><div>${needs.slice(0, 3).map((item) => `<div class="needs-item"><span class="needs-icon">${icon(item.tone === 'red' ? 'alert' : item.tone === 'blue' ? 'review' : 'settings', 14)}</span><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p></div></div>`).join('')}</div></section></div>
    <div class="split"><section class="card"><div class="card-header"><div><h2>Ship progress</h2><span class="muted">The work closest to production</span></div><button class="ghost-button" data-screen="review">Review queue</button></div><div class="pipeline"><div class="pipeline-step done"><span class="pipeline-dot">${icon('check', 13)}</span>Diff</div><div class="pipeline-step done"><span class="pipeline-dot">${icon('check', 13)}</span>Tests</div><div class="pipeline-step active"><span class="pipeline-dot">3</span>Review</div><div class="pipeline-step"><span class="pipeline-dot">4</span>PR</div><div class="pipeline-step"><span class="pipeline-dot">5</span>Merge</div></div><div class="card-header" style="border-top:1px solid var(--line);border-bottom:0"><div><strong>OAuth recovery flow</strong><div class="muted">Codex · fix/oauth-session-recovery</div></div><span class="tag yellow">3 comments</span></div></section><section class="card"><div class="card-header"><div><h2>Latest activity</h2><span class="muted">Across all projects</span></div><button class="icon-button" data-screen="activity">${icon('arrow')}</button></div>${activityList()}</section></div>`;
}

function renderWorkspaces() {
  const filtered = state.filter === 'all' ? workspaces : workspaces.filter((item) => item.status === state.filter);
  return `${pageHeading('Command center', 'Workspaces', 'One isolated workspace per shippable stream. Each has its own branch, files, agent, terminal, diff, and review path.', `<button class="ghost-button" data-action="import-workspace">${icon('git', 14)} Import branch</button><button class="primary-button" data-action="new-workspace">${icon('plus', 15)} New workspace</button>`)}<div class="toolbar"><div class="filter-row">${['all', 'running', 'review', 'done'].map((filter) => `<button class="filter ${state.filter === filter ? 'active' : ''}" data-filter="${filter}">${filter === 'all' ? 'All workspaces' : filter === 'review' ? 'Needs review' : filter === 'done' ? 'Ready / archived' : 'Running'}${filter === 'all' ? ' · 6' : ''}</button>`).join('')}</div><span class="meta">Showing ${filtered.length} workspaces</span></div><div class="grid grid-2">${filtered.length ? filtered.map(workspaceCard).join('') : '<div class="card empty"><strong>No workspaces here</strong>Try another filter or create a new workspace.</div>'}</div>`;
}

function renderActivity() {
  const rows = workspaces.map((item, index) => ({ ...item, run: ['run_01JZ4', 'run_01JZ5', 'run_01JZ6', 'run_01JZ7', 'run_01JZ8', 'run_01JZ9'][index], duration: ['12m 42s', '8m 11s', '4m 39s', '1h 04m', '23m 18s', '16m 52s'][index], cost: ['$1.42', '$0.88', '$0.64', '$0.31', '$1.07', '$0.50'][index] }));
  const visible = state.filter === 'all' ? rows : rows.filter((item) => item.status === state.filter);
  return `${pageHeading('Observatory', 'Activity', 'A durable timeline for chat, Kanban, webhooks, automation, swarm, and shipping runs.', `<button class="ghost-button" data-action="export-activity">${icon('file', 14)} Export</button><button class="icon-button" data-action="refresh">${icon('activity')}</button>`)}<div class="card"><div class="card-header"><div class="filter-row">${['all','running','review','done'].map((filter) => `<button class="filter ${state.filter === filter ? 'active' : ''}" data-filter="${filter}">${filter === 'all' ? 'All' : filter === 'review' ? 'Waiting' : filter === 'done' ? 'Completed' : 'Running'}</button>`).join('')}</div><label class="top-search" style="margin:0;max-width:250px"><span>${icon('search',14)}</span><input placeholder="Search runs…" /></label></div><div class="table-wrap"><table class="table"><thead><tr><th>Run</th><th>Workspace</th><th>Status</th><th>Duration</th><th>Spend</th><th>Last event</th></tr></thead><tbody>${visible.map((item) => `<tr class="clickable" data-workspace="${item.id}"><td><span class="mono">${item.run}</span></td><td><strong>${escapeHtml(item.name)}</strong><br><span class="subtle">${escapeHtml(item.provider)} · ${escapeHtml(item.project)}</span></td><td>${statusTag(item)}</td><td>${item.duration}</td><td>${item.cost}</td><td>${escapeHtml(item.event)}<br><span class="subtle">${escapeHtml(item.time)}</span></td></tr>`).join('')}</tbody></table></div></div>`;
}

function renderWorkspace() {
  const item = workspace();
  const tabs = [['overview','Overview'], ['chat','Chat'], ['diff','Diff'], ['checks','Checks'], ['terminal','Terminal'], ['files','Files']];
  return `<div class="card workspace-header"><div class="workspace-heading">${providerBadge(item)}<div><div class="eyebrow">${escapeHtml(item.project)} · Workspace</div><h1>${escapeHtml(item.name)}</h1><div class="branch">${escapeHtml(item.branch)} · ${escapeHtml(item.changes)} · created today at 09:42</div></div></div><div class="workspace-actions">${statusTag(item)}<button class="ghost-button" data-action="open-github">${icon('git', 14)} Branch</button><button class="primary-button" data-action="run-tests">${icon('bolt', 14)} Run checks</button><button class="icon-button" data-action="workspace-menu">${icon('dots')}</button></div></div><div class="tabbar">${tabs.map(([id,label]) => `<button class="tab ${state.workspaceTab === id ? 'active' : ''}" data-workspace-tab="${id}">${label}${id === 'checks' ? ' · 4' : id === 'diff' ? ' · 8' : ''}</button>`).join('')}</div>${renderWorkspaceTab(item)}`;
}

function renderWorkspaceTab(item) {
  if (state.workspaceTab === 'chat') return `<div class="split-wide"><section class="card chat-box"><div class="card-header"><div><h2>Agent chat</h2><span class="muted">${escapeHtml(item.provider)} · context synced 2m ago</span></div><span class="tag blue">Live</span></div><div class="chat-messages"><div class="message user"><span class="avatar">RM</span><div class="message-bubble"><strong>You · 09:48</strong>Keep the hero focused on the workspace lifecycle. Show the ship path without turning it into a dashboard full of metrics.</div></div><div class="message"><span class="provider-logo ${item.providerKey}">${item.provider.slice(0,2).toUpperCase()}</span><div class="message-bubble"><strong>${escapeHtml(item.provider)} · working</strong>I’ll reduce the hero copy, keep the status rail visible, and add a single “Review changes” action. I’m checking the mobile breakpoint now.</div></div><div class="message"><span class="provider-logo ${item.providerKey}">${item.provider.slice(0,2).toUpperCase()}</span><div class="message-bubble"><strong>${escapeHtml(item.provider)} · tool</strong>Ran <span class="mono">npm run test:client</span><br><span class="tag green" style="margin-top:8px">42 passed · 1.2s</span></div></div></div><div class="composer"><textarea placeholder="Message ${escapeHtml(item.provider)}…"></textarea><button class="primary-button" data-action="send-message">Send ${icon('arrow', 13)}</button></div></section>${workspaceContext(item)}</div>`;
  if (state.workspaceTab === 'diff') return `<div class="split-wide"><section class="card"><div class="card-header"><div><h2>Review diff</h2><span class="muted">8 files · +428 −96 · against main</span></div><div class="row"><button class="ghost-button" data-action="request-changes">Request changes</button><button class="primary-button" data-action="approve">Approve</button></div></div><div class="code-diff"><span class="diff-line"><span class="line-no"> 1</span>import { WorkspaceHero } from './WorkspaceHero';</span><span class="diff-line"><span class="line-no"> 2</span>import { ShipStatus } from './ShipStatus';</span><span class="diff-line remove"><span class="line-no"> 3−</span>const title = 'Build with AI';</span><span class="diff-line add"><span class="line-no"> 3+</span>const title = 'Move every idea to shipped';</span><span class="diff-line add"><span class="line-no"> 4+</span>const subtitle = 'One workspace for every stream of agent work.';</span><span class="diff-line"><span class="line-no"> 5</span></span><span class="diff-line add"><span class="line-no"> 6+</span>&lt;ShipStatus branch={branch} stage={stage} /&gt;</span><span class="diff-line"><span class="line-no"> 7</span></span><span class="diff-line add"><span class="line-no"> 8+</span>&lt;WorkspaceActions onReview={openReview} /&gt;</span></div><div class="comment"><strong>Review note · Ram</strong><br>Can we keep this action row sticky on smaller screens? The review path is the most important decision point.</div></section><div class="stack"><div class="card"><div class="card-header"><h3>Changed files</h3><span class="meta">8</span></div><div class="file-list">${['WorkspaceHero.tsx','ShipStatus.tsx','WorkspaceActions.tsx','workspace.css','app-state.ts','hero.test.tsx','ship-flow.test.tsx','README.md'].map((file,index) => `<button class="file-row ${index === 0 ? 'active' : ''}">${icon('file',14)} ${file}<span style="margin-left:auto;color:${index === 5 ? 'var(--green)' : 'var(--muted)'}">${index % 2 ? '+' : 'M'}</span></button>`).join('')}</div></div>${workspaceContext(item, true)}</div></div>`;
  if (state.workspaceTab === 'checks') return `<div class="split"><section class="card"><div class="card-header"><div><h2>Checks</h2><span class="muted">Last run 2 minutes ago</span></div><button class="primary-button" data-action="run-tests">${icon('refresh', 14)} Run again</button></div><div class="check-list"><div class="check-row"><span class="check-icon">${icon('check')}</span><strong>Typecheck</strong><small>passed · 8.4s</small></div><div class="check-row"><span class="check-icon">${icon('check')}</span><strong>Client tests</strong><small>42 passed · 1.2s</small></div><div class="check-row"><span class="check-icon">${icon('check')}</span><strong>Server tests</strong><small>780 passed · 44.7s</small></div><div class="check-row fail"><span class="check-icon">${icon('alert')}</span><strong>Lint boundary rules</strong><small>8 errors · needs fix</small></div></div><div class="card-pad"><div class="row-between"><span class="meta">Overall verdict</span><span class="tag yellow">Needs changes</span></div><p class="subheading">The code is test-clean. One lint boundary rule prevents merge and should be fixed by the agent.</p><button class="ghost-button" style="margin-top:14px" data-action="open-fix">${icon('bolt',14)} Open fix run</button></div></section>${workspaceContext(item)}</div>`;
  if (state.workspaceTab === 'terminal') return `<div class="card"><div class="card-header"><div><h2>Terminal</h2><span class="muted">${escapeHtml(item.branch)} · isolated process</span></div><div class="row"><span class="tag green">Process running</span><button class="icon-button" data-action="clear-terminal">${icon('close')}</button></div></div><div class="code-diff" style="min-height:420px;color:#9fe6bb"><span class="diff-line" style="color:#9fe6bb">$ npm run test:client</span><span class="diff-line">&nbsp;</span><span class="diff-line">> cloudcli@1.36.3 test:client</span><span class="diff-line">> vitest run</span><span class="diff-line">&nbsp;</span><span class="diff-line"> RUN  v3.2.4 /workspace/cloudcli</span><span class="diff-line"> ✓ src/components/workspaces/WorkspaceHero.test.tsx (6 tests)</span><span class="diff-line"> ✓ src/components/workspaces/ShipFlow.test.tsx (8 tests)</span><span class="diff-line"> ✓ src/components/chat/ChatComposer.test.tsx (28 tests)</span><span class="diff-line">&nbsp;</span><span class="diff-line" style="color:#70a7ff">Test Files  3 passed (3)</span><span class="diff-line" style="color:#70a7ff">Tests       42 passed (42)</span><span class="diff-line">&nbsp;</span><span class="diff-line" style="color:#f0c76c">$ _</span></div></div>`;
  if (state.workspaceTab === 'files') return `<div class="split-wide"><section class="card"><div class="card-header"><div><h2>Workspace files</h2><span class="muted">Live tree · 1,248 files</span></div><button class="ghost-button" data-action="refresh">${icon('refresh',14)} Refresh</button></div><div class="file-list">${['src','server','public','package.json','README.md','.env.example'].map((file,index) => `<button class="file-row ${index === 0 ? 'active' : ''}">${icon(index < 3 ? 'folder' : 'file',14)} ${file}<span style="margin-left:auto;color:var(--subtle)">${index < 3 ? '›' : '—'}</span></button>`).join('')}</div></section><section class="card"><div class="card-header"><h3>src/components/WorkspaceHero.tsx</h3><button class="ghost-button" data-action="open-editor">Open editor</button></div><div class="code-diff"><span class="diff-line"><span class="line-no"> 1</span>export function WorkspaceHero({ workspace }) {</span><span class="diff-line"><span class="line-no"> 2</span>  return (</span><span class="diff-line"><span class="line-no"> 3</span>    &lt;section className="hero"&gt;</span><span class="diff-line"><span class="line-no"> 4</span>      &lt;ShipStatus workspace={workspace} /&gt;</span><span class="diff-line"><span class="line-no"> 5</span>    &lt;/section&gt;</span><span class="diff-line"><span class="line-no"> 6</span>  );</span><span class="diff-line"><span class="line-no"> 7</span>}</span></div></section></div>`;
  return `<div class="split-wide"><div class="stack-lg"><section class="card"><div class="card-header"><div><h2>Agent activity</h2><span class="muted">Events from the active run</span></div><button class="tag blue">Live</button></div><div class="timeline"><div class="timeline-item"><span class="timeline-dot">${icon('bolt',12)}</span><div><strong>Implementing responsive hero</strong><p>Claude edited 3 files and started the client test suite.</p></div><time>2m</time></div><div class="timeline-item"><span class="timeline-dot">${icon('check',12)}</span><div><strong>Typecheck passed</strong><p>Frontend and server typechecks are green.</p></div><time>4m</time></div><div class="timeline-item"><span class="timeline-dot">${icon('git',12)}</span><div><strong>Workspace created</strong><p>Cloned main into an isolated worktree.</p></div><time>18m</time></div></div></section><section class="card"><div class="card-header"><div><h2>Ship path</h2><span class="muted">This workspace’s route to main</span></div><span class="tag yellow">Review next</span></div><div class="pipeline"><div class="pipeline-step done"><span class="pipeline-dot">${icon('check',13)}</span>Diff</div><div class="pipeline-step done"><span class="pipeline-dot">${icon('check',13)}</span>Test</div><div class="pipeline-step active"><span class="pipeline-dot">3</span>Review</div><div class="pipeline-step"><span class="pipeline-dot">4</span>PR</div><div class="pipeline-step"><span class="pipeline-dot">5</span>Merge</div></div></section></div><div class="stack-lg">${workspaceContext(item)}<section class="card chat-box" style="min-height:300px"><div class="card-header"><div><h2>Continue with ${escapeHtml(item.provider)}</h2><span class="muted">The agent is ready for your direction</span></div></div><div class="chat-messages" style="padding:14px"><div class="message"><span class="provider-logo ${item.providerKey}">${item.provider.slice(0,2).toUpperCase()}</span><div class="message-bubble"><strong>${escapeHtml(item.provider)} · 2m ago</strong>The responsive hero is implemented. I found one lint boundary issue in the workspace. Should I fix that before opening the PR?</div></div></div><div class="composer"><textarea placeholder="Tell the agent what to do next…"></textarea><button class="primary-button" data-action="send-message">Send</button></div></section></div></div>`;
}

function workspaceContext(item, compact = false) {
  return `<section class="card context-card"><div class="row-between"><h3>Workspace context</h3><span class="tag ${compact ? 'purple' : 'blue'}">${compact ? 'Context' : 'Isolated'}</span></div><div class="context-row"><span>Project</span><span>${escapeHtml(item.project)}</span></div><div class="context-row"><span>Branch</span><span>${escapeHtml(item.branch)}</span></div><div class="context-row"><span>Provider</span><span>${escapeHtml(item.provider)}</span></div><div class="context-row"><span>Changed</span><span>${escapeHtml(item.changes)}</span></div><div class="context-row"><span>Spend</span><span>${item.provider === 'Claude' ? '$1.42' : '$0.88'} / $5.00</span></div><div style="margin-top:12px" class="progress"><span style="width:${item.progress}%"></span></div></section>`;
}

function renderReview() {
  return `${pageHeading('Human gate', 'Review queue', 'Review the changes that are ready for a second set of eyes. Comments go straight back to the agent.', `<button class="ghost-button" data-screen="activity">${icon('activity',14)} View all activity</button>`)}<div class="split-wide"><div class="stack"><article class="card review-card"><div class="review-summary"><div class="row">${providerBadge(workspaces[1])}<div><h2>OAuth recovery flow</h2><p class="meta">CloudCLI Core · fix/oauth-session-recovery</p></div></div><span class="tag yellow">3 comments</span></div><p class="subheading">Recover interrupted provider auth without losing the active session. 6 files changed · +186 −42.</p><div class="comment"><strong>Codex review summary</strong><br>Implementation is ready. One edge case around expired refresh tokens needs confirmation.</div><div class="review-actions"><button class="ghost-button" data-workspace="ws-auth">Open workspace</button><button class="danger-button" data-action="request-changes">Request changes</button><button class="primary-button" data-action="approve">Approve diff</button></div></article><article class="card review-card"><div class="review-summary"><div class="row">${providerBadge(workspaces[4])}<div><h2>MCP catalog isolation</h2><p class="meta">CloudCLI Core · fix/mcp-provider-isolation</p></div></div><span class="tag red">Permission needed</span></div><p class="subheading">Keep catalog definitions separate from provider-native config fanout. 9 files changed · +304 −77.</p><div class="comment" style="border-color:var(--yellow)"><strong>Needs you</strong><br>Allow <span class="mono">gh pr view</span> so the agent can verify check status.</div><div class="review-actions"><button class="ghost-button" data-workspace="ws-mcp">Open workspace</button><button class="primary-button" data-action="review-permission">Review permission</button></div></article></div><section class="card"><div class="card-header"><div><h2>Review principles</h2><span class="muted">A quick checklist</span></div>${icon('review',18)}</div><div class="check-list"><div class="check-row"><span class="check-icon">${icon('check')}</span><strong>Diff is scoped to the task</strong></div><div class="check-row"><span class="check-icon">${icon('check')}</span><strong>Tests and checks are visible</strong></div><div class="check-row"><span class="check-icon">${icon('check')}</span><strong>Agent can receive comments</strong></div><div class="check-row"><span class="check-icon">${icon('clock')}</span><strong>PR is created after approval</strong></div></div><div class="card-pad"><p class="subheading">CloudCLI keeps the human decision at the boundary between agent output and integration.</p></div></section></div>`;
}

function renderSwarm() {
  return `${pageHeading('Parallel agents', 'Agent Swarm', 'Coordinate planning, implementation, review, and validation agents inside one durable workspace.', `<button class="ghost-button" data-action="refresh">${icon('activity',14)} Refresh swarm</button><button class="primary-button" data-action="new-swarm">${icon('plus',14)} New swarm</button>`)}<section class="card swarm-banner" style="margin-bottom:14px"><div class="swarm-orbit">${icon('swarm',30)}</div><div style="flex:1"><div class="row"><h2>CloudCLI redesign exploration</h2><span class="tag blue">Running</span></div><p class="subheading">4 agents · wave 2 of 3 · shared workspace <span class="mono">ws-redesign-01</span></p></div><button class="danger-button" data-action="pause-swarm">Pause swarm</button></section><div class="grid grid-4" style="margin-bottom:14px"><div class="card stat-card"><span class="stat-label">Agents active</span><div class="stat-value">4 / 4</div><span class="stat-trend">All healthy</span></div><div class="card stat-card"><span class="stat-label">Completed steps</span><div class="stat-value">9 / 14</div><span class="stat-trend">Wave 2 underway</span></div><div class="card stat-card"><span class="stat-label">Workspace changes</span><div class="stat-value">+1,204</div><span class="stat-trend">Across 24 files</span></div><div class="card stat-card"><span class="stat-label">Estimated spend</span><div class="stat-value">$3.18</div><span class="stat-trend warning">Budget $8.00</span></div></div><section class="card" style="margin-bottom:14px"><div class="card-header"><div><h2>Agent seats</h2><span class="muted">Each role has a clear responsibility</span></div><span class="tag purple">Shared workspace</span></div><div class="member-grid">${[['PL','Planner','Claude','green','Complete'],['IM','Implementer','Codex','blue','Working'],['RV','Reviewer','Cursor','yellow','Waiting'],['QA','Validator','Kimi','cyan','Working']].map(([initial,role,provider,tone,status]) => `<div class="member"><div class="row-between"><span class="avatar" style="background:rgba(112,167,255,.16);color:var(--${tone === 'green' ? 'green' : tone === 'yellow' ? 'yellow' : tone === 'cyan' ? 'cyan' : 'blue'})">${initial}</span><span class="tag ${tone === 'green' ? 'green' : tone === 'yellow' ? 'yellow' : tone === 'cyan' ? 'purple' : 'blue'}">${status}</span></div><strong>${role}</strong><small>${provider} · ${role === 'Implementer' ? 'Edit workspace' : 'Read and report'}</small></div>`).join('')}</div></section><div class="split"><section class="card"><div class="card-header"><div><h2>Wave timeline</h2><span class="muted">Durable execution checkpoints</span></div></div><div class="timeline"><div class="timeline-item"><span class="timeline-dot">${icon('check',12)}</span><div><strong>Plan approved</strong><p>Acceptance criteria and file ownership confirmed.</p></div><time>09:44</time></div><div class="timeline-item"><span class="timeline-dot">${icon('bolt',12)}</span><div><strong>Implementer editing</strong><p>Workspace changes are being serialized for overlapping files.</p></div><time>10:18</time></div><div class="timeline-item"><span class="timeline-dot">${icon('clock',12)}</span><div><strong>Review wave queued</strong><p>Reviewer will receive the implementation diff next.</p></div><time>next</time></div></div></section><section class="card"><div class="card-header"><div><h2>Swarm controls</h2><span class="muted">Safe actions with durable state</span></div></div><div class="card-pad stack"><button class="ghost-button" data-action="approve-plan">Approve current plan ${icon('arrow',13)}</button><button class="ghost-button" data-action="resume-swarm">Resume from checkpoint ${icon('arrow',13)}</button><button class="danger-button" data-action="archive-swarm">Archive this swarm</button></div></section></div>`;
}

function renderKanban() {
  const columns = [['backlog','Backlog','8'],['progress','In progress','2'],['review','Review','1'],['done','Done','12']];
  return `${pageHeading('Delivery planning', 'Kanban', 'Turn ideas into isolated agent workspaces. Every task can become a branch, run, review, and PR.', `<button class="ghost-button" data-action="board-settings">${icon('settings',14)} Board settings</button><button class="primary-button" data-action="new-task">${icon('plus',14)} New task</button>`)}<div class="kanban">${columns.map(([id,label,count]) => `<section class="kanban-column"><div class="kanban-column-header"><span>${label}</span><span class="kanban-count">${tasks.filter((task) => task.col === id).length} / ${count}</span></div><div class="kanban-cards">${tasks.filter((task) => task.col === id).map((task) => `<article class="task-card"><div class="row-between"><span class="tag ${task.priority === 'P0' ? 'red' : task.priority === 'P1' ? 'yellow' : 'blue'}">${task.priority}</span><button class="icon-button" data-action="task-menu">${icon('dots',14)}</button></div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.detail)}</p><div class="task-footer"><span class="row"><span class="avatar" style="width:20px;height:20px;font-size:8px">${task.assignee}</span><small>${task.provider}</small></span>${id !== 'done' ? `<button class="task-move" data-move-task="${task.id}">${id === 'backlog' ? 'Start' : id === 'progress' ? 'Review' : 'Ship'} ${icon('arrow',11)}</button>` : '<span class="tag green">Shipped</span>'}</div></article>`).join('') || '<div class="empty" style="padding:25px 10px;font-size:11px">No tasks</div>'}</div></section>`).join('')}</div>`;
}

function renderProjects() {
  return `${pageHeading('Your repositories', 'Projects', 'Projects are the durable home for workspaces, agents, memory, skills, MCP configuration, and history.', `<button class="ghost-button" data-action="import-project">${icon('folder',14)} Import repository</button><button class="primary-button" data-action="new-project">${icon('plus',14)} New project</button>`)}<div class="grid grid-3">${projects.map((project) => `<article class="card project-card"><div class="project-icon">${project.name.split(' ').map((word) => word[0]).join('').slice(0,2)}</div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.description)}</p><div class="project-footer"><span>${project.active} active workspaces</span><span class="mono">${escapeHtml(project.branch)}</span></div><button class="ghost-button" style="margin-top:14px;width:100%" data-screen="workspaces">Open project ${icon('arrow',13)}</button></article>`).join('')}</div>`;
}

function renderNeeds() {
  return `${pageHeading('Human decisions only', 'Needs you', 'A focused action center for permissions, approvals, broken connections, and workspace conflicts.', `<button class="ghost-button" data-action="notification-settings">${icon('settings',14)} Notification settings</button>`)}<div class="split-wide"><section class="card"><div class="card-header"><div><h2>3 open decisions</h2><span class="muted">Operational telemetry stays in Activity</span></div><span class="tag red">Action required</span></div>${needs.map((item) => `<div class="needs-item"><span class="needs-icon" style="background:rgba(${item.tone === 'red' ? '242,120,135' : item.tone === 'blue' ? '112,167,255' : '240,199,108'},.12);color:var(--${item.tone})">${icon(item.tone === 'blue' ? 'review' : item.tone === 'red' ? 'alert' : 'settings',15)}</span><div style="flex:1"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p><div class="needs-actions"><button class="primary-button" data-action="needs-action" data-needs-id="${item.id}">${escapeHtml(item.action)}</button><button class="ghost-button" data-action="snooze">Snooze</button></div></div></div>`).join('')}</section><section class="card"><div class="card-header"><div><h2>What belongs here?</h2><span class="muted">Keep signal high</span></div>${icon('alert',18)}</div><div class="card-pad stack"><div class="row"><span class="tag green">Included</span><span class="meta">Permissions, approvals, auth, MCP, secrets, conflicts</span></div><div class="row"><span class="tag red">Excluded</span><span class="meta">Failed runs, CI failures, stuck jobs, task backlog</span></div><p class="subheading">Those remain visible on their owning surface with context and recovery actions.</p></div></section></div>`;
}

function renderStudio() {
  return `${pageHeading('Ideate to build', 'Studio', 'Describe a product idea, generate a first cut, then send the right context to chat or a design swarm.', `<button class="ghost-button" data-screen="swarm">${icon('swarm',14)} Open design swarm</button>`)}<div class="split-wide"><section class="card"><div class="card-header"><div><h2>Start a prototype</h2><span class="muted">Dummy generation flow</span></div><span class="tag purple">Creative mode</span></div><div class="card-pad"><label class="form-label">What are you building?<textarea class="studio-prompt" placeholder="A calm command center for managing parallel coding agents…">A calm workspace command center for a multi-agent development team, with clear review and shipping states.</textarea></label><div class="row" style="margin-top:13px"><button class="primary-button" data-action="generate-prototype">${icon('spark',14)} Generate first cut</button><button class="ghost-button" data-action="send-to-chat">Send to chat</button></div></div></section><section class="card"><div class="card-header"><div><h2>Prototype canvas</h2><span class="muted">Generated preview</span></div><span class="tag green">Ready</span></div><div class="card-pad"><div class="prototype-preview"><div><div class="brand-mark" style="margin:0 auto 12px">C</div><strong>Workspace command center</strong><p style="margin-top:5px">A first cut will appear here.</p></div></div></div></section></div><section class="card" style="margin-top:14px"><div class="card-header"><div><h2>Recent concepts</h2><span class="muted">Continue where you left off</span></div></div><div class="grid grid-3" style="padding:14px"><div class="card card-pad"><span class="tag purple">Prototype</span><h3 style="margin-top:12px">Agent command center</h3><p class="subheading">Updated 2h ago · 3 iterations</p></div><div class="card card-pad"><span class="tag blue">Exploration</span><h3 style="margin-top:12px">Provider comparison view</h3><p class="subheading">Updated yesterday · 1 iteration</p></div><div class="card card-pad"><span class="tag yellow">Draft</span><h3 style="margin-top:12px">Mobile activity cockpit</h3><p class="subheading">Updated Aug 12 · 2 iterations</p></div></div></section>`;
}

function renderSettings() {
  return `${pageHeading('Workspace preferences', 'Settings', 'Tune the agent experience, provider defaults, safety, appearance, and connected tools.', '')}<div class="settings-layout"><section class="card settings-nav"><button class="active">General</button><button>Agents & models</button><button>Permissions</button><button>MCP & skills</button><button>Notifications</button><button>Appearance</button><button>Account</button></section><section class="card card-pad"><div class="row-between"><div><h2>General</h2><p class="subheading">How CloudCLI behaves across projects and workspaces.</p></div><span class="tag green">Saved locally</span></div><div class="setting-row"><div><strong>Live activity updates</strong><p>Stream workspace events as agents work.</p></div><button class="toggle ${state.toggles.notifications ? 'on' : ''}" data-toggle="notifications"><span></span></button></div><div class="setting-row"><div><strong>Auto-archive merged workspaces</strong><p>Keep the active list focused after merge.</p></div><button class="toggle ${state.toggles.autoArchive ? 'on' : ''}" data-toggle="autoArchive"><span></span></button></div><div class="setting-row"><div><strong>Reduced motion</strong><p>Use minimal transitions and animation.</p></div><button class="toggle ${state.toggles.reducedMotion ? 'on' : ''}" data-toggle="reducedMotion"><span></span></button></div><div class="setting-row"><div><strong>Default permission profile</strong><p>Applied to newly created workspaces.</p></div><select class="select"><option>On request</option><option>Workspace write</option><option>Auto review</option></select></div><div class="setting-row"><div><strong>Default provider</strong><p>Used when a new workspace does not specify an agent.</p></div><select class="select"><option>Claude</option><option>Codex</option><option>Cursor</option><option>Kimi</option></select></div><button class="primary-button" style="margin-top:20px" data-action="save-settings">Save preferences</button></section></div>`;
}

function renderOnboarding() {
  const steps = [['Connect a provider','Claude is connected · Codex and Cursor available','complete'],['Add your first project','CloudCLI Web · ~/Development/cloudcli-fork','complete'],['Create a workspace','Start one isolated stream of agent work',''],['Run your first check','Make the ship path visible from day one',''],['Invite a second agent','Compare providers or collaborate in one workspace','']];
  return `<section class="card onboarding"><div class="onboarding-hero"><div class="brand-mark">C</div><div class="eyebrow">Welcome to CloudCLI</div><h1>Set up your command center</h1><p class="subheading" style="margin:10px auto 0">A few steps to move from provider setup to your first reviewed pull request.</p></div>${steps.map(([title,detail,status],index) => `<div class="setup-step ${status}"><span class="setup-number">${status ? icon('check',14) : index + 1}</span><div><strong>${title}</strong><p>${detail}</p></div>${status ? '<span class="tag green">Ready</span>' : `<button class="ghost-button" data-action="setup-step">Start ${icon('arrow',12)}</button>`}</div>`).join('')}<div class="card-pad" style="display:flex;justify-content:flex-end"><button class="primary-button" data-action="new-workspace">Create first workspace ${icon('arrow',13)}</button></div></section>`;
}

function renderScreen() {
  return ({ dashboard: renderDashboard, workspaces: renderWorkspaces, activity: renderActivity, workspace: renderWorkspace, review: renderReview, swarm: renderSwarm, kanban: renderKanban, projects: renderProjects, needs: renderNeeds, studio: renderStudio, settings: renderSettings, onboarding: renderOnboarding }[state.screen] || renderDashboard)();
}

function renderModal() {
  if (!state.modal) return '';
  if (state.modal === 'new-workspace') return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" onclick="event.stopPropagation()"><div class="modal-header"><div><div class="eyebrow">New workspace</div><h2 style="margin-top:5px">Start an independent stream</h2></div><button class="icon-button" data-action="close-modal">${icon('close')}</button></div><div class="modal-body"><label class="form-label">What should the agent work on?<input class="field" id="workspace-goal" value="Build a reviewable workspace command center" /></label><label class="form-label">Project<select class="select"><option>CloudCLI Web · main</option><option>CloudCLI Core · main</option><option>CloudCLI Studio · main</option></select></label><label class="form-label">Provider<select class="select"><option>Claude · Sonnet 4</option><option>Codex · GPT-5</option><option>Cursor · Composer</option><option>Kimi · K2.5</option></select></label><div class="row"><span class="tag blue">New branch</span><span class="tag purple">Isolated worktree</span><span class="tag green">Review path enabled</span></div></div><div class="modal-footer"><button class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="create-workspace">Create workspace ${icon('arrow',13)}</button></div></section></div>`;
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" onclick="event.stopPropagation()"><div class="modal-header"><div><div class="eyebrow">Command palette</div><h2 style="margin-top:5px">Jump anywhere</h2></div><button class="icon-button" data-action="close-modal">${icon('close')}</button></div><div class="modal-body"><label class="top-search" style="max-width:none;margin:0">${icon('search',15)}<input autofocus placeholder="Search commands…" /></label><div class="stack"><button class="nav-item" data-action="new-workspace">${icon('plus')}<span class="nav-text">New workspace</span><span class="shortcut">⌘ ⇧ N</span></button><button class="nav-item" data-screen="review">${icon('review')}<span class="nav-text">Open review queue</span><span class="shortcut">⌘ ⇧ D</span></button><button class="nav-item" data-screen="activity">${icon('activity')}<span class="nav-text">View activity</span><span class="shortcut">⌘ 3</span></button><button class="nav-item" data-screen="settings">${icon('settings')}<span class="nav-text">Open settings</span></button></div></div></section></div>`;
}

function render() {
  document.body.classList.toggle('light', state.theme === 'light');
  document.body.classList.toggle('reduced-motion', state.toggles.reducedMotion);
  $('#app').innerHTML = `<div class="app-shell">${renderSidebar()}<main class="main">${renderTopbar()}<div class="main-content">${renderScreen()}</div></main></div>`;
  $('#modal-root').innerHTML = renderModal();
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function openWorkspace(id) {
  state.workspaceId = id;
  state.screen = 'workspace';
  state.workspaceTab = 'overview';
  state.mobileOpen = false;
  render();
}

document.addEventListener('click', (event) => {
  const screenTarget = event.target.closest('[data-screen]');
  if (screenTarget) {
    const id = screenTarget.dataset.screen;
    if (id === 'workspace') state.screen = 'workspace'; else state.screen = id;
    state.mobileOpen = false;
    render();
    return;
  }
  const workspaceTarget = event.target.closest('[data-workspace]');
  if (workspaceTarget) { openWorkspace(workspaceTarget.dataset.workspace); return; }
  const tabTarget = event.target.closest('[data-workspace-tab]');
  if (tabTarget) { state.workspaceTab = tabTarget.dataset.workspaceTab; render(); return; }
  const filterTarget = event.target.closest('[data-filter]');
  if (filterTarget) { state.filter = filterTarget.dataset.filter; render(); return; }
  const toggleTarget = event.target.closest('[data-toggle]');
  if (toggleTarget) { const key = toggleTarget.dataset.toggle; state.toggles[key] = !state.toggles[key]; render(); toast(`${key === 'notifications' ? 'Live activity' : key === 'autoArchive' ? 'Auto archive' : 'Reduced motion'} ${state.toggles[key] ? 'enabled' : 'disabled'}`); return; }
  const moveTarget = event.target.closest('[data-move-task]');
  if (moveTarget) { const task = tasks.find((item) => item.id === moveTarget.dataset.moveTask); if (task) { task.col = task.col === 'backlog' ? 'progress' : task.col === 'progress' ? 'review' : 'done'; render(); toast(`${task.title} moved to ${task.col}`); } return; }
  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  if (action === 'mobile-menu') { state.mobileOpen = !state.mobileOpen; render(); return; }
  if (action === 'toggle-theme') { state.theme = state.theme === 'dark' ? 'light' : 'dark'; render(); toast(`${state.theme === 'dark' ? 'Dark' : 'Light'} theme enabled`); return; }
  if (action === 'new-workspace') { state.modal = 'new-workspace'; render(); return; }
  if (action === 'command') { state.modal = 'command'; render(); return; }
  if (action === 'close-modal') { state.modal = null; render(); return; }
  if (action === 'create-workspace') { state.modal = null; state.screen = 'workspaces'; render(); toast('Workspace created · setup is running'); return; }
  if (action === 'run-tests') { toast('Checks started in the isolated workspace'); return; }
  if (action === 'approve') { toast('Diff approved · PR can be created'); return; }
  if (action === 'request-changes') { toast('Review comments sent back to the agent'); return; }
  if (action === 'open-fix') { toast('Fix run opened with lint failures attached'); return; }
  if (action === 'review-permission' || action === 'needs-action') { toast('Permission dialog opened · dummy action accepted'); return; }
  if (action === 'send-message') { toast('Message queued for the agent'); return; }
  if (action === 'pause-swarm') { toast('Swarm paused at the current checkpoint'); return; }
  if (action === 'resume-swarm' || action === 'approve-plan') { toast('Swarm resumed with the latest durable state'); return; }
  if (action === 'archive-swarm') { toast('Swarm archived and workspace preserved'); return; }
  if (action === 'generate-prototype') { toast('Prototype generated · 3 screens ready to refine'); return; }
  if (action === 'save-settings') { toast('Preferences saved locally'); return; }
  if (action === 'refresh' || action === 'export-activity' || action === 'open-github' || action === 'workspace-menu' || action === 'setup-step' || action === 'new-swarm' || action === 'new-task' || action === 'new-project' || action === 'import-project' || action === 'import-workspace' || action === 'board-settings' || action === 'notification-settings' || action === 'snooze' || action === 'clear-terminal' || action === 'open-editor' || action === 'send-to-chat' || action === 'task-menu') { toast('Demo action recorded'); return; }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); state.modal = 'command'; render(); }
  if (event.key === 'Escape' && state.modal) { state.modal = null; render(); }
});

render();
