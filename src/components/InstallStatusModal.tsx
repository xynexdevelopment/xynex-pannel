import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ChevronDown, Loader2, ArrowLeft, RefreshCw } from "lucide-react";

// Built at runtime so the linter doesn't flag a literal control character.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/**
 * Pterodactyl-style "Server Installing" popup. Blocks the server page while the
 * install runs (with a live install log), and switches to a "Installation
 * Failed" popup with a Reinstall button if it errors out.
 */
export default function InstallStatusModal({
  serverId,
  status,
  installError,
  canManage,
  busy,
  onReinstall,
}: {
  serverId: string;
  status?: string;
  installError?: string;
  canManage: boolean;
  busy: boolean;
  onReinstall: () => void;
}) {
  const installing = status === "installing";
  const failed = status === "install_failed";
  const [dismissedFailed, setDismissedFailed] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  // A new failure (after a reinstall attempt) should be shown again.
  useEffect(() => {
    if (!failed) setDismissedFailed(false);
  }, [failed]);

  const open = installing || (failed && !dismissedFailed);

  // Poll the install log while the popup is up.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => {
      axios
        .get(`/api/servers/${serverId}/install-logs`)
        .then((res) => {
          if (!cancelled) setLog(String(res.data?.log || "").replace(ANSI_RE, ""));
        })
        .catch(() => {});
    };
    load();
    const iv = installing ? setInterval(load, 2000) : undefined;
    return () => {
      cancelled = true;
      if (iv) clearInterval(iv);
    };
  }, [open, installing, serverId]);

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, showLog]);

  const tail = log.split(/\r?\n/).filter((l) => l.trim()).slice(-60).join("\n");

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key={failed ? "failed" : "installing"}
          className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="install-title"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 280, damping: 28 }}
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-card/95 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl"
          >
            <div
              className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${
                failed ? "from-red-500/70" : "from-theme-400/70"
              } via-transparent to-transparent`}
            />
            <div className="flex flex-col items-center px-7 pb-6 pt-8 text-center">
              <span
                className={`mb-5 flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ${
                  failed ? "bg-red-500/12 text-red-400 ring-red-500/30" : "bg-theme-500/12 text-theme-400 ring-theme-500/30"
                }`}
              >
                {failed ? <AlertTriangle className="h-6 w-6" /> : <Loader2 className="h-6 w-6 animate-spin" />}
              </span>

              <h2 id="install-title" className="text-[17px] font-semibold tracking-tight text-foreground">
                {failed ? "Installation Failed" : "Server Installing"}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {failed
                  ? "Something went wrong while installing this server. Check the install log below, then try reinstalling it."
                  : "Your server is currently being installed. Please check back in a few minutes — this popup closes on its own once the installation is complete."}
              </p>
              {failed && installError && (
                <p className="mt-3 w-full break-words rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-left font-mono text-xs text-red-300">
                  {installError}
                </p>
              )}

              <button
                type="button"
                onClick={() => setShowLog((v) => !v)}
                className="mt-5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showLog ? "rotate-180" : ""}`} />
                {showLog ? "Hide install log" : "Show install log"}
              </button>
              {showLog && (
                <pre
                  ref={logRef}
                  className="mt-3 h-40 w-full overflow-auto rounded-xl border border-white/10 bg-black/50 p-3 text-left font-mono text-[11px] leading-relaxed text-emerald-300/90 whitespace-pre-wrap break-all"
                >
                  {tail || "Waiting for installer output…"}
                </pre>
              )}

              <div className={`mt-6 grid w-full gap-3 ${failed && canManage ? "grid-cols-2" : "grid-cols-1"}`}>
                {failed ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setDismissedFailed(true)}
                      className="h-11 rounded-xl border border-white/10 bg-white/[0.04] text-sm font-medium text-foreground-muted transition-all hover:bg-white/[0.09] hover:text-foreground"
                    >
                      Close
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        onClick={onReinstall}
                        disabled={busy}
                        className="flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-red-500 to-red-600 text-sm font-semibold text-white shadow-[0_6px_20px_-6px_rgba(239,68,68,0.7)] transition-all hover:from-red-400 active:scale-[0.97] disabled:opacity-60"
                      >
                        <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /> Reinstall
                      </button>
                    )}
                  </>
                ) : (
                  <Link
                    to="/servers"
                    className="flex h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] text-sm font-medium text-foreground-muted transition-all hover:bg-white/[0.09] hover:text-foreground"
                  >
                    <ArrowLeft className="h-4 w-4" /> Back to servers
                  </Link>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
