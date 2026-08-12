import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

const THEME_MODES = ['light', 'dark', 'system'];

// localStorage key + modes must stay aligned with the pre-paint bootstrap in index.html
const THEME_STORAGE_KEY = 'theme';

const getSystemDarkMode = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

// Read the saved mode: 'light' | 'dark' | 'system'. Defaults to 'system'.
// Legacy saves of 'light'/'dark' remain valid.
const getSavedThemeMode = () => {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  return THEME_MODES.includes(savedTheme) ? savedTheme : 'system';
};

export const ThemeProvider = ({ children }) => {
  const [themeMode, setThemeModeState] = useState(getSavedThemeMode);

  const [isDarkMode, setIsDarkMode] = useState(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === 'dark') return true;
    if (savedTheme === 'light') return false;
    return getSystemDarkMode();
  });

  // Resolve the effective theme whenever the mode changes and persist it
  useEffect(() => {
    setIsDarkMode(themeMode === 'system' ? getSystemDarkMode() : themeMode === 'dark');
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  // Update document class and meta tags when the effective theme changes
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');

      // Update iOS status bar style and theme color for dark mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'black-translucent');
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', '#141414'); // Dark background color (hsl(0 0% 8%))
      }
    } else {
      document.documentElement.classList.remove('dark');

      // Update iOS status bar style and theme color for light mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'default');
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', '#f6f4ef'); // Light background color (warm cream)
      }
    }
  }, [isDarkMode]);

  // Listen for system theme changes while in 'system' mode
  useEffect(() => {
    if (themeMode !== 'system' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      setIsDarkMode(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode]);

  const setThemeMode = useCallback((mode) => {
    if (THEME_MODES.includes(mode)) {
      setThemeModeState(mode);
    }
  }, []);

  // Toggling picks an explicit mode opposite to the current effective theme
  const toggleDarkMode = useCallback(() => {
    setThemeModeState((prev) => {
      const currentlyDark = prev === 'system' ? getSystemDarkMode() : prev === 'dark';
      return currentlyDark ? 'light' : 'dark';
    });
  }, []);

  const value = useMemo(
    () => ({
      isDarkMode,
      themeMode,
      setThemeMode,
      toggleDarkMode,
    }),
    [isDarkMode, themeMode, setThemeMode, toggleDarkMode],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
