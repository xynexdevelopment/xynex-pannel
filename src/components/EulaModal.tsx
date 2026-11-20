import { useState } from "react";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import { FileSignature } from "lucide-react";

/**
 * Pterodactyl-style "Minecraft EULA" popup. Shown when a Minecraft server
 * needs eula=true (before Start, or when the console says it refused to boot).
 * Accepting writes eula.txt on the server and lets the caller start it.
 */
export default function EulaModal({
  open,
  serverId,
  onClose,
  onAccepted,
}: {
  open: boolean;
  serverId: string;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await axios.post(`/api/servers/${serverId}/eula/accept`);
      onAccepted();
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to accept the EULA. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="eula-title"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 280, damping: 28 }}
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-card/95 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl"
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-amber-400/70 via-amber-400/10 to-transparent" />
            <div className="px-7 pb-6 pt-8">
              <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-400 ring-1 ring-amber-500/30">
                <FileSignature className="h-6 w-6" />
              </span>
              <h2 id="eula-title" className="text-[17px] font-semibold tracking-tight text-foreground">
                Minecraft® EULA
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                By pressing <strong className="text-foreground">I Accept</strong> below you are indicating your agreement to the{" "}
                <a
                  href="https://minecraft.net/eula"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-theme-400 underline hover:text-theme-300"
                >
                  Minecraft® EULA
                </a>
                . The server will not start until it has been accepted.
              </p>
              {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
              <div className="mt-7 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="h-11 rounded-xl border border-white/10 bg-white/[0.04] text-sm font-medium text-foreground-muted transition-all hover:bg-white/[0.09] hover:text-foreground disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={accept}
                  disabled={busy}
                  className="h-11 rounded-xl bg-gradient-to-b from-amber-400 to-amber-500 text-sm font-semibold text-black shadow-[0_6px_20px_-6px_rgba(245,158,11,0.7)] transition-all hover:from-amber-300 active:scale-[0.97] disabled:opacity-60"
                >
                  {busy ? "Accepting…" : "I Accept"}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
