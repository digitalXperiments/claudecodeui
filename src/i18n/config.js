/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - English bundled statically; every other locale is loaded on demand
 *   (one small chunk per language/namespace) through a dynamic-import backend
 * - Language detection from localStorage
 * - Fallback to English for missing translations
 * - Development mode warnings for missing keys
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translation resources
import enCommon from './locales/en/common.json';
import enSettings from './locales/en/settings.json';
import enAuth from './locales/en/auth.json';
import enSidebar from './locales/en/sidebar.json';
import enChat from './locales/en/chat.json';
import enCodeEditor from './locales/en/codeEditor.json';
import enTasks from './locales/en/tasks.json';
import enSkills from './locales/en/skills.json';
// Non-English locale files become separate lazy chunks. English stays in the
// entry bundle so the default path never waits on a network round trip.
const localeLoaders = import.meta.glob(['./locales/*/*.json', '!./locales/en/*.json']);

const lazyLocaleBackend = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    const loader = localeLoaders[`./locales/${language}/${namespace}.json`];
    if (!loader) {
      // Namespace not translated for this language (or a region fallback like
      // "zh"): resolve empty so i18next falls back to English.
      callback(null, {});
      return;
    }
    loader().then(
      (module) => callback(null, module.default ?? module),
      (error) => callback(error, false),
    );
  },
};

// Import supported languages configuration
import { languages } from './languages.js';

// Get saved language preference from localStorage
const getSavedLanguage = () => {
  try {
    const saved = localStorage.getItem('userLanguage');
    // Validate that the saved language is supported
    if (saved && languages.some(lang => lang.value === saved)) {
      return saved;
    }
    return 'en';
  } catch {
    return 'en';
  }
};

// Initialize i18next
export const i18nReady = i18n
  .use(lazyLocaleBackend)
  .use(LanguageDetector) // Detect user language
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // Resources containing all translations
    // Only English is bundled; the backend fills in other languages lazily.
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        auth: enAuth,
        sidebar: enSidebar,
        chat: enChat,
        codeEditor: enCodeEditor,
        tasks: enTasks,
        skills: enSkills,
      },
    },
    partialBundledLanguages: true,

    // Default language
    lng: getSavedLanguage(),

    // Fallback language when a translation is missing
    fallbackLng: 'en',

    // Enable debug mode in development (logs missing keys to console)
    debug: false,

    // Namespaces - load only what's needed
    ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks', 'skills'],
    defaultNS: 'common',

    // Key separator for nested keys (default: '.')
    keySeparator: '.',

    // Namespace separator (default: ':')
    nsSeparator: ':',

    // Save missing translations (disabled - requires manual review)
    saveMissing: false,

    // Interpolation settings
    interpolation: {
      escapeValue: false, // React already escapes values
    },

    // React-specific settings
    react: {
      useSuspense: true, // Use Suspense for lazy-loading
      bindI18n: 'languageChanged', // Re-render on language change
      bindI18nStore: false, // Don't re-render on resource changes
    },

    // Detection options
    detection: {
      // Order of language detection (local storage first)
      order: ['localStorage'],

      // Keys to look for in localStorage
      lookupLocalStorage: 'userLanguage',

      // Cache user language
      caches: ['localStorage'],
    },
  });

// Save language preference when it changes
i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem('userLanguage', lng);
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
});

export default i18n;
