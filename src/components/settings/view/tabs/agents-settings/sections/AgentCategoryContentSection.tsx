import type { AgentCategoryContentSectionProps } from '../types';

import AccountContent from './content/AccountContent';
import ModelsContent from './content/ModelsContent';
import PermissionsContent from './content/PermissionsContent';

export default function AgentCategoryContentSection({
  selectedAgent,
  selectedCategory,
  agentContextById,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  grokPermissions,
  onGrokPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  piPermissionMode,
  onPiPermissionModeChange,
}: AgentCategoryContentSectionProps) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-4">
      {selectedCategory === 'account' && (
        <AccountContent
          agent={selectedAgent}
          authStatus={agentContextById[selectedAgent].authStatus}
          onLogin={agentContextById[selectedAgent].onLogin}
          onRefresh={agentContextById[selectedAgent].onRefresh}
        />
      )}

      {selectedCategory === 'models' && (
        <ModelsContent agent={selectedAgent} />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'claude' && (
        <PermissionsContent
          agent="claude"
          skipPermissions={claudePermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, skipPermissions: value });
          }}
          allowedTools={claudePermissions.allowedTools}
          onAllowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, allowedTools: value });
          }}
          disallowedTools={claudePermissions.disallowedTools}
          onDisallowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, disallowedTools: value });
          }}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'cursor' && (
        <PermissionsContent
          agent="cursor"
          skipPermissions={cursorPermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, skipPermissions: value });
          }}
          allowedCommands={cursorPermissions.allowedCommands}
          onAllowedCommandsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, allowedCommands: value });
          }}
          disallowedCommands={cursorPermissions.disallowedCommands}
          onDisallowedCommandsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, disallowedCommands: value });
          }}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'codex' && (
        <PermissionsContent
          agent="codex"
          permissionMode={codexPermissionMode}
          onPermissionModeChange={onCodexPermissionModeChange}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'pi' && (
        <PermissionsContent
          agent="pi"
          permissionMode={piPermissionMode}
          onPermissionModeChange={onPiPermissionModeChange}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'grok' && (
        <PermissionsContent
          agent="grok"
          skipPermissions={grokPermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onGrokPermissionsChange({ ...grokPermissions, skipPermissions: value });
          }}
          allowedCommands={grokPermissions.allowedCommands}
          onAllowedCommandsChange={(value) => {
            onGrokPermissionsChange({ ...grokPermissions, allowedCommands: value });
          }}
          disallowedCommands={grokPermissions.disallowedCommands}
          onDisallowedCommandsChange={(value) => {
            onGrokPermissionsChange({ ...grokPermissions, disallowedCommands: value });
          }}
        />
      )}

      {selectedCategory === 'account' && (
        <p className="mt-6 text-xs text-muted-foreground">
          MCP servers and Skills are managed under Settings → MCP and Settings → Skills
          (define once in CloudCLI, enable per agent).
        </p>
      )}
    </div>
  );
}
