import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotRule } from '../../../../types/botRuntime';
import { EmptyLine, ErrorLine, Panel, SkeletonRows, WarnLine } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';
import { useRemote } from '../panel/useRemote';

import RuleForm from './RuleForm';
import RuleRow from './RuleRow';
import { sortRules } from './ruleHelpers';

type Editing = { mode: 'closed' } | { mode: 'new' } | { mode: 'edit'; ruleId: string };

/** This bot's rules plus the global ones, with create, edit and delete. */
export default function RulesPanel({ botId, now }: { botId: string; now: number }) {
  const { data, error, loading, setData, reload } = useRemote(() => botRuntimeApi.gate.listRules({ botId, includeGlobal: true }), botId);
  const action = useAsyncAction();
  const [editing, setEditing] = useState<Editing>({ mode: 'closed' });
  const [warnings, setWarnings] = useState<string[]>([]);
  const rules = useMemo(() => sortRules(data ?? []), [data]);
  const editingRule = editing.mode === 'edit' ? rules.find((rule) => rule.rule_id === editing.ruleId) ?? null : null;

  const saved = (rule: BotRule, nextWarnings: string[]) => {
    setData((current) => {
      const list = current ?? [];
      return list.some((entry) => entry.rule_id === rule.rule_id) ? list.map((entry) => (entry.rule_id === rule.rule_id ? rule : entry)) : [rule, ...list];
    });
    setWarnings(nextWarnings);
    setEditing({ mode: 'closed' });
  };

  const remove = (rule: BotRule) => {
    const scopeNote = rule.scope === 'global' ? ' It is a global rule and applies to every bot.' : '';
    if (!window.confirm(`Delete this ${rule.decision} rule?${scopeNote}`)) return;
    void action.run(rule.rule_id, async () => {
      await botRuntimeApi.gate.deleteRule(rule.rule_id);
      setData((current) => (current ?? []).filter((entry) => entry.rule_id !== rule.rule_id));
    });
  };

  return (
    <Panel
      title="Rules"
      description="Matching rules decide before the defaults do. Highest priority wins; this bot's rules come before global ones."
      actions={<button type="button" className="button button-primary min-h-8" onClick={() => { setWarnings([]); setEditing({ mode: 'new' }); }} disabled={editing.mode === 'new'}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add rule</button>}
    >
      <div className="space-y-2">
        {editing.mode === 'new' ? <RuleForm botId={botId} rule={null} onSaved={saved} onCancel={() => setEditing({ mode: 'closed' })} /> : null}
        {editing.mode === 'edit' && editingRule ? <RuleForm key={editingRule.rule_id} botId={botId} rule={editingRule} onSaved={saved} onCancel={() => setEditing({ mode: 'closed' })} /> : null}
        {warnings.map((warning) => <WarnLine key={warning}>{warning}</WarnLine>)}
        <ErrorLine message={action.error} />
        {loading && !data ? <SkeletonRows /> : null}
        {error ? (
          <div className="space-y-1.5">
            <ErrorLine message={error} />
            <button type="button" className="button min-h-8" onClick={() => void reload()}>Retry</button>
          </div>
        ) : null}
        {data && rules.length === 0 ? <EmptyLine>No rules. Defaults apply: reads and drafts run, the safety floor and unclassified tools ask.</EmptyLine> : null}
        {rules.length > 0 ? (
          <ul className="space-y-2">
            {rules.map((rule) => (
              <RuleRow key={rule.rule_id} rule={rule} now={now} busy={action.isBusy(rule.rule_id)} onEdit={() => { setWarnings([]); setEditing({ mode: 'edit', ruleId: rule.rule_id }); }} onDelete={() => remove(rule)} />
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
