/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - Lazy-loading of translation namespaces
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
import koCommon from './locales/ko/common.json';
import koSettings from './locales/ko/settings.json';
import koAuth from './locales/ko/auth.json';
import koSidebar from './locales/ko/sidebar.json';
import koChat from './locales/ko/chat.json';
import koCodeEditor from './locales/ko/codeEditor.json';
import koSkills from './locales/ko/skills.json';
import zhCommon from './locales/zh-CN/common.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhAuth from './locales/zh-CN/auth.json';
import zhSidebar from './locales/zh-CN/sidebar.json';
import zhChat from './locales/zh-CN/chat.json';
import zhCodeEditor from './locales/zh-CN/codeEditor.json';
import zhSkills from './locales/zh-CN/skills.json';
import jaCommon from './locales/ja/common.json';
import jaSettings from './locales/ja/settings.json';
import jaAuth from './locales/ja/auth.json';
import jaSidebar from './locales/ja/sidebar.json';
import jaChat from './locales/ja/chat.json';
import jaCodeEditor from './locales/ja/codeEditor.json';
import jaTasks from './locales/ja/tasks.json';
import jaSkills from './locales/ja/skills.json';
import ruCommon from './locales/ru/common.json';
import ruSettings from './locales/ru/settings.json';
import ruAuth from './locales/ru/auth.json';
import ruSidebar from './locales/ru/sidebar.json';
import ruChat from './locales/ru/chat.json';
import ruCodeEditor from './locales/ru/codeEditor.json';
import ruTasks from './locales/ru/tasks.json';
import ruSkills from './locales/ru/skills.json';
import deCommon from './locales/de/common.json';
import deSettings from './locales/de/settings.json';
import deAuth from './locales/de/auth.json';
import deSidebar from './locales/de/sidebar.json';
import deChat from './locales/de/chat.json';
import deCodeEditor from './locales/de/codeEditor.json';
import deTasks from './locales/de/tasks.json';
import deSkills from './locales/de/skills.json';
import trCommon from './locales/tr/common.json';
import trSettings from './locales/tr/settings.json';
import trAuth from './locales/tr/auth.json';
import trSidebar from './locales/tr/sidebar.json';
import trChat from './locales/tr/chat.json';
import trCodeEditor from './locales/tr/codeEditor.json';
import trTasks from './locales/tr/tasks.json';
import trSkills from './locales/tr/skills.json';
import itCommon from './locales/it/common.json';
import itSettings from './locales/it/settings.json';
import itAuth from './locales/it/auth.json';
import itSidebar from './locales/it/sidebar.json';
import itChat from './locales/it/chat.json';
import itCodeEditor from './locales/it/codeEditor.json';
import itTasks from './locales/it/tasks.json';
import itSkills from './locales/it/skills.json';
import zhTWCommon from './locales/zh-TW/common.json';
import zhTWSettings from './locales/zh-TW/settings.json';
import zhTWAuth from './locales/zh-TW/auth.json';
import zhTWSidebar from './locales/zh-TW/sidebar.json';
import zhTWChat from './locales/zh-TW/chat.json';
import zhTWCodeEditor from './locales/zh-TW/codeEditor.json';
import zhTWTasks from './locales/zh-TW/tasks.json';
import zhTWSkills from './locales/zh-TW/skills.json';
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
i18n
  .use(LanguageDetector) // Detect user language
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // Resources containing all translations
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
      ko: {
        common: koCommon,
        settings: koSettings,
        auth: koAuth,
        sidebar: koSidebar,
        chat: koChat,
        codeEditor: koCodeEditor,
        skills: koSkills,
      },
      'zh-CN': {
        common: zhCommon,
        settings: zhSettings,
        auth: zhAuth,
        sidebar: zhSidebar,
        chat: zhChat,
        codeEditor: zhCodeEditor,
        skills: zhSkills,
      },
      ja: {
        common: jaCommon,
        settings: jaSettings,
        auth: jaAuth,
        sidebar: jaSidebar,
        chat: jaChat,
        codeEditor: jaCodeEditor,
        tasks: jaTasks,
        skills: jaSkills,
      },
      ru: {
        common: ruCommon,
        settings: ruSettings,
        auth: ruAuth,
        sidebar: ruSidebar,
        chat: ruChat,
        codeEditor: ruCodeEditor,
        tasks: ruTasks,
        skills: ruSkills,
      },
      de: {
        common: deCommon,
        settings: deSettings,
        auth: deAuth,
        sidebar: deSidebar,
        chat: deChat,
        codeEditor: deCodeEditor,
        tasks: deTasks,
        skills: deSkills,
      },
      tr: {
        common: trCommon,
        settings: trSettings,
        auth: trAuth,
        sidebar: trSidebar,
        chat: trChat,
        codeEditor: trCodeEditor,
        tasks: trTasks,
        skills: trSkills,
      },
      it: {
        common: itCommon,
        settings: itSettings,
        auth: itAuth,
        sidebar: itSidebar,
        chat: itChat,
        codeEditor: itCodeEditor,
        tasks: itTasks,
        skills: itSkills,
      },
      'zh-TW': {
        common: zhTWCommon,
        settings: zhTWSettings,
        auth: zhTWAuth,
        sidebar: zhTWSidebar,
        chat: zhTWChat,
        codeEditor: zhTWCodeEditor,
        tasks: zhTWTasks,
        skills: zhTWSkills,
      },
    },

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
