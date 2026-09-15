import { hooksStore } from '@/modules/hooks/hooks.store.js';
import type { CloudcliHook, CloudcliHookCreateInput, CloudcliHookUpdateInput } from '@/modules/hooks/hooks.types.js';

export const hooksService = {
  list(): CloudcliHook[] {
    return hooksStore.list();
  },

  get(id: string): CloudcliHook | null {
    return hooksStore.get(id);
  },

  create(input: CloudcliHookCreateInput): CloudcliHook {
    return hooksStore.create(input);
  },

  update(id: string, patch: CloudcliHookUpdateInput): CloudcliHook {
    return hooksStore.update(id, patch);
  },

  remove(id: string): void {
    hooksStore.remove(id);
  },
};
