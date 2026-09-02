import React from 'react';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import {
  AuthLockCard,
  ErrorScreen,
  LoadingScreen,
} from './AuthScreens';
import { useSessionAuthGateController } from './useSessionAuthGateController';

export interface SessionAuthGateProps {
  children: React.ReactNode;
}

export const SessionAuthGate: React.FC<SessionAuthGateProps> = ({
  children,
}) => {
  const {
    state,
    password,
    setPassword,
    passwordInputRef,
    isSubmitting,
    errorMessage,
    setErrorMessage,
    retryAfter,
    isTunnelLocked,
    passkeyStatus,
    supportsPasskeys,
    isPasskeyBusy,
    trustDevice,
    setTrustDevice,
    activePasskeyAction,
    showHostSwitcher,
    resetTransientRetry,
    checkStatus,
    handleSubmit,
    handlePasskeyUnlock,
    handlePasskeySetupOnly,
  } = useSessionAuthGateController();

  if (state === 'pending') {
    return <LoadingScreen />;
  }

  if (state === 'error') {
    return (
      <ErrorScreen
        onRetry={() => {
          resetTransientRetry();
          void checkStatus();
        }}
        errorType="network"
      >
        {showHostSwitcher && (
          <div className="w-full max-w-xs">
            <DesktopHostSwitcherInline />
            <p className="mt-1 text-center typography-micro text-muted-foreground">
              {"Use Local if remote is unreachable."}
            </p>
          </div>
        )}
      </ErrorScreen>
    );
  }

  if (state === 'rate-limited') {
    return (
      <ErrorScreen
        onRetry={() => void checkStatus()}
        errorType="rate-limit"
        retryAfter={retryAfter}
      />
    );
  }

  if (state === 'locked') {
    return (
      <AuthLockCard
        isTunnelLocked={isTunnelLocked}
        password={password}
        setPassword={setPassword}
        passwordInputRef={passwordInputRef}
        isSubmitting={isSubmitting}
        errorMessage={errorMessage}
        setErrorMessage={setErrorMessage}
        trustDevice={trustDevice}
        setTrustDevice={setTrustDevice}
        supportsPasskeys={supportsPasskeys}
        passkeyStatus={passkeyStatus}
        isPasskeyBusy={isPasskeyBusy}
        activePasskeyAction={activePasskeyAction}
        showHostSwitcher={showHostSwitcher}
        onSubmit={handleSubmit}
        onPasskeyUnlock={handlePasskeyUnlock}
        onPasskeySetupOnly={handlePasskeySetupOnly}
      />
    );
  }

  return <>{children}</>;
};
