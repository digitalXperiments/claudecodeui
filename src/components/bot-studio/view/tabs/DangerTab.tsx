import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Bot } from '../../types';
import { Button } from '../../../../shared/view/ui';

export default function DangerTab({ bot, onDelete }: { bot: Bot; onDelete: () => void }) { return <div className="max-w-2xl p-4 sm:p-6"><div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4"><div className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4" /><p className="text-sm font-semibold">Delete {bot.title}</p></div><p className="mt-2 text-xs leading-5 text-muted-foreground">This removes the bot configuration. Existing inbox history may remain available through the underlying Mission Control records.</p><Button className="mt-4" variant="destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />Delete bot</Button></div></div>; }
