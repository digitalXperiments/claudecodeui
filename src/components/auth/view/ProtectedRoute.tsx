import { lazy, Suspense, type ReactNode } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { useAuth } from '../context/AuthContext';
import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import SetupForm from './SetupForm';

// Onboarding pulls provider login (xterm shell) — only needed for new users.
const Onboarding = lazy(() => import('../../onboarding/view/Onboarding'));

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return (
        <Suspense fallback={<AuthLoadingScreen />}>
          <Onboarding onComplete={refreshOnboardingStatus} />
        </Suspense>
      );
    }

    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return (
      <Suspense fallback={<AuthLoadingScreen />}>
        <Onboarding onComplete={refreshOnboardingStatus} />
      </Suspense>
    );
  }

  return <>{children}</>;
}
