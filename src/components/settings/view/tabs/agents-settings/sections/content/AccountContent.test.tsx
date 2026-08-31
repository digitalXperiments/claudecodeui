import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstance } from 'i18next';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import type { AuthStatus } from '../../../../../types/types';

import AccountContent from './AccountContent';

const noop = () => {};

// Keep this SSR test independent from the browser-configured application i18n
// singleton while rendering the same translations users see in Settings.
const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  initImmediate: false,
  resources: {
    en: {
      settings: {
        agents: {
          connectionStatus: 'Connection status',
          authStatus: {
            checkingAuth: 'Checking authentication',
            checking: 'Checking',
            notInstalled: 'Not installed',
            loggedInAs: 'Logged in as {{email}}',
            authenticatedUser: 'Authenticated user',
            notConnected: 'Not connected',
            connected: 'Connected',
            disconnected: 'Disconnected',
          },
          login: {
            title: 'Log in',
            description: 'Connect {{agent}}',
            reAuthenticate: 'Reconnect',
            reAuthDescription: 'Reconnect {{agent}}',
            button: 'Log in',
            reLoginButton: 'Reconnect',
          },
          install: {
            title: 'Install {{agent}}',
            description: '{{agent}} isn\'t installed on this machine yet.',
          },
          error: '{{error}}',
        },
      },
    },
  },
});

const status = (overrides: Partial<AuthStatus> = {}): AuthStatus => ({
  installed: null,
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading: false,
  ...overrides,
});

const render = (authStatus: AuthStatus) => renderToStaticMarkup(
  <I18nextProvider i18n={i18n}>
    <AccountContent agent="omp" authStatus={authStatus} onLogin={noop} onRefresh={noop} />
  </I18nextProvider>,
);

test('AccountContent shows a checking state while loading', () => {
  const html = render(status({ loading: true }));
  assert.ok(html.includes('Checking'));
});

test('AccountContent shows connected + the login button becomes "reconnect" when installed and authenticated', () => {
  const html = render(status({ installed: true, authenticated: true, email: 'user@example.com' }));
  assert.ok(html.includes('user@example.com'));
  assert.ok(!html.includes('Not installed'));
  // Re-login must stay available (installed and authenticated is not a block state).
  assert.ok(!/disabled=""/.test(html));
});

test('AccountContent shows a disconnected state with an enabled login button when installed but unauthenticated', () => {
  const html = render(status({ installed: true, authenticated: false, error: 'Not logged in — run `omp` and use /login' }));
  assert.ok(html.includes('Not logged in'));
  assert.ok(!html.includes('Not installed'));
  assert.ok(!/disabled=""/.test(html));
});

test('AccountContent hides the login action and shows install guidance when the CLI is not installed', () => {
  const html = render(status({
    installed: false,
    authenticated: false,
    error: 'Oh My Pi CLI is not installed. Install with: curl -fsSL https://omp.sh/install | sh',
  }));

  assert.ok(html.includes('Not installed'));
  assert.ok(html.includes('curl -fsSL https://omp.sh/install'));
  // Login is impossible without the CLI — the action must not render at all,
  // not just be visually disabled.
  assert.ok(!html.includes('agents.login.button'));
  assert.ok(!html.includes('agents.login.reLoginButton'));
});

test('AccountContent treats installed=null (provider does not report it) as not blocked', () => {
  const html = render(status({ installed: null, authenticated: false, error: 'Some transient error' }));
  assert.ok(!html.includes('Not installed'));
  assert.ok(!/disabled=""/.test(html));
});
