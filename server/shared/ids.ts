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

const encodeRandomValue = (value: bigint): string => {
  const chars = new Array<string>(16);
  let rest = value;
  for (let index = 15; index >= 0; index -= 1) {
    chars[index] = CROCKFORD[Number(rest % 32n)];
    rest /= 32n;
  }
  return chars.join('');
};

const randomValue = (): bigint => {
  const bytes = randomBytes(10); // 80 bits
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  return value;
};

const MAX_RANDOM = (1n << 80n) - 1n;
let lastTime = -1;
let lastRandom = 0n;

/**
 * Monotonic within a millisecond (ULID spec): ids minted in the same ms increment the
 * random part instead of re-rolling it, so `ORDER BY id` matches creation order.
 * An explicit `now` in the past (tests, backfills) gets fresh randomness.
 */
export const ulid = (now: number = Date.now()): string => {
  if (now === lastTime && lastRandom < MAX_RANDOM) {
    lastRandom += 1n;
  } else if (now >= lastTime) {
    lastTime = now;
    lastRandom = randomValue();
  } else {
    return `${encodeTime(now)}${encodeRandomValue(randomValue())}`;
  }
  return `${encodeTime(lastTime)}${encodeRandomValue(lastRandom)}`;
};

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
export const newRelayBatchId = (): string => `rbatch_${ulid()}`;
export const newRelayJobId = (): string => `relay_${ulid()}`;
export const newRelayApprovalId = (): string => `rappr_${ulid()}`;
export const newPrototypeId = (): string => `proto_${ulid()}`;
export const newEvalSuiteId = (): string => `esuite_${ulid()}`;
export const newEvalCaseId = (): string => `ecase_${ulid()}`;
export const newEvalGraderId = (): string => `egrader_${ulid()}`;
export const newEvalTrialId = (): string => `etrial_${ulid()}`;
export const newEvalGradeId = (): string => `egrade_${ulid()}`;
export const newHookId = (): string => `hook_${ulid()}`;
export const newBotEventId = (): string => `bev_${ulid()}`;
export const newBotGoalId = (): string => `bgl_${ulid()}`;
export const newBotCommitmentId = (): string => `bcm_${ulid()}`;
export const newBotEpisodeId = (): string => `bep_${ulid()}`;
export const newBotRuleId = (): string => `brl_${ulid()}`;
export const newBotGateDecisionId = (): string => `bgd_${ulid()}`;
export const newBotProposalId = (): string => `bpr_${ulid()}`;
export const newBotThreadMessageId = (): string => `btm_${ulid()}`;
export const newBotTeamId = (): string => `btt_${ulid()}`;
export const newBotSkillLinkId = (): string => `bsk_${ulid()}`;
export const newBotTriggerId = (): string => `btr_${ulid()}`;
export const newBotChannelId = (): string => `bch_${ulid()}`;
export const newBotSpaceId = (): string => `bsp_${ulid()}`;
