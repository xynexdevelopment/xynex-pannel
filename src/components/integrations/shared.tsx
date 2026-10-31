import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Eye, EyeOff, Loader2, Save } from "lucide-react";
import { useNotification } from "../../context/NotificationContext";

export const secretInputCls =
  "w-full bg-black/40 border border-border rounded-xl px-4 py-2.5 pr-10 text-sm font-mono text-foreground focus:outline-none focus:border-theme-500/50 transition-colors";
export const textInputCls =
  "w-full bg-black/40 border border-border rounded-xl px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-theme-500/50 transition-colors";
export const fieldLabelCls = "block text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2";

/**
 * Loads the integration settings once and lets each section save ONLY its own keys
 * (PUT /api/system/settings merges per key, so sections never overwrite each other).
 */
export function useIntegrationSettings() {
  const { notify } = useNotification();
  const [data, setData] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    axios
      .get("/api/system/integrations")
      .then((res) => alive && setData(res.data || {}))
      .catch(() => {
        if (alive) {
          setData({});
          notify("Failed to load integration settings.", "error");
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      setSaving(true);
      try {
        await axios.put("/api/system/settings", patch);
        notify("Settings saved.", "success");
      } catch (e: any) {
        notify(e.response?.data?.error || "Failed to save settings.", "error");
      } finally {
        setSaving(false);
      }
    },
    [notify]
  );

  return { data, loaded: data !== null, saving, save, notify };
}

export function SecretInput({
  value, onChange, placeholder, className = "",
}: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className={secretInputCls}
      />
      <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

export function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-theme-500" : "bg-zinc-700"}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

export function SectionCard({
  icon, title, description, onSave, saving, children,
}: { icon: React.ReactNode; title: string; description: string; onSave: () => void; saving: boolean; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border-subtle rounded-2xl p-6 md:p-8 shadow-xl">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div>
          <h2 className="text-xl font-bold flex items-center text-foreground">
            <span className="mr-3 text-theme-400 flex">{icon}</span> {title}
          </h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">{description}</p>
        </div>
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-theme-500 hover:bg-theme-600 text-foreground font-medium rounded-xl transition-all shadow-sm disabled:opacity-50 shrink-0"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
      {children}
    </div>
  );
}

export function LoadingCard({ label }: { label: string }) {
  return <div className="text-muted-foreground animate-pulse p-6">{label}</div>;
}
