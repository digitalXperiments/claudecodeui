import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { api } from '../utils/api';

const TasksSettingsContext = createContext({
  tasksEnabled: true,
  setTasksEnabled: () => {},
  toggleTasksEnabled: () => {},
  isTaskMasterInstalled: null,
  isTaskMasterReady: null,
  installationStatus: null,
  isCheckingInstallation: true
});

export const useTasksSettings = () => {
  const context = useContext(TasksSettingsContext);
  if (!context) {
    throw new Error('useTasksSettings must be used within a TasksSettingsProvider');
  }
  return context;
};

export const TasksSettingsProvider = ({ children }) => {
  const { user, token, isLoading: isAuthLoading } = useAuth();
  const [tasksEnabled, setTasksEnabled] = useState(() => {
    // Load from localStorage on initialization
    const saved = localStorage.getItem('tasks-enabled');
    return saved !== null ? JSON.parse(saved) : true; // Default to true
  });
  
  const [isTaskMasterInstalled, setIsTaskMasterInstalled] = useState(null);
  const [isTaskMasterReady, setIsTaskMasterReady] = useState(null);
  const [installationStatus, setInstallationStatus] = useState(null);
  const [isCheckingInstallation, setIsCheckingInstallation] = useState(true);

  // Save to localStorage whenever tasksEnabled changes
  useEffect(() => {
    localStorage.setItem('tasks-enabled', JSON.stringify(tasksEnabled));
  }, [tasksEnabled]);

  // Protected endpoint — only probe after auth resolves with a session.
  // Eager mount fetch on / and /login produced unauthenticated 401 noise.
  useEffect(() => {
    if (isAuthLoading) {
      return;
    }

    if (!user || !token) {
      setInstallationStatus(null);
      setIsTaskMasterInstalled(null);
      setIsTaskMasterReady(null);
      setIsCheckingInstallation(false);
      return;
    }

    let cancelled = false;

    const checkInstallation = async () => {
      setIsCheckingInstallation(true);
      try {
        const response = await api.get('/taskmaster/installation-status');
        if (cancelled) {
          return;
        }
        if (response.ok) {
          const data = await response.json();
          setInstallationStatus(data);
          setIsTaskMasterInstalled(data.installation?.isInstalled || false);
          setIsTaskMasterReady(data.isReady || false);
          
          // If TaskMaster is not installed and user hasn't explicitly enabled tasks,
          // disable tasks automatically
          const userEnabledTasks = localStorage.getItem('tasks-enabled');
          if (!data.installation?.isInstalled && !userEnabledTasks) {
            setTasksEnabled(false);
          }
        } else {
          console.error('Failed to check TaskMaster installation status');
          setIsTaskMasterInstalled(false);
          setIsTaskMasterReady(false);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error checking TaskMaster installation:', error);
          setIsTaskMasterInstalled(false);
          setIsTaskMasterReady(false);
        }
      } finally {
        if (!cancelled) {
          setIsCheckingInstallation(false);
        }
      }
    };

    void checkInstallation();
    return () => {
      cancelled = true;
    };
  }, [isAuthLoading, token, user]);

  const toggleTasksEnabled = useCallback(() => {
    setTasksEnabled(prev => !prev);
  }, []);

  const contextValue = useMemo(() => ({
    tasksEnabled,
    setTasksEnabled,
    toggleTasksEnabled,
    isTaskMasterInstalled,
    isTaskMasterReady,
    installationStatus,
    isCheckingInstallation
  }), [
    tasksEnabled,
    toggleTasksEnabled,
    isTaskMasterInstalled,
    isTaskMasterReady,
    installationStatus,
    isCheckingInstallation,
  ]);

  return (
    <TasksSettingsContext.Provider value={contextValue}>
      {children}
    </TasksSettingsContext.Provider>
  );
};

export default TasksSettingsContext;