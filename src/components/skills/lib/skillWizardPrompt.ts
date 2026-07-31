import type { NormalizedMessage } from '../../../stores/useSessionStore';

export interface SkillWizardDraft {
  name: string;
  description: string;
  content: string;
}

const MAX_TRANSCRIPT_CHARS = 8000;
const TRUNCATION_NOTE = '[earlier messages omitted]';

/**
 * Flatten chat messages into a plain-text transcript for seeding the wizard
 * brief. Only finalized text rows survive; the result is capped at
 * MAX_TRANSCRIPT_CHARS by dropping the oldest messages first.
 */
export function flattenTranscript(messages: NormalizedMessage[]): string {
  const lines = messages
    .filter((message) => (
      message.kind === 'text'
      && typeof message.content === 'string'
      && message.content.trim().length > 0
    ))
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${(message.content as string).trim()}`);

  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const next = total + lines[index].length + 1;
    if (next > MAX_TRANSCRIPT_CHARS && kept.length > 0) {
      break;
    }
    kept.unshift(lines[index]);
    total = next;
  }

  const truncated = kept.length < lines.length;
  return (truncated ? `${TRUNCATION_NOTE}\n` : '') + kept.join('\n');
}

const WIZARD_BRIEF = `You are a skill author for the Claude Code / Codex / Grok / Kimi skills system. Help me design a new agent skill through a short conversation.

A skill is a single SKILL.md file:
- YAML front matter between \`---\` lines:
  - \`name:\` the skill name in kebab-case (e.g. \`pr-review-checklist\`).
  - \`description:\` one line stating what the skill does AND when to use it — this is what an agent reads to decide whether to invoke the skill.
- A markdown body with: when to use the skill, step-by-step instructions or a checklist to follow, and the expected output format.

Rules for this conversation:
1. Interview me briefly first. Ask 1-3 sharp questions at a time (purpose, trigger situations, constraints, expected output). Keep every message short.
2. When you are confident you understand the skill, emit the COMPLETE skill as a single fenced \`\`\`markdown code block containing the full SKILL.md (front matter + body). Put nothing else structural around the block — a one-line lead-in is fine.
3. On every revision, re-emit the full updated block — never a partial diff.

Start by introducing yourself in one sentence and asking your first questions.`;

const TRANSCRIPT_SECTION = `## Source conversation

Below is a conversation I just had. Distill the reusable procedure or knowledge from it into a skill. You already have this context, so you may skip straight to a draft — ask at most one confirming question first.`;

/**
 * Build the hidden first message of a wizard session: the skill-author brief,
 * optionally seeded with a flattened source conversation to distill.
 */
export function buildWizardBrief(opts: { transcript?: string }): string {
  const transcript = opts.transcript?.trim();
  if (!transcript) {
    return WIZARD_BRIEF;
  }
  return `${WIZARD_BRIEF}\n\n${TRANSCRIPT_SECTION}\n\n${transcript}`;
}

// Fenced code blocks tagged ```markdown / ```md, or bare ``` — the output
// contract stated in the brief.
const OPEN_FENCE = /^```(?:markdown|md)?$/i;
const CLOSE_FENCE = /^```$/;

const toKebabCase = (value: string): string => (
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
);

/**
 * Line-parse the YAML-ish front matter a SKILL.md starts with. Intentionally
 * minimal — the wizard only needs `name` and `description`, and pulling in a
 * YAML dependency for two keys is not worth it.
 */
const parseFrontMatter = (content: string): { name: string; description: string } | null => {
  const lines = content.replace(/^\uFEFF/, '').split('\n');
  if (lines[0]?.trim() !== '---') {
    return null;
  }

  let name = '';
  let description = '';
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === '---') {
      break;
    }
    const match = line.match(/^([A-Za-z][A-Za-z-]*):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    const key = match[1].toLowerCase();
    if (key === 'name') {
      name = value;
    } else if (key === 'description') {
      description = value;
    }
  }

  return name && description ? { name, description } : null;
};

/**
 * Split a full SKILL.md into its front-matter `name`/`description` and the
 * body with the leading `---` block removed — the shape SkillEditorDialog's
 * `initialDraft` expects for the wizard handoff. Missing front matter yields
 * empty strings, with the whole content kept as the body.
 */
export function splitSkillMarkdown(content: string): { name: string; description: string; body: string } {
  const frontMatter = parseFrontMatter(content) ?? { name: '', description: '' };
  const lines = content.replace(/^\uFEFF/, '').split('\n');

  let body = content;
  if (lines[0]?.trim() === '---') {
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closingIndex > 0) {
      body = lines.slice(closingIndex + 1).join('\n').trim();
    }
  }

  return { ...frontMatter, body };
}

/**
 * Scan assistant output for the skill draft the brief asks for: a fenced
 * markdown block whose content opens with front matter carrying both `name:`
 * and `description:`. Returns the LAST valid match (later blocks are
 * revisions), with `name` normalized to kebab-case and `content` holding the
 * full SKILL.md text. Null when no valid block exists.
 *
 * The SKILL.md body commonly contains its own nested example fences (e.g. a
 * ```bash snippet). A naive non-greedy regex would stop at that inner
 * closing fence instead of the real outer one, silently truncating the
 * draft. This walks line-by-line and tracks fence depth: a tagged fence
 * (```bash, ```js, ...) opens a nested block, a bare ``` closes one — so the
 * outer block's true end is only reached once depth returns to zero.
 */
export function extractSkillDraft(text: string): SkillWizardDraft | null {
  const lines = text.split('\n');
  let draft: SkillWizardDraft | null = null;
  let i = 0;

  while (i < lines.length) {
    if (!OPEN_FENCE.test(lines[i].trim())) {
      i++;
      continue;
    }

    const openIndex = i;
    let depth = 1;
    let j = openIndex + 1;
    for (; j < lines.length && depth > 0; j++) {
      const trimmed = lines[j].trim();
      if (!trimmed.startsWith('```')) {
        continue;
      }
      depth += CLOSE_FENCE.test(trimmed) ? -1 : 1;
    }

    if (depth !== 0) {
      // Unterminated block (still streaming) — nothing more to find.
      break;
    }

    const closeIndex = j - 1;
    const content = lines.slice(openIndex + 1, closeIndex).join('\n').trim();
    const frontMatter = parseFrontMatter(content);
    if (frontMatter) {
      const name = toKebabCase(frontMatter.name);
      if (name) {
        draft = { name, description: frontMatter.description, content };
      }
    }
    i = closeIndex + 1;
  }

  return draft;
}
