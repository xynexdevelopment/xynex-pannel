import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, HelpCircle, PencilLine, ShieldAlert, Trash2 } from "lucide-react";
import { getActiveDialog, settleDialog, subscribeDialogs, type DialogRequest } from "../lib/dialog";

const EASE = [0.22, 1, 0.36, 1] as const;

const ICONS = {
  trash: Trash2,
  alert: AlertTriangle,
  help: HelpCircle,
  edit: PencilLine,
  shield: ShieldAlert,
} as const;

const TONES = {
  danger: {
    badge: "bg-red-500/12 text-red-400 ring-1 ring-red-500/30 shadow-[0_0_28px_-4px_rgba(239,68,68,0.55)]",
    button: "bg-gradient-to-b from-red-500 to-red-600 hover:from-red-400 hover:to-red-600 text-white shadow-[0_6px_20px_-6px_rgba(239,68,68,0.7)]",
    edge: "from-red-500/70 via-red-500/10 to-transparent",
  },
  warning: {
    badge: "bg-amber-500/12 text-amber-400 ring-1 ring-amber-500/30 shadow-[0_0_28px_-4px_rgba(245,158,11,0.5)]",
    button: "bg-gradient-to-b from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-500 text-black shadow-[0_6px_20px_-6px_rgba(245,158,11,0.7)]",
    edge: "from-amber-400/70 via-amber-400/10 to-transparent",
  },
  default: {
    badge: "bg-theme-500/12 text-theme-400 ring-1 ring-theme-500/30 shadow-[0_0_28px_-4px_rgba(var(--theme-rgb-500),0.6)]",
    button: "bg-gradient-to-b from-theme-400 to-theme-600 hover:from-theme-300 hover:to-theme-600 text-black shadow-[0_6px_20px_-6px_rgba(var(--theme-rgb-500),0.75)]",
    edge: "from-theme-400/70 via-theme-400/10 to-transparent",
  },
} as const;

function DialogCard({ req }: { req: DialogRequest }) {
  const tone = TONES[req.tone];
  const Icon = ICONS[req.icon];
  const [value, setValue] = useState(req.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const cancel = () => settleDialog(req.id, req.kind === "prompt" ? null : false);
  const accept = () => settleDialog(req.id, req.kind === "prompt" ? value : true);

  // Focus: input for prompts, Cancel for destructive confirms (safe default), else Confirm.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (req.kind === "prompt") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (req.tone === "danger") cancelRef.current?.focus();
      else confirmRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [req.kind, req.tone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Tab") {
        // simple focus trap
        const nodes = [inputRef.current, cancelRef.current, confirmRef.current].filter(Boolean) as HTMLElement[];
        if (!nodes.length) return;
        const idx = nodes.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        const next = e.shiftKey ? (idx <= 0 ? nodes.length - 1 : idx - 1) : (idx + 1) % nodes.length;
        nodes[next].focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.id]);

  return (
    <motion.div
      key={req.id}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: EASE }}
      onMouseDown={(e) => e.target === e.currentTarget && cancel()}
      role={req.kind === "confirm" ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-labelledby={`dlg-title-${req.id}`}
      aria-describedby={req.description ? `dlg-desc-${req.id}` : undefined}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 18 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ type: "spring", stiffness: 280, damping: 28, mass: 0.9 }}
        className="relative w-full max-w-[420px] overflow-hidden rounded-2xl border border-white/10 bg-card/95 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl"
      >
        {/* glowing top edge */}
        <div className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${tone.edge}`} />
        <div className={`pointer-events-none absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full opacity-30 blur-3xl bg-gradient-to-b ${tone.edge}`} />

        <form
          className="relative flex flex-col items-center px-7 pb-6 pt-8 text-center"
          onSubmit={(e) => {
            e.preventDefault();
            accept();
          }}
        >
          <span className={`mb-5 flex h-14 w-14 items-center justify-center rounded-2xl ${tone.badge}`}>
            <Icon className="h-6 w-6" />
          </span>

          <h2 id={`dlg-title-${req.id}`} className="text-[17px] font-semibold leading-snug tracking-tight text-foreground break-words">
            {req.title}
          </h2>
          {req.description && (
            <p id={`dlg-desc-${req.id}`} className="mt-2 text-sm leading-relaxed text-muted-foreground break-words">
              {req.description}
            </p>
          )}

          {req.kind === "prompt" && (
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={req.placeholder}
              spellCheck={false}
              autoComplete="off"
              className="mt-5 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none transition-all focus:border-theme-500/60 focus:ring-2 focus:ring-theme-500/25"
            />
          )}

          <div className="mt-7 grid w-full grid-cols-2 gap-3">
            <button
              ref={cancelRef}
              type="button"
              onClick={cancel}
              className="h-11 rounded-xl border border-white/10 bg-white/[0.04] text-sm font-medium text-foreground-muted transition-all hover:bg-white/[0.09] hover:text-foreground active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            >
              {req.cancelLabel}
            </button>
            <button
              ref={confirmRef}
              type="submit"
              className={`h-11 rounded-xl text-sm font-semibold transition-all active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${tone.button}`}
            >
              {req.confirmLabel}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

export default function DialogHost() {
  const active = useSyncExternalStore(subscribeDialogs, getActiveDialog, () => null);
  return <AnimatePresence mode="wait">{active && <DialogCard key={active.id} req={active} />}</AnimatePresence>;
}
