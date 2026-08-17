import { randomBytes } from 'node:crypto';

/**
 * Prefixed, sortable entity IDs for the CloudCLI run spine (PRD §4.2).
 *
 * Format: `<prefix>_<ulid>` where ULID is 26 chars of Crockford base32
 * (48-bit timestamp ms + 80-bit randomness), lexicographically sortable by
 * creation time. No external dependency — encoded from node:crypto bytes.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const encodeTime = (now: number): string => {
  let time = BigInt(now);
  const chars = new Array<string>(10);
  for (let index = 9; index >= 0; index -= 1) {
    chars[index] = CROCKFORD[Number(time % 32n)];
    time /= 32n;
  }
  return chars.join('');
};

const encodeRandom = (): string => {
  const bytes = randomBytes(10); // 80 bits
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  const chars = new Array<string>(16);
  for (let index = 15; index >= 0; index -= 1) {
    chars[index] = CROCKFORD[Number(value % 32n)];
    value /= 32n;
  }
  return chars.join('');
};

export const ulid = (now: number = Date.now()): string => `${encodeTime(now)}${encodeRandom()}`;

export const newEventId = (): string => `evt_${ulid()}`;
export const newRunId = (): string => `run_${ulid()}`;
export const newWorkspaceId = (): string => `ws_${ulid()}`;
export const newSecretId = (): string => `sec_${ulid()}`;
export const newInterruptId = (): string => `int_${ulid()}`;
export const newPackId = (): string => `pack_${ulid()}`;
export const newRecipeId = (): string => `rec_${ulid()}`;
export const newPlaybookId = (): string => `pb_${ulid()}`;
export const newAutomationRunId = (): string => `arun_${ulid()}`;
export const newSwarmId = (): string => `swarm_${ulid()}`;
export const newSwarmMemberId = (): string => `smem_${ulid()}`;
export const newPrototypeId = (): string => `proto_${ulid()}`;
export const newEvalSuiteId = (): string => `esuite_${ulid()}`;
export const newEvalCaseId = (): string => `ecase_${ulid()}`;
export const newEvalGraderId = (): string => `egrader_${ulid()}`;
export const newEvalTrialId = (): string => `etrial_${ulid()}`;
export const newEvalGradeId = (): string => `egrade_${ulid()}`;
