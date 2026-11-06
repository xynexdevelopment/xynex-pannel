import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  Bot, Save, RefreshCw, Eye, EyeOff, Copy, Check, Key, Terminal, ShieldCheck, Bell, ScrollText, Trash2, CircleHelp, ChevronDown,
} from "lucide-react";
import { useNotification } from "../context/NotificationContext";
import { confirmDialog } from "../lib/dialog";

interface BotConfig {
  enabled: boolean;
  tokenSet: boolean;
  tokenHint: string;
  clientId: string;
  guildId: string;
  allowedUserIds: string[];
  allowedRoleIds: string[];
  adminUserIds: string[];
  adminRoleIds: string[];
  notifyChannelId: string;
  logChannelId: string;
  status: { state: string; tag: string | null; guilds: number; error: string | null; lastSeenSecondsAgo: number | null };
}

const STATE_UI: Record<string, { label: string; dot: string; text: string }> = {
  online: { label: "Online", dot: "bg-emerald-400", text: "text-emerald-300" },
  waiting: { label: "Waiting for token", dot: "bg-amber-400", text: "text-amber-300" },
  disabled: { label: "Disabled", dot: "bg-zinc-500", text: "text-zinc-300" },
  error: { label: "Error", dot: "bg-red-400", text: "text-red-300" },
  offline: { label: "Not connected", dot: "bg-zinc-600", text: "text-zinc-400" },
};

const inputCls =
  "w-full bg-muted border border-border focus:border-theme-500 focus:ring-1 focus:ring-theme-500/40 rounded-xl px-3.5 py-2.5 text-sm text-foreground outline-none transition-all placeholder:text-muted-foreground/60";

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-xs font-semibold text-muted-foreground mb-1.5">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-muted-foreground/70 mt-1">{hint}</p>}
  </div>
);

export default function DiscordBotManager() {
  const { notify } = useNotification();
  const [cfg, setCfg] = useState<BotConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // editable form state
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [clientId, setClientId] = useState("");
  const [guildId, setGuildId] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [allowedRoles, setAllowedRoles] = useState("");
  const [adminUsers, setAdminUsers] = useState("");
  const [adminRoles, setAdminRoles] = useState("");
  const [notifyCh, setNotifyCh] = useState("");
  const [logCh, setLogCh] = useState("");

  // quick-setup state
  const [botKey, setBotKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [copied, setCopied] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [panelUrl, setPanelUrl] = useState("http://127.0.0.1:6767");

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const applyToForm = (c: BotConfig) => {
    setEnabled(c.enabled);
    setClientId(c.clientId); setGuildId(c.guildId);
    setAllowedUsers(c.allowedUserIds.join(", ")); setAllowedRoles(c.allowedRoleIds.join(", "));
    setAdminUsers(c.adminUserIds.join(", ")); setAdminRoles(c.adminRoleIds.join(", "));
    setNotifyCh(c.notifyChannelId); setLogCh(c.logChannelId);
  };

  const fetchConfig = async (initial = false) => {
    try {
      const res = await axios.get<BotConfig>("/api/admin/discord-bot");
      setCfg(res.data);
      setLoadError("");
      if (initial || !dirtyRef.current) applyToForm(res.data); // never overwrite what the admin is typing
    } catch (e: any) {
      setLoadError(e.response?.data?.error || "Could not load bot settings");
    }
  };

  useEffect(() => {
    fetchConfig(true);
    const iv = setInterval(() => fetchConfig(false), 5000);
    return () => clearInterval(iv);
  }, []);

  const touch = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setDirty(true); };

  const save = async (extra: Record<string, unknown> = {}) => {
    setSaving(true);
    try {
      const res = await axios.put<BotConfig>("/api/admin/discord-bot", {
        enabled, clientId, guildId,
        allowedUserIds: allowedUsers, allowedRoleIds: allowedRoles,
        adminUserIds: adminUsers, adminRoleIds: adminRoles,
        notifyChannelId: notifyCh, logChannelId: logCh,
        ...(token.trim() ? { token: token.trim() } : {}),
        ...extra,
      });
      setCfg(res.data); applyToForm(res.data);
      setToken(""); setDirty(false);
      notify("Discord bot settings saved. The bot reloads itself within ~15 seconds.");
    } catch (e: any) {
      notify(e.response?.data?.error || "Failed to save bot settings");
    } finally { setSaving(false); }
  };

  const restart = async () => {
    try { await axios.post("/api/admin/discord-bot/restart"); notify("Restart requested — the bot reloads within ~15 seconds."); }
    catch (e: any) { notify(e.response?.data?.error || "Failed to restart bot"); }
  };

  const removeToken = async () => {
    if (!await confirmDialog("Remove the saved Discord bot token? The bot will stop until you add a new one.")) return;
    await save({ clearToken: true });
  };

  const createBotKey = async () => {
    setCreatingKey(true);
    try {
      const res = await axios.post("/api/admin/api-keys", { label: "Discord Bot", scopes: ["*"] });
      setBotKey(res.data.key);
    } catch (e: any) { notify(e.response?.data?.error || "Failed to create API key"); }
    finally { setCreatingKey(false); }
  };

  const copy = async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(""), 1800); }
    catch { notify("Copy failed"); }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const cleanUrl = panelUrl.trim().replace(/\/+$/, "");
  const installCmd = botKey ? `cd discord-bot && PANEL_URL="${cleanUrl}" PANEL_API_KEY="${botKey}" bash setup.sh` : "";
  const st = STATE_UI[cfg?.status.state || "offline"] || STATE_UI.offline;

  return (
    <div className="mt-10 bg-card border border-border-subtle rounded-3xl p-6 md:p-8 shadow-xl relative overflow-hidden">
      <div className="absolute -top-24 -right-24 w-64 h-64 bg-[#5865F2]/10 blur-3xl rounded-full pointer-events-none" />

      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6 relative">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-[#5865F2] flex items-center justify-center shadow-lg shadow-[#5865F2]/30">
            <Bot className="text-white" size={24} />
          </div>
          <div>
            <h3 className="text-xl font-bold text-foreground">Discord Bot</h3>
            <p className="text-sm text-muted-foreground">Manage your servers from Discord. Token and permissions are set here — no files to edit.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted border border-border-subtle text-xs font-semibold ${st.text}`}>
            <span className={`w-2 h-2 rounded-full ${st.dot} ${cfg?.status.state === "online" ? "animate-pulse" : ""}`} />
            {st.label}
            {cfg?.status.state === "online" && cfg.status.tag && <span className="text-muted-foreground font-normal">· {cfg.status.tag} · {cfg.status.guilds} server{cfg.status.guilds === 1 ? "" : "s"}</span>}
          </div>
          <button onClick={() => setShowHelp(s => !s)} title="How it works" aria-label="How it works" className="p-2 rounded-lg text-muted-foreground bg-muted hover:text-foreground transition-colors"><CircleHelp size={16} /></button>
        </div>
      </div>

      {cfg?.status.state === "error" && cfg.status.error && (
        <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300">Bot error: {cfg.status.error}</div>
      )}
      {loadError && <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300">{loadError}</div>}

      {showHelp && (
        <div className="mb-6 p-4 rounded-2xl bg-muted-subtle border border-border-subtle text-sm text-muted-foreground space-y-1.5">
          <p><span className="text-foreground font-semibold">1.</span> Create a bot at <span className="font-mono">discord.com/developers/applications</span> → <b>Bot</b> → <b>Reset Token</b>, and invite it with scopes <span className="font-mono">bot</span> + <span className="font-mono">applications.commands</span>.</p>
          <p><span className="text-foreground font-semibold">2.</span> Below, click <b>Create bot API key</b> and run the shown command once on the machine where the bot will live.</p>
          <p><span className="text-foreground font-semibold">3.</span> Paste the bot token, your Discord user ID (owner) and a logs channel ID, then save. Done — use <span className="font-mono">/server</span> in Discord.</p>
          <p className="text-[12px]">Turn on Developer Mode in Discord (Settings → Advanced) to copy IDs via right-click → Copy ID.</p>
        </div>
      )}

      {/* quick setup */}
      <div className="mb-8 p-4 rounded-2xl bg-muted-subtle border border-border-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Terminal size={18} className="text-theme-400" />
            <div>
              <p className="text-sm font-semibold text-foreground">Connect the bot to this panel</p>
              <p className="text-xs text-muted-foreground">Creates an API key labelled “Discord Bot” and gives you the one-line install command.</p>
            </div>
          </div>
          {!botKey && (
            <button onClick={createBotKey} disabled={creatingKey} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-theme-500 hover:bg-theme-600 text-white text-sm font-semibold disabled:opacity-50 transition-colors">
              <Key size={15} /> {creatingKey ? "Creating…" : "Create bot API key"}
            </button>
          )}
        </div>
        <div className="mt-4">
          <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Panel URL the bot will use</label>
          <div className="flex flex-wrap gap-2">
            <input value={panelUrl} onChange={e => setPanelUrl(e.target.value)} spellCheck={false} placeholder="http://127.0.0.1:6767" className={`${inputCls} flex-1 min-w-[220px] font-mono`} />
            <button type="button" onClick={() => setPanelUrl("http://127.0.0.1:6767")} className="px-3 py-2 rounded-xl bg-muted hover:bg-muted/80 text-xs font-semibold text-foreground">Same server</button>
            <button type="button" onClick={() => setPanelUrl(origin)} className="px-3 py-2 rounded-xl bg-muted hover:bg-muted/80 text-xs font-semibold text-foreground">This page’s URL</button>
          </div>
          <p className="text-[11px] text-muted-foreground/70 mt-1">Bot runs on the same server/Codespace as the panel? Use “Same server”. Different machine? Use the public URL. The command below updates automatically.</p>
        </div>
        {botKey && (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-amber-300">Copy this now — the key is shown only once. It is also listed above under API Keys and can be revoked any time.</p>
            <div className="flex items-stretch gap-2">
              <pre className="flex-1 overflow-x-auto bg-black/40 border border-border-subtle rounded-xl p-3 text-[12px] font-mono text-emerald-300 whitespace-pre-wrap break-all">{installCmd}</pre>
              <button onClick={() => copy(installCmd, "cmd")} className="px-3 rounded-xl bg-muted hover:bg-muted/80 text-foreground" aria-label="Copy command">
                {copied === "cmd" ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">Run it inside the panel folder. Running it again fixes a wrong URL in the bot’s .env — no manual editing needed.</p>
          </div>
        )}
      </div>

      {/* settings form */}
      <div className="space-y-6">
        <div className="grid md:grid-cols-2 gap-5">
          <div className="md:col-span-2">
            <Field label="Bot token" hint="Developer Portal → your app → Bot → Reset Token. Stored encrypted; never shown again.">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showToken ? "text" : "password"} autoComplete="off" spellCheck={false}
                    value={token} onChange={e => touch(setToken)(e.target.value)}
                    placeholder={cfg?.tokenSet ? `Saved ••••••••${cfg.tokenHint} — paste a new token to replace it` : "Paste your Discord bot token"}
                    className={`${inputCls} pr-10 font-mono`}
                  />
                  <button type="button" onClick={() => setShowToken(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Toggle visibility">
                    {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {cfg?.tokenSet && (
                  <button onClick={removeToken} title="Remove saved token" aria-label="Remove saved token" className="px-3 rounded-xl text-red-300 bg-red-500/10 hover:bg-red-500/20 transition-colors"><Trash2 size={16} /></button>
                )}
              </div>
            </Field>
          </div>

          <Field label="Owner — your Discord user ID" hint="You get full control (incl. /command console and /kill). Several IDs? Comma separated.">
            <input value={adminUsers} onChange={e => touch(setAdminUsers)(e.target.value)} placeholder="your Discord user ID" className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Logs channel ID" hint="Logs who started/stopped/ran what. Also gets “server went online/offline” alerts.">
            <div className="relative"><ScrollText size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={logCh} onChange={e => touch(setLogCh)(e.target.value)} placeholder="channel ID" className={`${inputCls} pl-9 font-mono`} /></div>
          </Field>
        </div>

        <div className="rounded-2xl border border-border-subtle">
          <button type="button" onClick={() => setShowAdvanced(v => !v)} aria-expanded={showAdvanced}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-foreground">
            <span className="flex items-center gap-2"><ShieldCheck size={16} className="text-theme-400" /> Advanced (optional)</span>
            <ChevronDown size={16} className={`text-muted-foreground transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
          </button>
          {showAdvanced && (
            <div className="px-4 pb-4 space-y-5">
              <div className="grid md:grid-cols-2 gap-4">
                <Field label="Discord server ID" hint="Empty = commands are added to every server the bot is in.">
                  <input value={guildId} onChange={e => touch(setGuildId)(e.target.value)} className={`${inputCls} font-mono`} />
                </Field>
                <Field label="Application (client) ID" hint="Detected automatically from the token.">
                  <input value={clientId} onChange={e => touch(setClientId)(e.target.value)} placeholder="auto" className={`${inputCls} font-mono`} />
                </Field>
                <Field label="Bot admins — role IDs">
                  <input value={adminRoles} onChange={e => touch(setAdminRoles)(e.target.value)} className={`${inputCls} font-mono`} />
                </Field>
                <Field label="Status alerts channel ID" hint="Empty = alerts go to the logs channel.">
                  <div className="relative"><Bell size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input value={notifyCh} onChange={e => touch(setNotifyCh)(e.target.value)} className={`${inputCls} pl-9 font-mono`} /></div>
                </Field>
                <Field label="Allowed users — user IDs" hint="View + start/stop/restart/backup.">
                  <input value={allowedUsers} onChange={e => touch(setAllowedUsers)(e.target.value)} className={`${inputCls} font-mono`} />
                </Field>
                <Field label="Allowed roles — role IDs">
                  <input value={allowedRoles} onChange={e => touch(setAllowedRoles)(e.target.value)} className={`${inputCls} font-mono`} />
                </Field>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <label className="inline-flex items-center gap-3 cursor-pointer select-none">
            <button type="button" role="switch" aria-checked={enabled} onClick={() => touch(setEnabled)(!enabled)}
              className={`w-11 h-6 rounded-full transition-colors relative ${enabled ? "bg-theme-500" : "bg-muted border border-border"}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
            </button>
            <span className="text-sm text-foreground">Bot enabled</span>
          </label>
          <div className="flex items-center gap-3">
            <button onClick={restart} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-muted hover:bg-muted/80 text-foreground text-sm font-semibold transition-colors">
              <RefreshCw size={15} /> Restart bot
            </button>
            <button onClick={() => save()} disabled={saving || !dirty}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-theme-500 hover:bg-theme-600 text-white text-sm font-semibold disabled:opacity-40 disabled:pointer-events-none shadow-lg shadow-theme-500/20 transition-all active:scale-[0.97]">
              <Save size={15} /> {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
