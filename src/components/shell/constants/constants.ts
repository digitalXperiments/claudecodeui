import type { ITerminalOptions, ITheme } from '@xterm/xterm';

export const SHELL_RESTART_DELAY_MS = 200;
export const TERMINAL_INIT_DELAY_MS = 100;
export const TERMINAL_RESIZE_DELAY_MS = 50;

// CLI prompt overlay detection
export const PROMPT_DEBOUNCE_MS = 500;
export const PROMPT_BUFFER_SCAN_LINES = 20;
export const PROMPT_OPTION_SCAN_LINES = 15;
export const PROMPT_MAX_OPTIONS = 5;
export const PROMPT_MIN_OPTIONS = 2;

export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  allowProposedApi: true,
  allowTransparency: false,
  convertEol: true,
  scrollback: 10000,
  tabStopWidth: 4,
  windowsMode: false,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
};

const DARK_TERMINAL_THEME: ITheme = {
  background: '#141414',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  cursorAccent: '#141414',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
  extendedAnsi: [
    '#000000',
    '#800000',
    '#008000',
    '#808000',
    '#000080',
    '#800080',
    '#008080',
    '#c0c0c0',
    '#808080',
    '#ff0000',
    '#00ff00',
    '#ffff00',
    '#0000ff',
    '#ff00ff',
    '#00ffff',
    '#ffffff',
  ],
};

const LIGHT_TERMINAL_THEME: ITheme = {
  background: '#f6f4ef',
  foreground: '#262626',
  cursor: '#262626',
  cursorAccent: '#f6f4ef',
  selectionBackground: '#b7d5f5',
  selectionForeground: '#171717',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#d0d7de',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#9a6700',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#ffffff',
  extendedAnsi: [
    '#24292f',
    '#cf222e',
    '#116329',
    '#9a6700',
    '#0969da',
    '#8250df',
    '#1b7c83',
    '#d0d7de',
    '#57606a',
    '#a40e26',
    '#1a7f37',
    '#9a6700',
    '#218bff',
    '#a475f9',
    '#3192aa',
    '#ffffff',
  ],
};

export const getTerminalTheme = (isDarkMode: boolean): ITheme =>
  isDarkMode ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
