import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Lock, RefreshCw } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import type {
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from "../../../../types/app";
import { useAgentVisibility } from "../../../../hooks/useAgentVisibility";
import { filterVisibleModels, useHiddenModels } from "../../../../utils/modelVisibility";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import { NextTaskBanner } from "../../../task-master";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Card,
} from "../../../../shared/view/ui";

const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "OpenAI" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
  { id: "kilo", name: "Kilo Code" },
  { id: "cline", name: "Cline" },
  { id: "grok", name: "xAI" },
  { id: "kimi", name: "Moonshot AI" },
  { id: "qwencode", name: "Qwen" },
  { id: "pi", name: "Pi" },
];

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

// cmdk's default filter is fuzzy (loose character-subsequence scoring), which
// surfaces unrelated models — e.g. searching "chatgpt" also matched "Fable".
// Require every whitespace-separated search token to appear as a literal
// substring instead, so "claude 4.5" still matches "Anthropic Claude Haiku 4.5"
// but "chatgpt" only matches models that actually contain it.
function modelSearchFilter(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0;
}

type ProviderSelectionEmptyStateProps = {
  /**
   * True for an Agent Relay worker transcript opened for observation only.
   * The empty state's provider/model picker and "start the next task" banner
   * both seed a message this session can never send, so read-only mode
   * replaces the whole thing with a static notice.
   */
  readOnly?: boolean;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  kiloModel: string;
  setKiloModel: (model: string) => void;
  grokModel: string;
  setGrokModel: (model: string) => void;
  kimiModel: string;
  setKimiModel: (model: string) => void;
  qwencodeModel: string;
  setQwenCodeModel: (model: string) => void;
  piModel: string;
  setPiModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  /** True while a bypass-cache model catalog refresh is in flight. */
  providerModelsRefreshing?: boolean;
  /** Forces a bypass-cache refetch of every provider's model catalog. */
  onRefreshProviderModels?: () => void;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

type ProviderGroup = {
  id: LLMProvider;
  name: string;
  models: { value: string; label: string; description?: string }[];
};

function getModelConfig(
  p: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelsDefinition {
  const entry = catalog[p];
  return entry ?? { OPTIONS: [], DEFAULT: "" };
}

function getCurrentModel(
  p: LLMProvider,
  c: string,
  cu: string,
  co: string,
  o: string,
  kilo: string,
  g: string,
  k: string,
  q: string,
  pi: string,
) {
  if (p === "claude") return c;
  if (p === "codex") return co;
  if (p === "opencode") return o;
  if (p === "kilo") return kilo;
  if (p === "cline") return o;
  if (p === "grok") return g;
  if (p === "kimi") return k;
  if (p === "qwencode") return q;
  if (p === "pi") return pi;
  return cu;
}

function getProviderDisplayName(p: LLMProvider) {
  if (p === "claude") return "Claude";
  if (p === "cursor") return "Cursor";
  if (p === "codex") return "Codex";
  if (p === "opencode") return "OpenCode";
  if (p === "kilo") return "Kilo Code";
  if (p === "cline") return "Cline";
  if (p === "grok") return "Grok Build";
  if (p === "kimi") return "Kimi";
  if (p === "qwencode") return "Qwen Code";
  if (p === "pi") return "Pi";
  return "Claude";
}

export default function ProviderSelectionEmptyState({
  readOnly = false,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  opencodeModel,
  setOpenCodeModel,
  kiloModel,
  setKiloModel,
  grokModel,
  setGrokModel,
  kimiModel,
  setKimiModel,
  qwencodeModel,
  setQwenCodeModel,
  piModel,
  setPiModel,
  providerModelCatalog,
  providerModelsLoading,
  providerModelsRefreshing = false,
  onRefreshProviderModels,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const [dialogOpen, setDialogOpen] = useState(false);
  const { isAgentEnabled } = useAgentVisibility();
  const { hiddenModels } = useHiddenModels();

  // A long-lived tab only fetches the model catalog once on mount, so a
  // session left open across a provider's label-format update (or a stale
  // disk cache) would keep showing outdated labels here indefinitely. One
  // bypass-cache refresh per dialog open keeps this picker current without
  // reloading the page or polling in the background.
  const hasRefreshedOnOpenRef = useRef(false);
  useEffect(() => {
    if (!dialogOpen) {
      hasRefreshedOnOpenRef.current = false;
      return;
    }

    if (hasRefreshedOnOpenRef.current) {
      return;
    }

    hasRefreshedOnOpenRef.current = true;
    onRefreshProviderModels?.();
  }, [dialogOpen, onRefreshProviderModels]);

  const visibleProviderGroups = useMemo<ProviderGroup[]>(() => {
    return PROVIDER_META.filter((p) => isAgentEnabled(p.id)).map((p) => ({
      id: p.id,
      name: p.name,
      models: filterVisibleModels(providerModelCatalog[p.id], hiddenModels[p.id] ?? []),
    }));
  }, [providerModelCatalog, isAgentEnabled, hiddenModels]);

  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  const currentModel = getCurrentModel(
    provider,
    claudeModel,
    cursorModel,
    codexModel,
    opencodeModel,
    kiloModel,
    grokModel,
    kimiModel,
    qwencodeModel,
    piModel,
  );

  const currentModelLabel = useMemo(() => {
    const config = getModelConfig(provider, providerModelCatalog);
    const found = config.OPTIONS.find(
      (o: { value: string; label: string }) => o.value === currentModel,
    );
    return found?.label || currentModel;
  }, [provider, currentModel, providerModelCatalog]);

  const setModelForProvider = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      if (providerId === "claude") {
        setClaudeModel(modelValue);
        localStorage.setItem("claude-model", modelValue);
      } else if (providerId === "codex") {
        setCodexModel(modelValue);
        localStorage.setItem("codex-model", modelValue);
      } else if (providerId === "opencode") {
        setOpenCodeModel(modelValue);
        localStorage.setItem("opencode-model", modelValue);
      } else if (providerId === "kilo") {
        setKiloModel(modelValue);
        localStorage.setItem("kilo-model", modelValue);
      } else if (providerId === "kimi") {
        setKimiModel(modelValue);
        localStorage.setItem("kimi-model", modelValue);
      } else if (providerId === "qwencode") {
        setQwenCodeModel(modelValue);
        localStorage.setItem("qwencode-model", modelValue);
      } else if (providerId === "pi") {
        setPiModel(modelValue);
        localStorage.setItem("pi-model", modelValue);
      } else if (providerId === "grok") {
        setGrokModel(modelValue);
        localStorage.setItem("grok-model", modelValue);
      } else {
        setCursorModel(modelValue);
        localStorage.setItem("cursor-model", modelValue);
      }
    },
    [setClaudeModel, setCursorModel, setCodexModel, setOpenCodeModel, setKiloModel, setKimiModel, setQwenCodeModel, setPiModel, setGrokModel],
  );

  const handleModelSelect = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      setProvider(providerId);
      localStorage.setItem("selected-provider", providerId);
      setModelForProvider(providerId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setProvider, setModelForProvider, textareaRef],
  );

  // Read-only worker transcripts get no picker and no task banner — both of
  // them exist to start work this session cannot accept. Runs before the
  // session/draft branches below so an unloaded worker session (fail-closed
  // hint, no selectedSession yet) never flashes the provider picker.
  if (readOnly) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="max-w-[34.25rem] text-center">
          <Lock className="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden />
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.readOnlyWorker.title", { defaultValue: "Read-only worker session" })}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.readOnlyWorker.description", {
              defaultValue:
                "This Agent Relay worker transcript is shown for observation only. Nothing has been recorded here yet.",
            })}
          </p>
        </div>
      </div>
    );
  }

  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-[34.25rem]">
          <div className="mb-4 text-center sm:mb-8">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t("providerSelection.title")}
            </h2>
            <p className="mt-1 hidden text-[13px] text-muted-foreground sm:block">
              {t("providerSelection.description")}
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Card
                className="group mx-auto max-w-xs cursor-pointer border-border/60 transition-all duration-150 hover:border-border hover:shadow-md active:scale-[0.99]"
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center gap-2 p-3">
                  <SessionProviderLogo
                    provider={provider}
                    className="h-5 w-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">
                        {getProviderDisplayName(provider)}
                      </span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-foreground">
                        {currentModelLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.clickToChange", {
                        defaultValue: "Click to change model",
                      })}
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            <DialogContent className="max-w-md overflow-hidden p-0">
              <DialogTitle>Model Selector</DialogTitle>
              <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Choose a model</p>
                {onRefreshProviderModels && (
                  <button
                    type="button"
                    onClick={onRefreshProviderModels}
                    disabled={providerModelsRefreshing}
                    title="Refresh model list from providers"
                    aria-label="Refresh model list from providers"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${providerModelsRefreshing ? "animate-spin" : ""}`} />
                  </button>
                )}
              </div>
              <Command filter={modelSearchFilter}>
                <CommandInput
                  placeholder={t("providerSelection.searchModels", {
                    defaultValue: "Search models...",
                  })}
                />
                <CommandList className="max-h-[350px]">
                  <CommandEmpty>
                    {t("providerSelection.noModelsFound", {
                      defaultValue: "No models found.",
                    })}
                  </CommandEmpty>
                  {visibleProviderGroups.map((group, idx) => (
                    <CommandGroup
                      key={group.id}
                      className={
                        idx > 0
                          ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                          : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                      }
                      heading={
                        <span className="flex items-center gap-1.5">
                          <SessionProviderLogo provider={group.id} className="h-3.5 w-3.5 shrink-0" />
                          {group.name}
                        </span>
                      }
                    >
                      {group.models.length === 0 && providerModelsLoading ? (
                        <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                          {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                        </CommandItem>
                      ) : null}
                      {group.models.map((model) => {
                        const isSelected = provider === group.id && currentModel === model.value;
                        return (
                          <CommandItem
                            key={`${group.id}-${model.value}`}
                            value={`${group.name} ${model.label} ${model.description || ''}`}
                            onSelect={() => handleModelSelect(group.id, model.value)}
                            className="ml-4 border-l border-border/40 pl-4"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate">{model.label}</div>
                              {/* 
                              // * Temporarly commented out because the description of models from claude 
                              // * was a bit inconsistent.  Will return it back when it becomes more consistent.
                              */}
                              {/* {model.description && (
                                <div className="truncate text-xs text-muted-foreground">
                                  {model.description}
                                </div>
                              )} */}
                            </div>
                            {isSelected && (
                              <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>

          <p className="mt-2 text-center text-sm text-muted-foreground/70 sm:mt-4">
            {
              {
                claude: t("providerSelection.readyPrompt.claude", {
                  model: claudeModel,
                }),
                cursor: t("providerSelection.readyPrompt.cursor", {
                  model: cursorModel,
                }),
                codex: t("providerSelection.readyPrompt.codex", {
                  model: codexModel,
                }),
                opencode: t("providerSelection.readyPrompt.opencode", {
                  model: opencodeModel,
                  defaultValue: "Ready with OpenCode {{model}}",
                }),
                kilo: t("providerSelection.readyPrompt.kilo", {
                  model: kiloModel,
                  defaultValue: "Ready with Kilo Code {{model}}",
                }),
                cline: t("providerSelection.readyPrompt.cline", {
                  model: opencodeModel,
                  defaultValue: "Ready with Cline {{model}}",
                }),
                grok: t("providerSelection.readyPrompt.grok", {
                  model: grokModel,
                  defaultValue: "Ready with Grok Build {{model}}",
                }),
                kimi: t("providerSelection.readyPrompt.kimi", {
                  model: kimiModel,
                  defaultValue: "Ready with Kimi {{model}}",
                }),
                qwencode: t("providerSelection.readyPrompt.qwencode", {
                  model: qwencodeModel,
                  defaultValue: "Ready with Qwen Code {{model}}",
                }),
                pi: t("providerSelection.readyPrompt.pi", {
                  model: piModel,
                  defaultValue: "Ready with Pi {{model}}",
                }),
              }[provider]
            }
          </p>

          <p className="mt-3 hidden items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60 sm:flex">
            <Trans
              ns="chat"
              i18nKey="providerSelection.pressToSearch"
              values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
              components={{
                kbd: (
                  <kbd className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]" />
                ),
              }}
            />
          </p>

          {provider && tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-[34.25rem] px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
