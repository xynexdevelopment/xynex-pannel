import React, { useMemo, useState, useEffect } from "react";
import axios from "axios";
import {
  Shield, Crown, Search, Plus, X, RefreshCw, Download, Power, Ban, Trash2, KeyRound,
  Copy, Eye, EyeOff, Wand2, Users as UsersIcon, UserCheck, Activity, ChevronDown,
  ArrowUpDown, Chrome, Check, LogOut,
} from "lucide-react";
import { useNotification } from "../context/NotificationContext";
import { confirmDialog } from "../lib/dialog";

type Role = "user" | "admin" | "owner";
type RoleFilter = "all" | Role | "google";
type SortKey = "newest" | "oldest" | "name" | "recent";

interface PanelUser {
  id: string;
  username: string;
  role: Role;
  isGoogleUser?: boolean;
  createdAt?: string;
  lastIp?: string | null;
  lastLoginAt?: string | null;
}

interface BannedIp { ip: string; reason?: string }

interface Props {
  users: PanelUser[];
  currentUser: { id: string; role: string };
  bannedIps: BannedIp[];
  onRefresh: () => void;
  onBannedChanged: () => void;
  onSelfPasswordChanged: () => void;
}

const ROLE_STYLE: Record<Role, string> = {
  owner: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  admin: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  user: "bg-sky-500/10 text-sky-300 border-sky-500/20",
};

const timeAgo = (iso?: string | null) => {
  if (!iso) return "Never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "Never";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};

const isActive = (iso?: string | null, withinMs = 86400000) =>
  !!iso && Date.now() - new Date(iso).getTime() < withinMs;

const hue = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
};

const genPassword = (len = 16) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, n => chars[n % chars.length]).join("");
};

const strength = (pw: string) => {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
};
const STRENGTH_LABEL = ["Too weak", "Weak", "Okay", "Strong", "Excellent"];
const STRENGTH_COLOR = ["bg-red-500", "bg-red-500", "bg-amber-500", "bg-emerald-500", "bg-emerald-400"];

const Avatar = ({ name, size = 36 }: { name: string; size?: number }) => {
  const h = hue(name);
  return (
    <div
      className="rounded-xl flex items-center justify-center font-bold text-white shrink-0 select-none"
      style={{
        width: size, height: size, fontSize: size * 0.4,
        background: `linear-gradient(135deg, hsl(${h} 70% 48%), hsl(${(h + 40) % 360} 70% 38%))`,
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
};

const RoleBadge = ({ role }: { role: Role }) => (
  <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-md border capitalize ${ROLE_STYLE[role] || ROLE_STYLE.user}`}>
    {role === "owner" ? <Crown size={11} /> : role === "admin" ? <Shield size={11} /> : <UserCheck size={11} />}
    {role}
  </span>
);

const StatCard = ({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) => (
  <div className="flex items-center gap-3 p-4 rounded-2xl bg-muted-subtle border border-border-subtle">
    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tone}`}>{icon}</div>
    <div>
      <p className="text-2xl font-bold text-foreground leading-none">{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  </div>
);

const IconBtn = ({ title, onClick, hover, children, disabled }: { title: string; onClick: () => void; hover: string; children: React.ReactNode; disabled?: boolean }) => (
  <button
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={onClick}
    className={`p-2 rounded-lg text-muted-foreground bg-muted border border-transparent transition-all disabled:opacity-30 disabled:pointer-events-none ${hover}`}
  >
    {children}
  </button>
);

export default function UsersManager({ users, currentUser, bannedIps, onRefresh, onBannedChanged, onSelfPasswordChanged }: Props) {
  const { notify } = useNotification();
  const isOwner = currentUser.role === "owner";

  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newPw, setNewPw] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showBans, setShowBans] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // create-form state
  const [cUser, setCUser] = useState("");
  const [cPass, setCPass] = useState("");
  const [cRole, setCRole] = useState<Role>("user");
  const [cShow, setCShow] = useState(false);
  const [creating, setCreating] = useState(false);

  const stats = useMemo(() => ({
    total: users.length,
    admins: users.filter(u => u.role === "admin" || u.role === "owner").length,
    google: users.filter(u => u.isGoogleUser).length,
    active: users.filter(u => isActive(u.lastLoginAt)).length,
  }), [users]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = users.filter(u => {
      if (roleFilter === "google" && !u.isGoogleUser) return false;
      if (roleFilter !== "all" && roleFilter !== "google" && u.role !== roleFilter) return false;
      if (!q) return true;
      return u.username.toLowerCase().includes(q) || (u.lastIp || "").includes(q) || u.id.includes(q);
    });
    const ts = (s?: string | null) => (s ? new Date(s).getTime() || 0 : 0);
    list = [...list].sort((a, b) => {
      if (sort === "name") return a.username.localeCompare(b.username);
      if (sort === "oldest") return ts(a.createdAt) - ts(b.createdAt);
      if (sort === "recent") return ts(b.lastLoginAt) - ts(a.lastLoginAt);
      return ts(b.createdAt) - ts(a.createdAt);
    });
    return list;
  }, [users, query, roleFilter, sort]);

  // drop selections that no longer exist
  useEffect(() => {
    setSelected(prev => new Set([...prev].filter(id => users.some(u => u.id === id))));
  }, [users]);

  const canTouch = (u: PanelUser) => u.id !== currentUser.id && (u.role !== "owner" || isOwner);
  const selectable = rows.filter(canTouch);
  const allSelected = selectable.length > 0 && selectable.every(u => selected.has(u.id));

  const toggle = (id: string) =>
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map(u => u.id)));

  const refresh = async () => {
    setRefreshing(true);
    await Promise.resolve(onRefresh());
    setTimeout(() => setRefreshing(false), 400);
  };

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); notify(`${what} copied`); } catch { notify("Copy failed"); }
  };

  // ---- actions (same endpoints the old page used) ----
  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cUser.trim().length < 3) return notify("Username must be at least 3 characters");
    if (cPass.length < 8) return notify("Password must be at least 8 characters");
    setCreating(true);
    try {
      await axios.post("/api/system/users", { username: cUser.trim(), password: cPass, role: cRole });
      notify(`User "${cUser.trim()}" created`);
      setCUser(""); setCPass(""); setCRole("user"); setShowCreate(false);
      onRefresh();
    } catch (err: any) {
      notify(err.response?.data?.error || "Error creating user");
    } finally { setCreating(false); }
  };

  const savePassword = async (u: PanelUser) => {
    if (newPw.length < 8) return notify("Password must be at least 8 characters");
    try {
      await axios.put(`/api/system/users/${u.id}/password`, { newPassword: newPw });
      notify("Password changed successfully");
      setExpanded(null); setNewPw("");
      if (u.id === currentUser.id) onSelfPasswordChanged();
    } catch (err: any) { notify(err.response?.data?.error || "Error changing password"); }
  };

  const terminate = async (u: PanelUser, silent = false) => {
    if (!silent && !await confirmDialog(`Force-logout "${u.username}" everywhere? Their current session token(s) will stop working immediately.`)) return false;
    try {
      await axios.post(`/api/system/users/${u.id}/terminate`);
      if (!silent) notify(`${u.username}'s sessions have been terminated.`);
      return true;
    } catch (err: any) { notify(err.response?.data?.error || "Failed to terminate session"); return false; }
  };

  const banIp = async (u: PanelUser) => {
    if (!await confirmDialog(`Ban the last known IP address for "${u.username}"? They (and anyone else on that IP) won't be able to reach the panel until unbanned.`)) return;
    try {
      const res = await axios.post(`/api/system/users/${u.id}/ban-ip`);
      notify(`Banned IP ${res.data.ip}.`);
      onBannedChanged();
    } catch (err: any) { notify(err.response?.data?.error || "Failed to ban IP"); }
  };

  const remove = async (u: PanelUser, silent = false) => {
    if (!silent && !await confirmDialog(`Delete "${u.username}" permanently? This cannot be undone.`)) return false;
    try { await axios.delete(`/api/system/users/${u.id}`); return true; }
    catch (err: any) { notify(err.response?.data?.error || "Failed to delete user"); return false; }
  };

  const unban = async (ip: string) => {
    if (!await confirmDialog(`Unban ${ip}?`)) return;
    try { await axios.delete(`/api/system/banned-ips/${encodeURIComponent(ip)}`); onBannedChanged(); }
    catch (err: any) { notify(err.response?.data?.error || "Failed to unban IP"); }
  };

  const bulk = async (kind: "logout" | "delete") => {
    const targets = users.filter(u => selected.has(u.id) && canTouch(u));
    if (!targets.length) return;
    const msg = kind === "delete"
      ? `Delete ${targets.length} user(s) permanently? This cannot be undone.`
      : `Force-logout ${targets.length} user(s) everywhere?`;
    if (!await confirmDialog(msg)) return;
    let ok = 0;
    for (const u of targets) {
      if (kind === "delete" ? await remove(u, true) : await terminate(u, true)) ok++;
    }
    notify(`${kind === "delete" ? "Deleted" : "Logged out"} ${ok}/${targets.length} user(s)`);
    setSelected(new Set());
    onRefresh();
  };

  const exportCsv = () => {
    const header = ["id", "username", "role", "auth", "createdAt", "lastLoginAt", "lastIp"];
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [header.join(","), ...rows.map(u =>
      [u.id, u.username, u.role, u.isGoogleUser ? "google" : "password", u.createdAt, u.lastLoginAt, u.lastIp].map(esc).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const filters: { key: RoleFilter; label: string }[] = [
    { key: "all", label: "All" }, { key: "owner", label: "Owners" }, { key: "admin", label: "Admins" },
    { key: "user", label: "Users" }, { key: "google", label: "Google" },
  ];
  const pwScore = strength(cPass);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-foreground flex items-center gap-2.5">
            <UsersIcon className="text-theme-400" size={24} /> Users
          </h2>
          <p className="text-sm text-muted-foreground mt-1">All registered users on the system.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-theme-500 hover:bg-theme-600 text-white text-sm font-semibold shadow-lg shadow-theme-500/20 ring-1 ring-white/10 transition-all active:scale-[0.97]"
        >
          <Plus size={16} /> Create New
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<UsersIcon size={18} />} label="Total users" value={stats.total} tone="bg-theme-500/15 text-theme-400" />
        <StatCard icon={<Shield size={18} />} label="Admins & owners" value={stats.admins} tone="bg-purple-500/15 text-purple-300" />
        <StatCard icon={<Chrome size={18} />} label="Google sign-in" value={stats.google} tone="bg-amber-500/15 text-amber-300" />
        <StatCard icon={<Activity size={18} />} label="Active in 24h" value={stats.active} tone="bg-emerald-500/15 text-emerald-300" />
      </div>

      {/* Table card */}
      <div className="bg-card border border-border-subtle rounded-2xl shadow-xl overflow-hidden">
        {/* Toolbar */}
        <div className="p-4 flex flex-wrap items-center gap-3 border-b border-border-subtle">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search name, IP or ID…"
              className="w-full bg-muted border border-border focus:border-theme-500 focus:ring-1 focus:ring-theme-500/40 rounded-xl pl-9 pr-8 py-2 text-sm text-foreground outline-none transition-all"
            />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 p-1 rounded-xl bg-muted border border-border-subtle overflow-x-auto">
            {filters.map(f => (
              <button key={f.key} onClick={() => setRoleFilter(f.key)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${roleFilter === f.key ? "bg-theme-500 text-white shadow" : "text-muted-foreground hover:text-foreground"}`}>
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <div className="relative">
              <ArrowUpDown size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
                className="appearance-none bg-muted border border-border rounded-xl pl-8 pr-7 py-2 text-xs font-medium text-foreground outline-none focus:border-theme-500">
                <option value="newest" className="bg-zinc-900">Newest first</option>
                <option value="oldest" className="bg-zinc-900">Oldest first</option>
                <option value="name" className="bg-zinc-900">Name A–Z</option>
                <option value="recent" className="bg-zinc-900">Recently active</option>
              </select>
              <ChevronDown size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            </div>
            <IconBtn title="Export CSV" onClick={exportCsv} hover="hover:text-foreground hover:bg-muted"><Download size={15} /></IconBtn>
            <IconBtn title="Refresh" onClick={refresh} hover="hover:text-foreground hover:bg-muted">
              <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            </IconBtn>
          </div>
        </div>

        {/* Bulk bar */}
        {selected.size > 0 && (
          <div className="px-4 py-2.5 flex flex-wrap items-center gap-3 bg-theme-500/10 border-b border-theme-500/20 text-sm">
            <span className="font-semibold text-theme-300">{selected.size} selected</span>
            <button onClick={() => bulk("logout")} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 transition-colors">
              <LogOut size={13} /> Force logout
            </button>
            <button onClick={() => bulk("delete")} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-red-300 bg-red-500/10 hover:bg-red-500/20 transition-colors">
              <Trash2 size={13} /> Delete
            </button>
            <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Clear</button>
          </div>
        )}

        {/* Column header (desktop) */}
        <div className="hidden md:grid grid-cols-[32px_minmax(180px,2fr)_100px_120px_130px_minmax(150px,1fr)_auto] gap-4 px-5 py-3 text-[11px] font-semibold text-muted-foreground border-b border-border-subtle bg-muted-subtle">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" className="accent-theme-500 w-4 h-4 self-center" />
          <span>User</span><span>Role</span><span>Sign-in</span><span>Last login</span><span>Last IP</span>
          <span className="w-[200px] text-right">Actions</span>
        </div>

        {/* Rows */}
        {rows.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <UsersIcon size={32} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm">{users.length === 0 ? "No users yet." : "No users match your filters."}</p>
            {(query || roleFilter !== "all") && (
              <button onClick={() => { setQuery(""); setRoleFilter("all"); }} className="mt-3 text-xs text-theme-400 hover:underline">Reset filters</button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {rows.map(u => {
              const me = u.id === currentUser.id;
              const touch = canTouch(u);
              const open = expanded === u.id;
              const online = isActive(u.lastLoginAt, 15 * 60 * 1000);
              return (
                <div key={u.id} className={`${selected.has(u.id) ? "bg-theme-500/5" : "hover:bg-muted-subtle"} transition-colors`}>
                  <div className="grid md:grid-cols-[32px_minmax(180px,2fr)_100px_120px_130px_minmax(150px,1fr)_auto] grid-cols-[32px_1fr_auto] gap-x-4 gap-y-2 px-5 py-3.5 items-center">
                    <input type="checkbox" disabled={!touch} checked={selected.has(u.id)} onChange={() => toggle(u.id)}
                      aria-label={`Select ${u.username}`} className="accent-theme-500 w-4 h-4 disabled:opacity-20" />

                    <div className="flex items-center gap-3 min-w-0">
                      <div className="relative">
                        <Avatar name={u.username} />
                        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[var(--bg-card,#18181b)] ${online ? "bg-emerald-400" : "bg-zinc-600"}`} title={online ? "Active recently" : "Offline"} />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground truncate flex items-center gap-2">
                          {u.username}
                          {me && <span className="text-[10px] font-bold bg-theme-500/20 text-theme-300 px-1.5 py-0.5 rounded border border-theme-500/20">You</span>}
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">Joined {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"} · ID {u.id}</p>
                      </div>
                    </div>

                    <div className="md:block hidden"><RoleBadge role={u.role} /></div>
                    <div className="md:block hidden text-xs">
                      {u.isGoogleUser
                        ? <span className="inline-flex items-center gap-1 text-amber-300"><Chrome size={13} /> Google</span>
                        : <span className="inline-flex items-center gap-1 text-muted-foreground"><KeyRound size={13} /> Password</span>}
                    </div>
                    <div className="md:block hidden text-xs text-muted-foreground" title={u.lastLoginAt || ""}>{timeAgo(u.lastLoginAt)}</div>
                    <div className="md:block hidden">
                      {u.lastIp ? (
                        <button onClick={() => copy(u.lastIp!, "IP")} className="group inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground" title="Click to copy">
                          {u.lastIp} <Copy size={11} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      ) : <span className="text-xs text-muted-foreground/50">—</span>}
                    </div>

                    <div className="flex items-center gap-1.5 md:w-[200px] justify-end col-start-3 md:col-start-auto">
                      <IconBtn title="Copy username" onClick={() => copy(u.username, "Username")} hover="hover:text-foreground hover:bg-muted"><Copy size={15} /></IconBtn>
                      <IconBtn title={u.isGoogleUser ? "Google accounts have no password" : "Change password"} disabled={!touch && !me || !!u.isGoogleUser}
                        onClick={() => { setExpanded(open ? null : u.id); setNewPw(""); setShowNewPw(false); }}
                        hover="hover:text-theme-400 hover:bg-theme-500/10 hover:border-theme-500/30"><KeyRound size={15} /></IconBtn>
                      <IconBtn title="Force logout" disabled={!touch} onClick={() => terminate(u)} hover="hover:text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/30"><Power size={15} /></IconBtn>
                      <IconBtn title={u.lastIp ? `Ban IP ${u.lastIp}` : "No known IP yet"} disabled={!touch || !u.lastIp} onClick={() => banIp(u)} hover="hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30"><Ban size={15} /></IconBtn>
                      <IconBtn title="Delete user" disabled={!touch} onClick={async () => { if (await remove(u)) onRefresh(); }} hover="hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30"><Trash2 size={15} /></IconBtn>
                    </div>

                    {/* mobile meta */}
                    <div className="md:hidden col-span-3 flex flex-wrap items-center gap-2 pl-[calc(32px+1rem)] text-xs text-muted-foreground">
                      <RoleBadge role={u.role} />
                      <span>{u.isGoogleUser ? "Google" : "Password"}</span>
                      <span>· {timeAgo(u.lastLoginAt)}</span>
                      {u.lastIp && <span className="font-mono">· {u.lastIp}</span>}
                    </div>
                  </div>

                  {open && (
                    <div className="px-5 pb-4 md:pl-[calc(32px+2.25rem)]">
                      <div className="flex flex-wrap gap-2 p-3 rounded-xl bg-muted-subtle border border-border-subtle">
                        <div className="relative flex-1 min-w-[220px]">
                          <input autoFocus type={showNewPw ? "text" : "password"} value={newPw} onChange={e => setNewPw(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && savePassword(u)}
                            placeholder="New password (min 8 chars)"
                            className="w-full bg-muted border border-border focus:border-theme-500 rounded-lg pl-3 pr-9 py-2 text-sm text-foreground outline-none" />
                          <button type="button" onClick={() => setShowNewPw(s => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Toggle visibility">
                            {showNewPw ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                        <button onClick={() => { const p = genPassword(); setNewPw(p); setShowNewPw(true); }} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-theme-300 bg-theme-500/10 hover:bg-theme-500/20 transition-colors">
                          <Wand2 size={13} /> Generate
                        </button>
                        {newPw && <button onClick={() => copy(newPw, "Password")} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-muted-foreground bg-muted hover:text-foreground transition-colors"><Copy size={13} /> Copy</button>}
                        <button onClick={() => savePassword(u)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-theme-500 hover:bg-theme-600 transition-colors">
                          <Check size={14} /> Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="px-5 py-3 text-xs text-muted-foreground border-t border-border-subtle flex justify-between">
          <span>Showing {rows.length} of {users.length} users</span>
          <span>Active = logged in within 15 min</span>
        </div>
      </div>

      {/* Banned IPs */}
      {bannedIps.length > 0 && (
        <div className="bg-card border border-border-subtle rounded-2xl overflow-hidden">
          <button onClick={() => setShowBans(s => !s)} className="w-full flex items-center justify-between px-5 py-4 text-left">
            <span className="font-semibold text-foreground flex items-center gap-2"><Ban size={16} className="text-red-400" /> Banned IP addresses <span className="text-xs text-muted-foreground font-normal">({bannedIps.length})</span></span>
            <ChevronDown size={16} className={`text-muted-foreground transition-transform ${showBans ? "rotate-180" : ""}`} />
          </button>
          {showBans && (
            <div className="px-5 pb-4 space-y-2">
              {bannedIps.map(b => (
                <div key={b.ip} className="flex items-center justify-between p-3 bg-muted-subtle border border-border-subtle rounded-xl">
                  <div>
                    <p className="font-mono text-sm text-foreground">{b.ip}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{b.reason || "No reason given"}</p>
                  </div>
                  <button onClick={() => unban(b.ip)} className="px-3 py-1.5 text-xs font-semibold text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg transition-colors">Unban</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onMouseDown={e => e.target === e.currentTarget && setShowCreate(false)}>
          <form onSubmit={submitCreate} className="w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-foreground">Create new user</h3>
              <button type="button" onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close"><X size={18} /></button>
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1.5">Username</label>
              <input autoFocus required minLength={3} value={cUser} onChange={e => setCUser(e.target.value)}
                className="w-full bg-muted border border-border focus:border-theme-500 focus:ring-1 focus:ring-theme-500/40 rounded-xl px-4 py-2.5 text-foreground outline-none" />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-muted-foreground">Password</label>
                <button type="button" onClick={() => { setCPass(genPassword()); setCShow(true); }} className="inline-flex items-center gap-1 text-xs font-semibold text-theme-400 hover:text-theme-300">
                  <Wand2 size={12} /> Generate strong
                </button>
              </div>
              <div className="relative">
                <input required minLength={8} type={cShow ? "text" : "password"} value={cPass} onChange={e => setCPass(e.target.value)}
                  className="w-full bg-muted border border-border focus:border-theme-500 focus:ring-1 focus:ring-theme-500/40 rounded-xl pl-4 pr-20 py-2.5 text-foreground outline-none font-mono text-sm" />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                  {cPass && <button type="button" onClick={() => copy(cPass, "Password")} className="p-1.5 text-muted-foreground hover:text-foreground" aria-label="Copy password"><Copy size={14} /></button>}
                  <button type="button" onClick={() => setCShow(s => !s)} className="p-1.5 text-muted-foreground hover:text-foreground" aria-label="Toggle visibility">{cShow ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                </div>
              </div>
              {cPass && (
                <div className="mt-2">
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map(i => <div key={i} className={`h-1 flex-1 rounded-full ${i < pwScore ? STRENGTH_COLOR[pwScore] : "bg-muted"}`} />)}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">{STRENGTH_LABEL[pwScore]}</p>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1.5">Role</label>
              <div className="grid grid-cols-3 gap-2">
                {(["user", "admin", ...(isOwner ? ["owner"] : [])] as Role[]).map(r => (
                  <button key={r} type="button" onClick={() => setCRole(r)}
                    className={`py-2 rounded-xl text-sm font-semibold capitalize border transition-all ${cRole === r ? "bg-theme-500/20 border-theme-500 text-theme-300" : "bg-muted border-border text-muted-foreground hover:text-foreground"}`}>
                    {r}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                {cRole === "user" ? "Can manage their own servers only." : cRole === "admin" ? "Full access to the admin panel." : "Highest level — can manage other admins."}
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-muted-foreground bg-muted hover:text-foreground transition-colors">Cancel</button>
              <button disabled={creating} type="submit" className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-theme-500 hover:bg-theme-600 disabled:opacity-50 transition-colors">
                {creating ? "Creating…" : "Create user"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
