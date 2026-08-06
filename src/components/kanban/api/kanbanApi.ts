import { authenticatedFetch } from '../../../utils/api';
import type {
  KanbanBoard,
  KanbanColumn,
  KanbanRun,
  KanbanTask,
  KanbanTaskComment,
  KanbanTaskStatus,
  KanbanTaskTools,
  ProjectRef,
} from '../types';
import type { LLMProvider } from '../../../types/app';

const BASE = '/api/kanban';

// Defensive normalizers: the UI reads `.length`/iterates these fields, so we
// coerce anything the API returns (or a stale server omits) into safe shapes.
function normalizeBoard(board: KanbanBoard): KanbanBoard {
  return {
    ...board,
    columns: Array.isArray(board?.columns) ? board.columns : [],
  };
}

function normalizeTask(task: KanbanTask): KanbanTask {
  return {
    ...task,
    tools: task?.tools && typeof task.tools === 'object' ? task.tools : {},
    dependsOn: Array.isArray(task?.dependsOn) ? task.dependsOn : [],
    review_provider: task?.review_provider ?? null,
    implement_profile_id: task?.implement_profile_id ?? null,
    review_profile_id: task?.review_profile_id ?? null,
    due_date: task?.due_date ?? null,
    feature_branch: task?.feature_branch ?? null,
  };
}

function normalizeTasks(tasks: KanbanTask[] | undefined): KanbanTask[] {
  return Array.isArray(tasks) ? tasks.map(normalizeTask) : [];
}

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
  reviewProvider?: LLMProvider | null;
  implementProfileId?: string | null;
  reviewProfileId?: string | null;
  permissionMode?: string;
  tools?: KanbanTaskTools;
  scheduleCron?: string | null;
  dueDate?: string | null;
  status?: KanbanTaskStatus;
};

export const kanbanApi = {
  async getBoard(boardId: string): Promise<{ board: KanbanBoard; tasks: KanbanTask[] }> {
    const res = await authenticatedFetch(`${BASE}/boards/${boardId}`);
    const data = await parse<{ board: KanbanBoard; tasks?: KanbanTask[] }>(res);
    return { board: normalizeBoard(data.board), tasks: normalizeTasks(data.tasks) };
  },

  async getGlobalBoard(): Promise<{ board: KanbanBoard; tasks: KanbanTask[] }> {
    const res = await authenticatedFetch(`${BASE}/global`);
    const data = await parse<{ board: KanbanBoard; tasks?: KanbanTask[] }>(res);
    return { board: normalizeBoard(data.board), tasks: normalizeTasks(data.tasks) };
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
        path: String(p.path ?? p.fullPath ?? p.project_path ?? '') || undefined,
      }))
      .filter((p) => p.projectId);
  },

  async updateBoard(boardId: string, patch: { name?: string; columns?: KanbanColumn[] }): Promise<KanbanBoard> {
    const res = await authenticatedFetch(`${BASE}/boards/${boardId}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    const data = await parse<{ board: KanbanBoard }>(res);
    return normalizeBoard(data.board);
  },

  async createTask(input: {
    boardId: string;
    projectId: string;
    title: string;
    description?: string;
    prompt?: string;
    columnId?: string;
    assigneeProvider?: LLMProvider | null;
    reviewProvider?: LLMProvider | null;
    implementProfileId?: string | null;
    reviewProfileId?: string | null;
    permissionMode?: string;
    tools?: KanbanTaskTools;
    scheduleCron?: string | null;
    dueDate?: string | null;
  }): Promise<KanbanTask> {
    const res = await authenticatedFetch(`${BASE}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parse<{ task: KanbanTask }>(res);
    return normalizeTask(data.task);
  },

  /**
   * Ask a provider to expand title/notes into an exhaustive description and
   * an implementer prompt for the TaskEditor.
   */
  async generateTaskFields(input: {
    title: string;
    notes?: string;
    description?: string;
    prompt?: string;
    provider: LLMProvider;
    projectId?: string | null;
  }): Promise<{ description: string; prompt: string; provider: LLMProvider }> {
    const res = await authenticatedFetch(`${BASE}/generate-task-fields`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parse<{
      description: string;
      prompt: string;
      provider: LLMProvider;
    }>(res);
    return {
      description: data.description ?? '',
      prompt: data.prompt ?? '',
      provider: data.provider,
    };
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
    return normalizeTask(data.task);
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
    return normalizeTask(data.task);
  },

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<KanbanTask> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}/deps/${dependsOnTaskId}`, {
      method: 'DELETE',
    });
    const data = await parse<{ task: KanbanTask }>(res);
    return normalizeTask(data.task);
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

  async listComments(taskId: string): Promise<KanbanTaskComment[]> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}/comments`);
    const data = await parse<{ comments: KanbanTaskComment[] }>(res);
    return Array.isArray(data.comments) ? data.comments : [];
  },

  async addComment(taskId: string, body: string, author?: string | null): Promise<KanbanTaskComment> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, author: author ?? undefined }),
    });
    const data = await parse<{ comment: KanbanTaskComment }>(res);
    return data.comment;
  },

  async deleteComment(taskId: string, commentId: string): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/tasks/${taskId}/comments/${commentId}`, {
      method: 'DELETE',
    });
    await parse(res);
  },
};
