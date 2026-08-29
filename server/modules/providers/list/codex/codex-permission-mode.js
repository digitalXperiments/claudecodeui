/**
 * Map CloudCLI permissionMode onto Codex app-server sandbox + approvalPolicy.
 *
 * Unattended plan (Relay/swarm explorers) uses a read-only sandbox and never
 * prompts — asking on every `ls` only parks a lead that cannot usefully
 * answer. Interactive plan still asks the user.
 */
export function mapPermissionModeToCodexOptions(permissionMode, { unattended = false } = {}) {
  switch (permissionMode) {
    case 'auto':
    case 'acceptEdits':
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      };
    case 'plan':
      return unattended
        ? {
          sandbox: 'read-only',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
        }
        : {
          sandbox: 'read-only',
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
        };
    case 'bypassPermissions':
      return {
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
      };
    case 'default':
    default:
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
      };
  }
}
