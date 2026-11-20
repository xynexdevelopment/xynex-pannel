import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Download, Library, Loader2, Search, X } from "lucide-react";

interface LibEgg {
  id: string;
  name: string;
  description: string;
  author: string;
  group: string;
  sub: string;
  installed: boolean;
  duplicate: boolean;
}

const CHUNK = 60;

export default function EggLibraryModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [eggs, setEggs] = useState<LibEgg[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; failed: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get<LibEgg[]>("/api/eggs/library");
      setEggs(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      setError(e.response?.data?.error || "Could not load the egg library.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setResult(null);
    setProgress(null);
    void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, load, onClose, busy]);

  const groups = useMemo(() => {
    const m = new Map<string, number>();
    eggs.forEach((e) => m.set(e.group, (m.get(e.group) || 0) + 1));
    return [["All", eggs.length] as [string, number], ...[...m.entries()].sort((a, b) => b[1] - a[1])];
  }, [eggs]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => eggs.filter((e) => (group === "All" || e.group === group) && (!q || `${e.name} ${e.description} ${e.sub}`.toLowerCase().includes(q))),
    [eggs, group, q],
  );
  const selectable = visible.filter((e) => !e.installed);
  const newEggs = eggs.filter((e) => !e.installed && !e.duplicate);
  const installedCount = eggs.filter((e) => e.installed).length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const allVisibleSelected = selectable.length > 0 && selectable.every((e) => selected.has(e.id));
  const toggleAllVisible = () =>
    setSelected((s) => {
      const n = new Set(s);
      selectable.forEach((e) => (allVisibleSelected ? n.delete(e.id) : n.add(e.id)));
      return n;
    });

  const runImport = async (ids: string[], skipDuplicateNames: boolean) => {
    if (!ids.length || busy) return;
    setBusy(true);
    setResult(null);
    const total = { imported: 0, skipped: 0, failed: 0 };
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        setProgress(`Importing ${Math.min(i + CHUNK, ids.length)} / ${ids.length}…`);
        const res = await axios.post("/api/eggs/library/import", { ids: ids.slice(i, i + CHUNK), skipDuplicateNames });
        total.imported += res.data.imported || 0;
        total.skipped += res.data.skipped || 0;
        total.failed += (res.data.failed || []).length;
      }
      setResult(total);
      setSelected(new Set());
      onImported();
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || "Import failed. Try again.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/70 p-3 backdrop-blur-md md:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
          role="dialog"
          aria-modal="true"
          aria-label="Egg Library"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 280, damping: 28 }}
            className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-card shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)]"
          >
            {/* header */}
            <div className="flex items-start justify-between gap-4 border-b border-border-subtle p-5 md:p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-theme-500/15 text-theme-400 ring-1 ring-theme-500/30">
                  <Library size={22} />
                </span>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Egg Library</h3>
                  <p className="text-xs text-muted-foreground">
                    {eggs.length} community eggs · {installedCount} installed · {newEggs.length} new
                  </p>
                </div>
              </div>
              <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground disabled:opacity-40">
                <X size={18} />
              </button>
            </div>

            {/* filters */}
            <div className="space-y-3 border-b border-border-subtle p-5 md:px-6">
              <div className="relative">
                <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search games, bots, databases, software…"
                  className="w-full rounded-xl border border-border-subtle bg-muted-subtle py-2.5 pl-10 pr-4 text-sm text-foreground outline-none transition-all placeholder:text-muted-foreground/60 focus:border-theme-500/50 focus:ring-2 focus:ring-theme-500/20"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {groups.map(([g, n]) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGroup(g)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all active:scale-[0.97] ${
                      group === g ? "border-theme-500/40 bg-theme-500/20 text-theme-300" : "border-border-subtle bg-muted-subtle text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    {g} <span className="opacity-60">{n}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* list */}
            <div className="min-h-[220px] flex-1 overflow-y-auto p-3 md:p-4">
              {loading ? (
                <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="animate-spin" size={18} /> Loading library…
                </div>
              ) : error && eggs.length === 0 ? (
                <div className="p-6 text-center text-sm text-red-400">{error}</div>
              ) : visible.length === 0 ? (
                <div className="p-10 text-center text-sm text-muted-foreground">No eggs match your search.</div>
              ) : (
                <>
                  <label className="mb-2 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-white/5">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={selectable.length === 0} className="h-4 w-4 accent-[var(--theme-500)]" />
                    Select all shown ({selectable.length} available)
                  </label>
                  <ul className="flex flex-col gap-1.5">
                    {visible.map((e) => (
                      <li key={e.id}>
                        <label
                          className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                            e.installed ? "cursor-default border-border-subtle/60 bg-white/[0.02] opacity-60" : selected.has(e.id) ? "cursor-pointer border-theme-500/40 bg-theme-500/10" : "cursor-pointer border-border-subtle bg-muted-subtle hover:bg-muted"
                          }`}
                        >
                          <input
                            type="checkbox"
                            disabled={e.installed}
                            checked={e.installed || selected.has(e.id)}
                            onChange={() => toggle(e.id)}
                            className="mt-1 h-4 w-4 shrink-0 accent-[var(--theme-500)]"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-foreground">{e.name}</span>
                              <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{e.sub || e.group}</span>
                              {e.installed && (
                                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                                  <CheckCircle2 size={11} /> Installed
                                </span>
                              )}
                              {e.duplicate && <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">Similar egg exists</span>}
                            </div>
                            {e.description && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{e.description}</p>}
                          </div>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            {/* footer */}
            <div className="flex flex-col gap-3 border-t border-border-subtle p-4 md:flex-row md:items-center md:justify-between md:px-6">
              <div className="min-h-[20px] text-xs">
                {progress ? (
                  <span className="inline-flex items-center gap-2 text-theme-300"><Loader2 size={14} className="animate-spin" /> {progress}</span>
                ) : result ? (
                  <span className="text-emerald-400">
                    Imported {result.imported}
                    {result.skipped ? ` · skipped ${result.skipped}` : ""}
                    {result.failed ? <span className="text-red-400"> · {result.failed} failed</span> : ""}
                  </span>
                ) : error ? (
                  <span className="text-red-400">{error}</span>
                ) : (
                  <span className="text-muted-foreground">{selected.size} selected</span>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={busy || newEggs.length === 0}
                  onClick={() => runImport(newEggs.map((e) => e.id), true)}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-border-subtle bg-white/[0.04] px-4 text-sm font-medium text-foreground transition-all hover:bg-white/10 active:scale-[0.97] disabled:opacity-40"
                  title="Imports every egg that isn't installed yet and has no same-named egg"
                >
                  <Download size={15} /> Import all new ({newEggs.length})
                </button>
                <button
                  type="button"
                  disabled={busy || selected.size === 0}
                  onClick={() => runImport([...selected], false)}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-gradient-to-b from-theme-400 to-theme-600 px-5 text-sm font-semibold text-black shadow-[0_6px_20px_-6px_rgba(var(--theme-rgb-500),0.75)] transition-all hover:from-theme-300 active:scale-[0.97] disabled:opacity-40 disabled:shadow-none"
                >
                  Import selected ({selected.size})
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
