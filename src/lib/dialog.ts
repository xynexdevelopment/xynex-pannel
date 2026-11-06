/**
 * Premium replacement for window.confirm() / window.prompt().
 * Imperative + promise based, so call sites stay one-liners:
 *
 *   if (!(await confirmDialog("Delete this backup?"))) return;
 *   const name = await promptDialog("Enter new file name (e.g. config.yml):");
 *
 * Rendered by <DialogHost /> (mounted once in App.tsx).
 */

export type DialogTone = "danger" | "warning" | "default";

export interface DialogRequest {
  id: number;
  kind: "confirm" | "prompt";
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: DialogTone;
  icon: "trash" | "alert" | "help" | "edit" | "shield";
  placeholder?: string;
  defaultValue?: string;
  resolve: (value: boolean | string | null) => void;
}

export interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
}

let queue: DialogRequest[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export const subscribeDialogs = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const getActiveDialog = (): DialogRequest | null => queue[0] ?? null;

export function settleDialog(id: number, value: boolean | string | null) {
  const req = queue.find((q) => q.id === id);
  if (!req) return;
  queue = queue.filter((q) => q.id !== id);
  req.resolve(value);
  emit();
}

/** "Delete world "x"? This cannot be undone." -> title + description */
function splitMessage(message: string): { title: string; description?: string } {
  const text = message.trim();
  const m = text.match(/^([\s\S]*?[?.!])\s+([\s\S]+)$/);
  if (m) return { title: m[1].trim(), description: m[2].trim() };
  return { title: text };
}

function inferConfirm(message: string): Pick<DialogRequest, "tone" | "icon" | "confirmLabel"> {
  const m = message.toLowerCase();
  if (/\bunban\b/.test(m)) return { tone: "default", icon: "shield", confirmLabel: "Unban" };
  if (/force-logout|log ?out/.test(m)) return { tone: "danger", icon: "alert", confirmLabel: "Log out" };
  if (/\bban\b/.test(m)) return { tone: "danger", icon: "shield", confirmLabel: "Ban IP" };
  if (/\bblock\b/.test(m)) return { tone: "danger", icon: "shield", confirmLabel: "Block IP" };
  if (/\bdelete\b/.test(m)) return { tone: "danger", icon: "trash", confirmLabel: "Delete" };
  if (/\bremove\b/.test(m)) return { tone: "danger", icon: "trash", confirmLabel: "Remove" };
  if (/\breset\b/.test(m)) return { tone: "danger", icon: "alert", confirmLabel: "Reset" };
  if (/\bclose\b/.test(m)) return { tone: "warning", icon: "alert", confirmLabel: "Close" };
  if (/\binstall\b/.test(m)) return { tone: "default", icon: "help", confirmLabel: "Install" };
  return { tone: "default", icon: "help", confirmLabel: "Confirm" };
}

export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const split = splitMessage(message);
  const inferred = inferConfirm(message);
  return new Promise<boolean>((resolve) => {
    queue = [
      ...queue,
      {
        id: nextId++,
        kind: "confirm",
        title: opts.title ?? split.title,
        description: opts.description ?? split.description,
        confirmLabel: opts.confirmLabel ?? inferred.confirmLabel,
        cancelLabel: opts.cancelLabel ?? "Cancel",
        tone: opts.tone ?? inferred.tone,
        icon: inferred.icon,
        resolve: (v) => resolve(v === true),
      },
    ];
    emit();
  });
}

export function promptDialog(message: string, defaultValue = ""): Promise<string | null> {
  // "Enter new file name (e.g. config.yml):" -> title + placeholder
  const hint = message.match(/\(([^)]*)\)\s*:?\s*$/);
  const title = message
    .replace(/\(([^)]*)\)\s*:?\s*$/, "")
    .replace(/:\s*$/, "")
    .trim();
  return new Promise<string | null>((resolve) => {
    queue = [
      ...queue,
      {
        id: nextId++,
        kind: "prompt",
        title,
        confirmLabel: "Continue",
        cancelLabel: "Cancel",
        tone: "default",
        icon: "edit",
        placeholder: hint ? hint[1] : undefined,
        defaultValue,
        resolve: (v) => resolve(typeof v === "string" ? v : null),
      },
    ];
    emit();
  });
}
