import { authenticatedFetch } from '../../../utils/api';
import type {
  KanbanBoard,
  KanbanColumn,
  KanbanRun,
  KanbanTask,
  KanbanTaskStatus,
  KanbanTaskTools,
  ProjectRef,
} from '../types';
import type { LLMProvider } from '../../../types/app';

const BASE = '/api/kanban';

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorObj = payload?.error;
    const message =
      (errorObj && typeof errorObj === 'object' && typeof errorObj.message === 'string'
        ? errorObj.message
        : typeof errorObj === 'string'
          ? errorObj
          : typeof payload?.message === 'string'
            ? payload.message
            : null) || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export type TaskPatch = {
  title?: string;
  description?: string;
  prompt?: string;
  projectId?: string;
  columnId?: string;
  position?: number;
  assigneeProvider?: LLMProvider | null;
  permissionMode?: string;
  tools?: KanbanTaskTools;
  scheduleCron?: string | null;
  status?: KanbanTaskStatus;
};

export const kanbanApi = {
  async listBoards(projectId: string): Promise<KanbanBoard[]> {
    const res = await authenticatedFetch(`${BASE}/boards?projectId=${encodeURIComponent(projectId)}`);
    const data = await parse<{ boards: KanbanBoard[] }>(res);
    return data.boards;
  },

  async createBoard(projectId: string, name: string, columns?: KanbanColumn[]): Promise<KanbanBoard> {
    const res = await authenticatedFetch(`${BASE}/boards`, {
      method: 'POST',
      body: JSON.stringify({ projectId, name, columns }),
    });
    const data = await parse<{ board: KanbanBoard }>(res);
    return data.board;
  },

  async getBoard(boardId: string): Promise<{ board: KanbanBoard; tasks: KanbanTask[] }> {
    const res = await authenticatedFetch(`${BASE}/boards/${boardId}`);
    return parse<{ board: KanbanBoard; tasks: KanbanTask[] }>(res);
  },

  async getGlobalBoard(): Promise<{ board: KanbanBoard; tasks: KanbanTask[] }> {
    const res = await authenticatedFetch(`${BASE}/global`);
    return parse<{ board: KanbanBoard; tasks: KanbanTask[] }>(res);
  },

  async listProjects(): Promise<ProjectRef[]> {
    const res = await authenticatedFetch('/api/projects?skipSync=1');
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return [];
    }
    const raw = Array.isArray(payload) ? payload : (payload?.projects ?? []);
    return (raw as Record<string, unknown>[])
      .map((p) => ({
        projectId: String(p.projectId ?? p.project_id ?? ''),
        displayName: String(p.displayName ?? p.custom_project_name ?? p.projectId ?? 'Project'),
      }))
      .filter((p) => p.projectId);
  },

  async updateBoard(boardId: string, patch: { name?: string; columns?: KanbanColumn[] }): Promise<KanbanBoard> {
    const res = await authenticatedFetch(`${BASE}/boards/${boardId}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    const data = await parse<{ board: KanbanBoard }>(res);
    return data.board;
  },

  async deleteBoard(boardId: string): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/boards/${boardId}`, { method: 'DELETE' });
    await parse(res);
  },

  async createTask(input: {
    boardId: string;
    projectId?: string;
    title: string;
    description?: string;
    prompt?: string;
    columnId?: string;
    assigneeProvider?: LLMProvider | null;
    permissionMode?: string;
    tools?: KanbanTaskTools;
    scheduleCron?: string | null;
  }): Promise<KanbanTask> {
    const res = await authenticatedFetch(`${BASE}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parse<{ task: KanbanTask }>(res);
    return data.task;
  },

  async getTask(taskId: string): Promise<{ task: KanbanTask; runs: KanbanRun[] }> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}`);
    return parse<{ task: KanbanTask; runs: KanbanRun[] }>(res);
  },

  async updateTask(taskId: string, patch: TaskPatch): Promise<KanbanTask> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    const data = await parse<{ task: KanbanTask }>(res);
    return data.task;
  },

  async deleteTask(taskId: string): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}`, { method: 'DELETE' });
    await parse(res);
  },

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<KanbanTask> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}/deps`, {
      method: 'POST',
      body: JSON.stringify({ dependsOnTaskId }),
    });
    const data = await parse<{ task: KanbanTask }>(res);
    return data.task;
  },

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<KanbanTask> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}/deps/${dependsOnTaskId}`, {
      method: 'DELETE',
    });
    const data = await parse<{ task: KanbanTask }>(res);
    return data.task;
  },

  async listRuns(taskId: string): Promise<KanbanRun[]> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}/runs`);
    const data = await parse<{ runs: KanbanRun[] }>(res);
    return data.runs;
  },

  async runTask(taskId: string): Promise<{ run: KanbanRun; task: KanbanTask }> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}/run`, { method: 'POST' });
    return parse<{ run: KanbanRun; task: KanbanTask }>(res);
  },
};
