import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../shared/view/ui';

export type ProjectMemoryProjectOption = {
  projectId: string;
  displayName: string;
  path: string;
};

type ProjectMemoryProjectSelectorProps = {
  projects: ProjectMemoryProjectOption[];
  selectedPath: string;
  onSelect: (path: string) => void;
};

export default function ProjectMemoryProjectSelector({
  projects,
  selectedPath,
  onSelect,
}: ProjectMemoryProjectSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selectedProject = projects.find((project) => project.path === selectedPath);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !containerRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());

    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  const focusTrigger = () => {
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleSelect = (path: string) => {
    onSelect(path);
    setIsOpen(false);
    focusTrigger();
  };

  return (
    <div ref={containerRef} className="relative min-w-0 sm:max-w-xs">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Select project"
        aria-controls={isOpen ? listId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setIsOpen(true);
          }
        }}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-left text-sm text-foreground shadow-sm outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate">
          {selectedProject?.displayName ?? 'Select project…'}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {isOpen && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-full min-w-[min(100%,18rem)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <Command
            loop
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setIsOpen(false);
                focusTrigger();
              }
            }}
          >
            <CommandInput
              ref={searchInputRef}
              aria-label="Search projects"
              placeholder="Search projects…"
            />
            <CommandList id={listId} aria-label="Projects" className="max-h-64">
              <CommandEmpty>No matching projects.</CommandEmpty>
              {projects.map((project) => (
                <CommandItem
                  key={project.path}
                  value={`${project.displayName} ${project.projectId} ${project.path}`}
                  onSelect={() => handleSelect(project.path)}
                  className="items-start py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{project.displayName}</div>
                    <div className="truncate text-[10px] text-muted-foreground" title={project.path}>
                      {project.path}
                    </div>
                  </div>
                  {project.path === selectedPath && (
                    <Check className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
