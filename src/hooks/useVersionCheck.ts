import { useState, useEffect } from 'react';
import { version } from '../../package.json';
import { ReleaseInfo } from '../types/sharedTypes';

/**
 * Compare two semantic version strings
 * Works only with numeric versions separated by dots (e.g. "1.2.3")
 * @param {string} v1 
 * @param {string} v2
 * @returns positive if v1 > v2, negative if v1 < v2, 0 if equal
 */
const compareVersions = (v1: string, v2: string) => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) return p1 - p2;
  }
  return 0;
};

export type InstallMode = 'git' | 'npm';

// The GitHub release check is a cross-origin request that nothing on the
// launch path needs; start it well after boot, when the browser is idle.
const INITIAL_VERSION_CHECK_DELAY_MS = 10_000;

/** Run `callback` once the main thread is idle (after at least `minDelayMs`). Returns a cancel fn. */
const runWhenIdle = (callback: () => void, minDelayMs = 0): (() => void) => {
  let idleHandle: number | null = null;
  const timeoutHandle = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(callback, { timeout: 5000 });
    } else {
      callback();
    }
  }, minDelayMs);
  return () => {
    window.clearTimeout(timeoutHandle);
    if (idleHandle !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleHandle);
    }
  };
};

export const useVersionCheck = (owner: string, repo: string) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
        // `data.version` is the version the server process is actually running.
        // This module's `version` is baked into the frontend bundle at build
        // time, so it reflects the installed (on-disk) package. If they differ,
        // the package was updated but the server process was not restarted, and
        // DB-backed actions may silently fail until it is.
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRunningVersion(data.version);
          setRestartRequired(data.version !== version);
        }
      } catch {
        // Default to git / no restart hint on error
      }
    };
    // Local and cheap, but still not needed for first paint.
    return runWhenIdle(() => {
      void fetchHealth();
    });
  }, []);

  useEffect(() => {
    const checkVersion = async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
        const data = await response.json();

        // Handle the case where there might not be any releases
        if (data.tag_name) {
          const latest = data.tag_name.replace(/^v/, '');
          setLatestVersion(latest);
          // Only show update if latest version is actually newer
          setUpdateAvailable(compareVersions(latest, version) > 0);

          // Store release information
          setReleaseInfo({
            title: data.name || data.tag_name,
            body: data.body || '',
            htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
            publishedAt: data.published_at
          });
        } else {
          // No releases found, don't show update notification
          setUpdateAvailable(false);
          setLatestVersion(null);
          setReleaseInfo(null);
        }
      } catch (error) {
        console.error('Version check failed:', error);
        // On error, don't show update notification
        setUpdateAvailable(false);
        setLatestVersion(null);
        setReleaseInfo(null);
      }
    };

    const cancelInitialCheck = runWhenIdle(() => {
      void checkVersion();
    }, INITIAL_VERSION_CHECK_DELAY_MS);
    const interval = setInterval(checkVersion, 5 * 60 * 1000); // Check every 5 minutes
    return () => {
      cancelInitialCheck();
      clearInterval(interval);
    };
  }, [owner, repo]);

  return { updateAvailable, latestVersion, currentVersion: version, releaseInfo, installMode, runningVersion, restartRequired };
}; 