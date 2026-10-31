import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, Search, Command } from "lucide-react";
import { filterNavItems } from "../lib/navSearch";

export interface PaletteItem {
  id: string;
  label: string;
  group: string;
  description: string;
  keywords?: string[];
  icon: React.ReactNode;
}

interface Props {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
  onSelect: (id: string) => void;
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="inline-flex min-w-[20px] items-center justify-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-muted-foreground">
    {children}
  </kbd>
);

/** Ctrl/Cmd+K command palette: jump to any admin page or setting. */
export default function AdminCommandPalette({ open, items, onClose, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => filterNavItems(items, query), [items, query]);
  const grouped = query.trim() === "";

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: number) => {
    const item = results[i];
    if (item) {
      onSelect(item.id);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh] bg-black/70 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-card/90 shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl"
            initial={{ opacity: 0, y: -14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* neon edge + soft aura */}
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-theme-400 to-transparent" />
            <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-40 w-[70%] -translate-x-1/2 rounded-full bg-theme-500/20 blur-3xl" />

            {/* input */}
            <div className="relative flex items-center gap-3 border-b border-white/[0.06] px-4 py-3.5">
              <Search size={16} className="shrink-0 text-theme-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search pages & settings…"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
                aria-controls="admin-palette-list"
                aria-activedescendant={results[active] ? `admin-palette-${results[active].id}` : undefined}
              />
              <Kbd>ESC</Kbd>
            </div>

            {/* results */}
            <div ref={listRef} id="admin-palette-list" role="listbox" className="relative max-h-[52vh] overflow-y-auto custom-scrollbar p-2">
              {results.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground/60">no signal</p>
                  <p className="mt-2 text-sm text-muted-foreground">Nothing matches “{query}”.</p>
                </div>
              ) : (
                results.map((item, i) => {
                  const showHeader = grouped && (i === 0 || results[i - 1].group !== item.group);
                  const isActive = i === active;
                  return (
                    <React.Fragment key={item.id}>
                      {showHeader && (
                        <div className="px-3 pb-1 pt-3 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/50 first:pt-1">
                          {item.group}
                        </div>
                      )}
                      <button
                        id={`admin-palette-${item.id}`}
                        data-index={i}
                        role="option"
                        aria-selected={isActive}
                        onMouseMove={() => setActive(i)}
                        onClick={() => choose(i)}
                        className="relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left"
                      >
                        {isActive && (
                          <motion.span
                            layoutId="admin-palette-active"
                            className="absolute inset-0 rounded-xl border border-theme-500/30 bg-gradient-to-r from-theme-500/20 to-theme-500/[0.04]"
                            transition={{ type: "spring", stiffness: 600, damping: 40 }}
                          />
                        )}
                        {isActive && <span aria-hidden className="absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-full bg-theme-400 shadow-[0_0_10px_rgba(255,255,255,0.5)]" />}
                        <span
                          className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                            isActive ? "border-theme-400/40 bg-theme-500 text-white" : "border-white/[0.06] bg-white/[0.04] text-muted-foreground"
                          }`}
                        >
                          {item.icon}
                        </span>
                        <span className="relative min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-foreground">{item.label}</span>
                          <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                        </span>
                        {!grouped && (
                          <span className="relative hidden shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50 sm:block">{item.group}</span>
                        )}
                        {isActive && <CornerDownLeft size={14} className="relative shrink-0 text-theme-400" />}
                      </button>
                    </React.Fragment>
                  );
                })
              )}
            </div>

            {/* footer */}
            <div className="relative flex items-center gap-4 border-t border-white/[0.06] bg-black/20 px-4 py-2 font-mono text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
              <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> open</span>
              <span className="ml-auto flex items-center gap-1.5">
                <Command size={11} className="text-theme-400" />
                {results.length} {results.length === 1 ? "result" : "results"}
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
