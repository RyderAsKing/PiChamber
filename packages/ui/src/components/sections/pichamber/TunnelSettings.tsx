import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SettingsSection, SETTINGS_FIELD_LABEL_CLASS } from '@/components/sections/shared/SettingsSection';
import { ProviderOptionLabel } from './tunnel/ProviderOptionLabel';
import { TunnelAccessLinksCard } from './tunnel/TunnelAccessLinksCard';
import { TunnelDependencyMissingCard } from './tunnel/TunnelDependencyMissingCard';
import { TunnelTtlControls } from './tunnel/TunnelTtlControls';
import { ManagedRemoteTunnelsPanel } from './tunnel/ManagedRemoteTunnelsPanel';
import { ManagedLocalTunnelPanel } from './tunnel/ManagedLocalTunnelPanel';
import { TunnelStartControls } from './tunnel/TunnelStartControls';
import { TunnelActiveCard } from './tunnel/TunnelActiveCard';
import { useTunnelSettingsState } from './tunnel/useTunnelSettingsState';

export const TunnelSettings: React.FC = () => {
  const {
    timeFormatPreference,
    state,
    tunnelInfo,
    qrDataUrl,
    errorMessage,
    managedRemoteValidationError,
    setManagedRemoteValidationError,
    copied,
    isSavingTtl,
    isSavingMode,
    tunnelMode,
    managedLocalConfigPath,
    managedRemoteTunnelPresets,
    expandedManagedRemoteTunnels,
    setExpandedManagedRemoteTunnels,
    selectedPresetId,
    sessionTokensByPresetId,
    setSessionTokensByPresetId,
    savedTokenPresetIds,
    isAddingPreset,
    setIsAddingPreset,
    newPresetName,
    setNewPresetName,
    newPresetHostname,
    setNewPresetHostname,
    newPresetToken,
    setNewPresetToken,
    bootstrapTtlMs,
    sessionTtlMs,
    remainingText,
    managedLocalConfigExtensionError,
    managedLocalConfigFileInputRef,
    isManagedLocalConfigPathInvalid,
    selectedPreset,
    renderedSessionRecords,
    isConnectLinkLive,
    isSelectedModeTunnelReady,
    willReplaceActiveTunnel,
    suggestedConnectorPort,
    tunnelModeOptions,
    providerSupportsManagedModes,
    displayedDependencyInstallInfo,
    openExternal,
    handleBrowseManagedLocalConfig,
    handleManagedLocalConfigInputChange,
    handleManagedLocalConfigInputBlur,
    handleManagedLocalConfigClear,
    handleManagedLocalConfigFileSelected,
    handleStart,
    handleStop,
    handleCopyUrl,
    handleBootstrapTtlChange,
    handleSessionTtlChange,
    handleModeChange,
    handleSelectPreset,
    handleSaveNewPreset,
    handleRemovePreset,
    persistManagedRemoteTunnelToken,
  } = useTunnelSettingsState();

  const primaryCtaClass =
    'gap-2 border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)] hover:text-[var(--primary-foreground)]';

  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-busy-pulse" aria-label={"Loading"} />
      </div>
    );
  }

  return (
    <SettingsSection
      title={"External Tunnel"}
      info={(
        <div className="space-y-1">
          <p>{"Configure secure remote access with quick links or your own managed remote Cloudflare tunnel."}</p>
          <p>{"Secure tunnel access is enforced server-side."}</p>
          <p>{"Connect links are one-time and are revoked when tunnel stops or connect-link TTL expires."}</p>
        </div>
      )}
      divider={false}
    >
      <div className="space-y-6">
        <TunnelAccessLinksCard
          records={renderedSessionRecords}
          timeFormatPreference={timeFormatPreference}
        />

        {state === 'not-available' && (
          <TunnelDependencyMissingCard installInfo={displayedDependencyInstallInfo} />
        )}

        <section className="space-y-4 px-2 pb-2 pt-0">
          <div className="space-y-3">
            <div data-settings-item="tunnel.provider" className="space-y-1.5">
              <p className={SETTINGS_FIELD_LABEL_CLASS}>{"Provider"}</p>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <ProviderOptionLabel provider="cloudflare" />
              </div>
            </div>

            <div data-settings-item="tunnel.type" className="space-y-1.5">
              <p className={SETTINGS_FIELD_LABEL_CLASS}>{"Tunnel type"}</p>
              <div className="flex flex-wrap items-center gap-1">
                {tunnelModeOptions.map((option) => (
                  <Tooltip key={option.value}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="chip"
                        size="xs"
                        aria-pressed={tunnelMode === option.value}
                        className="!font-normal"
                        onClick={() => {
                          void handleModeChange(option.value);
                        }}
                        disabled={isSavingMode || state === 'starting' || state === 'stopping'}
                      >
                        {option.label}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {option.tooltip}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>

          <TunnelTtlControls
            bootstrapTtlMs={bootstrapTtlMs}
            sessionTtlMs={sessionTtlMs}
            tunnelMode={tunnelMode}
            disabled={isSavingTtl || isSavingMode || state === 'starting' || state === 'stopping'}
            providerSupportsManagedModes={providerSupportsManagedModes}
            onBootstrapTtlChange={(value) => {
              void handleBootstrapTtlChange(value);
            }}
            onSessionTtlChange={(value) => {
              void handleSessionTtlChange(value);
            }}
          />

          {tunnelMode === 'managed-remote' && (
            <ManagedRemoteTunnelsPanel
              suggestedConnectorPort={suggestedConnectorPort}
              managedRemoteTunnelPresets={managedRemoteTunnelPresets}
              expandedManagedRemoteTunnels={expandedManagedRemoteTunnels}
              sessionTokensByPresetId={sessionTokensByPresetId}
              savedTokenPresetIds={savedTokenPresetIds}
              disabled={state === 'starting' || state === 'stopping' || isSavingMode}
              isAddingPreset={isAddingPreset}
              newPresetName={newPresetName}
              newPresetHostname={newPresetHostname}
              newPresetToken={newPresetToken}
              managedRemoteValidationError={managedRemoteValidationError}
              selectedPreset={selectedPreset}
              onToggleAddPreset={() => setIsAddingPreset((prev) => !prev)}
              onCancelAddPreset={() => {
                setIsAddingPreset(false);
                setNewPresetName('');
                setNewPresetHostname('');
                setNewPresetToken('');
              }}
              onNewPresetNameChange={setNewPresetName}
              onNewPresetHostnameChange={setNewPresetHostname}
              onNewPresetTokenChange={setNewPresetToken}
              onSaveNewPreset={() => {
                void handleSaveNewPreset();
              }}
              onTogglePresetCollapse={(presetId, open) => {
                setExpandedManagedRemoteTunnels((prev) => ({ ...prev, [presetId]: open }));
                if (open) {
                  void handleSelectPreset(presetId);
                }
              }}
              onRemovePreset={(presetId) => {
                void handleRemovePreset(presetId);
              }}
              onPresetTokenChange={(presetId, nextValue) => {
                setManagedRemoteValidationError(null);
                setSessionTokensByPresetId((prev) => ({ ...prev, [presetId]: nextValue }));
              }}
              onPersistToken={(params) => {
                void persistManagedRemoteTunnelToken(params);
              }}
            />
          )}

          {tunnelMode === 'managed-local' && (
            <ManagedLocalTunnelPanel
              managedLocalConfigPath={managedLocalConfigPath}
              isManagedLocalConfigPathInvalid={isManagedLocalConfigPathInvalid}
              managedLocalConfigExtensionError={managedLocalConfigExtensionError}
              disabled={state === 'starting' || state === 'stopping' || isSavingMode}
              fileInputRef={managedLocalConfigFileInputRef}
              onInputChange={handleManagedLocalConfigInputChange}
              onInputBlur={() => {
                void handleManagedLocalConfigInputBlur();
              }}
              onBrowse={() => {
                void handleBrowseManagedLocalConfig();
              }}
              onClear={() => {
                void handleManagedLocalConfigClear();
              }}
              onFileSelected={(event) => {
                void handleManagedLocalConfigFileSelected(event);
              }}
            />
          )}

          {!isSelectedModeTunnelReady && (
            <TunnelStartControls
              tunnelMode={tunnelMode}
              selectedPresetId={selectedPresetId}
              managedRemoteTunnelPresets={managedRemoteTunnelPresets}
              selectedPreset={selectedPreset}
              willReplaceActiveTunnel={willReplaceActiveTunnel}
              state={state}
              isSavingMode={isSavingMode}
              isManagedLocalConfigPathInvalid={isManagedLocalConfigPathInvalid}
              primaryCtaClass={primaryCtaClass}
              onSelectPreset={(presetId) => {
                void handleSelectPreset(presetId);
              }}
              onStart={handleStart}
              onOpenDocUrl={(url) => {
                void openExternal(url);
              }}
            />
          )}
        </section>

        {isSelectedModeTunnelReady && tunnelInfo && (
          <TunnelActiveCard
            tunnelInfo={tunnelInfo}
            isConnectLinkLive={isConnectLinkLive}
            copied={copied}
            onCopyUrl={handleCopyUrl}
            remainingText={remainingText}
            qrDataUrl={qrDataUrl}
            onNewConnectLink={handleStart}
            onStop={handleStop}
            stopping={state === 'stopping'}
            isSavingMode={isSavingMode}
            isManagedLocalConfigPathInvalid={isManagedLocalConfigPathInvalid}
            tunnelMode={tunnelMode}
            primaryCtaClass={primaryCtaClass}
          />
        )}

        {state === 'error' && errorMessage && (
          <section className="space-y-3 px-2 pb-2 pt-0">
            <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
            <Button size="sm" variant="ghost" onClick={handleStart}>{"Retry"}</Button>
          </section>
        )}
      </div>
    </SettingsSection>
  );
};
