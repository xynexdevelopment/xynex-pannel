import React, { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users as UsersIcon, Search, Plus, RefreshCw, ArrowLeft, Star, ShieldCheck, ShieldOff, Server as ServerIcon,
  Eye, EyeOff, Wand2, Copy, Check, Power, Ban, Trash2, KeyRound, UserX, UserCheck, Mail, User as UserIcon,
  ChevronLeft, ChevronRight, Chrome, MessageCircle, ExternalLink, StickyNote, AlertTriangle, Save,
} from "lucide-react";
import { useNotification } from "../context/NotificationContext";
import { confirmDialog } from "../lib/dialog";

/* -------------------------------------------------------------------------- */
/* Types + helpers                                                            */
/* -------------------------------------------------------------------------- */

interface PanelUser {
  id: string;
  username: string;
  email: string | null;
  firstName: string;
  lastName: string;
  role: "user" | "admin" | "owner" | string;
  isGoogleUser: boolean;
  twoFactorEnabled: boolean;
  discordConnected: boolean;
  suspended: boolean;
  suspendedReason: string;
  notes: string;
  createdAt: string | null;
  lastIp: string | null;
  lastLoginAt: string | null;
  serversOwned: number;
  canAccess: number;
}

interface UserDetail extends PanelUser {
  ownedServers: { id: string; name: string; type: string | null }[];
  sharedServers: { id: string; name: string; type: string | null }[];
}

interface Props {
  currentUser: { id: string; role: string; username?: string };
  bannedIps: any[];
  onBannedIpsChanged: () => void;
  onUnbanIp: (ip: string) => void;
  /** Called whenever the user list changes so the dashboard counters stay in sync. */
  onUsersChanged?: () => void;
}

type View = { mode: "list" } | { mode: "create" } | { mode: "edit"; id: string };

const inputCls =
  "w-full bg-muted border border-border focus:border-theme-500 focus:ring-1 focus:ring-theme-500/50 rounded-xl px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 transition-all shadow-inner outline-none disabled:opacity-50 disabled:cursor-not-allowed";
const labelCls = "block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5";
const primaryBtn =
  "inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-theme-500 hover:bg-theme-600 text-white text-sm font-semibold shadow-sm transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed";
const ghostBtn =
  "inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-muted hover:bg-muted/70 border border-border-subtle text-sm font-medium text-foreground transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed";

const fullName = (u: Pick<PanelUser, "firstName" | "lastName">) => `${u.firstName || ""} ${u.lastName || ""}`.trim();

const formatDate = (iso: string | null) => {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const timeAgo = (iso: string | null) => {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "—";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
};

/** Cryptographically random password, 20 chars, always contains every character class. */
function generatePassword(length = 20): string {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+?";
  const all = lower + upper + digits + symbols;
  const pick = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function passwordStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const capped = Math.min(score, 4);
  const labels = ["Too weak", "Weak", "Okay", "Good", "Strong"];
  const colors = ["bg-red-500", "bg-red-500", "bg-amber-500", "bg-emerald-500", "bg-emerald-500"];
  return { score: capped, label: pw ? labels[capped] : "", color: colors[capped] };
}

function RoleBadge({ role }: { role: string }) {
  if (role === "owner")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">
        <Star size={11} className="fill-amber-400" /> Owner
      </span>
    );
  if (role === "admin")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-purple-500/10 text-purple-400 border border-purple-500/30">
        <Star size={11} className="fill-purple-400" /> Admin
      </span>
    );
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-zinc-500/10 text-zinc-400 border border-zinc-500/30">
      User
    </span>
  );
}

function SuspendedBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-500/10 text-red-400 border border-red-500/30">
      <UserX size={11} /> Suspended
    </span>
  );
}

function Card({ title, icon, children, tone = "default", description }: { title: string; icon?: React.ReactNode; children: React.ReactNode; tone?: "default" | "danger"; description?: string }) {
  return (
    <div className={`rounded-2xl border bg-card shadow-xl overflow-hidden ${tone === "danger" ? "border-red-500/30" : "border-border-subtle"}`}>
      <div className={`px-6 py-4 border-b ${tone === "danger" ? "border-red-500/20 bg-red-500/5" : "border-border-subtle bg-muted-subtle"}`}>
        <h3 className={`flex items-center gap-2 text-sm font-bold uppercase tracking-wider ${tone === "danger" ? "text-red-400" : "text-foreground"}`}>
          {icon}
          {title}
        </h3>
        {description && <p className="text-xs text-muted-foreground mt-1 normal-case tracking-normal font-normal">{description}</p>}
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${checked ? "bg-theme-500" : "bg-zinc-600/60"}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

function PasswordField({ value, onChange, placeholder, id }: { value: string; onChange: (v: string) => void; placeholder?: string; id?: string }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const strength = passwordStrength(value);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable on http origins */
    }
  };
  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            id={id}
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            autoComplete="new-password"
            className={`${inputCls} pr-11 font-mono`}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            title={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(generatePassword());
            setShow(true);
          }}
          className={ghostBtn}
          title="Generate a strong random password"
        >
          <Wand2 size={15} /> Generate
        </button>
        <button type="button" onClick={copy} disabled={!value} className={ghostBtn} title="Copy password">
          {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
        </button>
      </div>
      {value && (
        <div className="mt-2 flex items-center gap-3">
          <div className="flex-1 flex gap-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`h-1 flex-1 rounded-full ${i < strength.score ? strength.color : "bg-zinc-700/60"}`} />
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground w-16 text-right">{strength.label}</span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Main component                                                             */
/* -------------------------------------------------------------------------- */

export default function AdminUsers({ currentUser, bannedIps, onBannedIpsChanged, onUnbanIp, onUsersChanged }: Props) {
  const { notify } = useNotification();
  const [view, setView] = useState<View>({ mode: "list" });
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await axios.get("/api/system/users");
      setUsers(res.data);
    } catch (e: any) {
      notify(e.response?.data?.error || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const refreshAll = useCallback(async () => {
    await fetchUsers();
    onUsersChanged?.();
  }, [fetchUsers, onUsersChanged]);

  return (
    <AnimatePresence mode="wait">
      <motion.div key={view.mode + ("id" in view ? view.id : "")} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
        {view.mode === "list" && (
          <UserList
            users={users}
            loading={loading}
            currentUser={currentUser}
            bannedIps={bannedIps}
            onUnbanIp={onUnbanIp}
            onRefresh={refreshAll}
            onCreate={() => setView({ mode: "create" })}
            onOpen={(id) => setView({ mode: "edit", id })}
          />
        )}
        {view.mode === "create" && (
          <CreateUser
            currentUser={currentUser}
            onBack={() => setView({ mode: "list" })}
            onCreated={async (id) => {
              await refreshAll();
              setView({ mode: "edit", id });
            }}
          />
        )}
        {view.mode === "edit" && (
          <EditUser
            id={view.id}
            currentUser={currentUser}
            onBack={() => setView({ mode: "list" })}
            onChanged={refreshAll}
            onBannedIpsChanged={onBannedIpsChanged}
          />
        )}
      </motion.div>
    </AnimatePresence>
  );
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

function UserList({
  users, loading, currentUser, bannedIps, onUnbanIp, onRefresh, onCreate, onOpen,
}: {
  users: PanelUser[];
  loading: boolean;
  currentUser: Props["currentUser"];
  bannedIps: any[];
  onUnbanIp: (ip: string) => void;
  onRefresh: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "admin" | "owner">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "suspended" | "no2fa" | "with-servers">("all");
  const [sort, setSort] = useState<"created" | "username" | "lastLogin" | "servers">("created");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [spinning, setSpinning] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = users.filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (statusFilter === "suspended" && !u.suspended) return false;
      if (statusFilter === "no2fa" && u.twoFactorEnabled) return false;
      if (statusFilter === "with-servers" && u.serversOwned === 0) return false;
      if (!q) return true;
      return [u.id, u.username, u.email || "", fullName(u), u.lastIp || ""].some((f) => f.toLowerCase().includes(q));
    });
    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case "username":
          return a.username.localeCompare(b.username);
        case "lastLogin":
          return (new Date(b.lastLoginAt || 0).getTime()) - (new Date(a.lastLoginAt || 0).getTime());
        case "servers":
          return b.serversOwned - a.serversOwned;
        default:
          return (new Date(b.createdAt || 0).getTime()) - (new Date(a.createdAt || 0).getTime());
      }
    });
    return rows;
  }, [users, query, roleFilter, statusFilter, sort]);

  useEffect(() => setPage(1), [query, roleFilter, statusFilter, sort, pageSize]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const stats = useMemo(
    () => ({
      total: users.length,
      staff: users.filter((u) => u.role === "admin" || u.role === "owner").length,
      suspended: users.filter((u) => u.suspended).length,
      with2fa: users.filter((u) => u.twoFactorEnabled).length,
    }),
    [users]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground flex items-center gap-3">
            <UsersIcon className="text-theme-400 w-6 h-6" /> Users
          </h2>
          <p className="text-sm text-muted-foreground mt-1">All registered users on the system.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="bg-muted border border-border focus:border-theme-500 rounded-xl pl-9 pr-3 py-2.5 text-sm text-foreground outline-none w-52 transition-all"
            />
          </div>
          <button
            onClick={async () => {
              setSpinning(true);
              await onRefresh();
              setTimeout(() => setSpinning(false), 300);
            }}
            className={ghostBtn}
            title="Refresh"
          >
            <RefreshCw size={15} className={spinning ? "animate-spin" : ""} />
          </button>
          <button onClick={onCreate} className={primaryBtn}>
            <Plus size={16} /> Create New
          </button>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Total users", value: stats.total, tone: "text-theme-400" },
          { label: "Admins / owners", value: stats.staff, tone: "text-purple-400" },
          { label: "2FA enabled", value: stats.with2fa, tone: "text-emerald-400" },
          { label: "Suspended", value: stats.suspended, tone: "text-red-400" },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border-subtle bg-card px-5 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.tone}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Table card */}
      <div className="rounded-2xl border border-border-subtle bg-card shadow-xl overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-6 py-4 border-b border-border-subtle bg-muted-subtle">
          <h3 className="text-sm font-bold uppercase tracking-wider text-foreground mr-auto">User List</h3>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as any)} className="bg-muted border border-border rounded-lg px-3 py-1.5 text-xs text-foreground outline-none focus:border-theme-500">
            <option value="all">All roles</option>
            <option value="user">Users</option>
            <option value="admin">Admins</option>
            <option value="owner">Owners</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="bg-muted border border-border rounded-lg px-3 py-1.5 text-xs text-foreground outline-none focus:border-theme-500">
            <option value="all">Any status</option>
            <option value="suspended">Suspended</option>
            <option value="no2fa">2FA disabled</option>
            <option value="with-servers">Owns servers</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as any)} className="bg-muted border border-border rounded-lg px-3 py-1.5 text-xs text-foreground outline-none focus:border-theme-500">
            <option value="created">Newest first</option>
            <option value="username">Username A–Z</option>
            <option value="lastLogin">Last login</option>
            <option value="servers">Most servers</option>
          </select>
        </div>

        {loading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading users…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">No users match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground bg-muted-subtle/60">
                  <th className="px-5 py-3.5 font-semibold">ID</th>
                  <th className="px-5 py-3.5 font-semibold">Email</th>
                  <th className="px-5 py-3.5 font-semibold">Client Name</th>
                  <th className="px-5 py-3.5 font-semibold">Username</th>
                  <th className="px-5 py-3.5 font-semibold text-center">2FA</th>
                  <th className="px-5 py-3.5 font-semibold text-center">Servers Owned</th>
                  <th className="px-5 py-3.5 font-semibold text-center">Can Access</th>
                  <th className="px-5 py-3.5 font-semibold">Last Login</th>
                  <th className="px-5 py-3.5 font-semibold text-right"> </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((u) => (
                  <tr
                    key={u.id}
                    onClick={() => onOpen(u.id)}
                    className={`group border-t border-border-subtle hover:bg-muted/40 transition-colors cursor-pointer ${u.suspended ? "opacity-70" : ""}`}
                  >
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground" title={u.id}>
                      {u.id.length > 8 ? `${u.id.slice(-6)}` : u.id}
                    </td>
                    <td className="px-5 py-3.5">
                      {u.email ? (
                        <span className="inline-flex items-center gap-1.5 text-theme-400">
                          {u.email}
                          {(u.role === "admin" || u.role === "owner") && (
                            <Star size={13} className={u.role === "owner" ? "fill-amber-400 text-amber-400" : "fill-purple-400 text-purple-400"} aria-label={u.role} />
                          )}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground/60">
                          —
                          {(u.role === "admin" || u.role === "owner") && (
                            <Star size={13} className={u.role === "owner" ? "fill-amber-400 text-amber-400" : "fill-purple-400 text-purple-400"} aria-label={u.role} />
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-foreground">{fullName(u) || <span className="text-muted-foreground/60">—</span>}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        {u.username}
                        {u.id === currentUser.id && (
                          <span className="text-[10px] uppercase font-bold tracking-wider bg-theme-500/20 text-theme-400 px-2 py-0.5 rounded border border-theme-500/20">You</span>
                        )}
                        {u.suspended && <SuspendedBadge />}
                        {u.isGoogleUser && <Chrome size={13} className="text-amber-400" aria-label="Google account" />}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {u.twoFactorEnabled ? (
                        <ShieldCheck size={16} className="inline text-emerald-400" aria-label="2FA enabled" />
                      ) : (
                        <ShieldOff size={16} className="inline text-red-400" aria-label="2FA disabled" />
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      <span className={u.serversOwned > 0 ? "text-theme-400 font-semibold" : "text-muted-foreground"}>{u.serversOwned}</span>
                    </td>
                    <td className="px-5 py-3.5 text-center text-muted-foreground">{u.canAccess}</td>
                    <td className="px-5 py-3.5 text-muted-foreground whitespace-nowrap" title={formatDate(u.lastLoginAt)}>{timeAgo(u.lastLoginAt)}</td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="inline-flex p-1.5 rounded-lg bg-muted border border-transparent text-muted-foreground group-hover:text-foreground">
                        <ChevronRight size={16} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {!loading && filtered.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 border-t border-border-subtle bg-muted-subtle/60 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              Rows per page
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="bg-muted border border-border rounded-lg px-2 py-1 text-xs text-foreground outline-none">
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span className="ml-2">{filtered.length} user{filtered.length === 1 ? "" : "s"}</span>
            </div>
            <div className="flex items-center gap-2">
              <button className={ghostBtn + " !px-2 !py-1"} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                <ChevronLeft size={14} />
              </button>
              <span>Page {safePage} / {pages}</span>
              <button className={ghostBtn + " !px-2 !py-1"} disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Banned IPs */}
      {bannedIps.length > 0 && (
        <div className="rounded-2xl border border-border-subtle bg-card shadow-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-border-subtle bg-muted-subtle">
            <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-foreground">
              <Ban size={15} className="text-red-400" /> Banned IP Addresses ({bannedIps.length})
            </h3>
          </div>
          <div className="p-4 space-y-2">
            {bannedIps.map((b: any) => (
              <div key={b.ip} className="flex items-center justify-between p-3 bg-muted-subtle border border-border-subtle rounded-xl">
                <div>
                  <p className="font-mono text-sm text-foreground">{b.ip}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{b.reason || "No reason given"}</p>
                </div>
                <button onClick={() => onUnbanIp(b.ip)} className="px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg transition-colors">
                  Unban
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

function RoleSelector({ value, onChange, canMakeOwner, disabled }: { value: string; onChange: (v: string) => void; canMakeOwner: boolean; disabled?: boolean }) {
  const options = [
    { key: "user", title: "Standard user", desc: "Manages only the servers they own or were given access to." },
    { key: "admin", title: "Administrator", desc: "Full access to this admin panel, all servers and all users." },
    ...(canMakeOwner ? [{ key: "owner", title: "Owner", desc: "Like admin, plus the only role that can manage other owners." }] : []),
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.key)}
          className={`text-left p-3.5 rounded-xl border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            value === o.key ? "border-theme-500 bg-theme-500/10 ring-1 ring-theme-500/40" : "border-border-subtle bg-muted-subtle hover:bg-muted"
          }`}
        >
          <p className={`text-sm font-semibold ${value === o.key ? "text-theme-400" : "text-foreground"}`}>{o.title}</p>
          <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{o.desc}</p>
        </button>
      ))}
    </div>
  );
}

function CreateUser({ currentUser, onBack, onCreated }: { currentUser: Props["currentUser"]; onBack: () => void; onCreated: (id: string) => void }) {
  const { notify } = useNotification();
  const [form, setForm] = useState({ email: "", username: "", firstName: "", lastName: "", password: "", role: "user", notes: "" });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await axios.post("/api/system/users", form);
      notify(`User "${form.username}" created`);
      onCreated(res.data.id);
    } catch (err: any) {
      notify(err.response?.data?.error || "Error creating user");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className={ghostBtn + " !p-2.5"} title="Back to users">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="text-2xl font-bold text-foreground">Create User</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Add a new user to the system.</p>
        </div>
      </div>

      <Card title="Identity" icon={<UserIcon size={15} className="text-theme-400" />}>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelCls}>Email</label>
            <input type="email" value={form.email} onChange={(e) => set("email")(e.target.value)} placeholder="user@example.com" className={inputCls} />
            <p className="text-[11px] text-muted-foreground mt-1.5">Optional. Used for account recovery and shown in the user list.</p>
          </div>
          <div>
            <label className={labelCls}>Username *</label>
            <input required minLength={3} maxLength={32} value={form.username} onChange={(e) => set("username")(e.target.value)} placeholder="username" className={inputCls} />
            <p className="text-[11px] text-muted-foreground mt-1.5">3–32 characters: letters, numbers, dot, dash, underscore. Used to log in.</p>
          </div>
          <div>
            <label className={labelCls}>First name</label>
            <input value={form.firstName} onChange={(e) => set("firstName")(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Last name</label>
            <input value={form.lastName} onChange={(e) => set("lastName")(e.target.value)} className={inputCls} />
          </div>
        </div>
      </Card>

      <Card title="Password" icon={<KeyRound size={15} className="text-theme-400" />} description="There is no email invite flow, so set a password now and share it with the user securely.">
        <PasswordField value={form.password} onChange={set("password")} placeholder="Minimum 8 characters" />
      </Card>

      <Card title="Permissions" icon={<ShieldCheck size={15} className="text-theme-400" />}>
        <RoleSelector value={form.role} onChange={set("role")} canMakeOwner={currentUser.role === "owner"} />
      </Card>

      <Card title="Admin notes" icon={<StickyNote size={15} className="text-theme-400" />} description="Only visible to administrators.">
        <textarea value={form.notes} onChange={(e) => set("notes")(e.target.value)} maxLength={1000} rows={3} placeholder="e.g. Friend from Discord, paid for 2 servers" className={inputCls + " resize-y"} />
      </Card>

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onBack} className={ghostBtn}>Cancel</button>
        <button type="submit" disabled={saving || form.password.length < 8 || form.username.trim().length < 3} className={primaryBtn}>
          <Plus size={16} /> {saving ? "Creating…" : "Create User"}
        </button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                       */
/* -------------------------------------------------------------------------- */

function EditUser({
  id, currentUser, onBack, onChanged, onBannedIpsChanged,
}: {
  id: string;
  currentUser: Props["currentUser"];
  onBack: () => void;
  onChanged: () => Promise<void> | void;
  onBannedIpsChanged: () => void;
}) {
  const { notify } = useNotification();
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", username: "", firstName: "", lastName: "", role: "user", notes: "" });
  const [newPassword, setNewPassword] = useState("");
  const [suspendReason, setSuspendReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const isSelf = id === currentUser.id;
  const actorIsOwner = currentUser.role === "owner";

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`/api/system/users/${id}`);
      const u: UserDetail = res.data;
      setDetail(u);
      setForm({ email: u.email || "", username: u.username, firstName: u.firstName, lastName: u.lastName, role: u.role, notes: u.notes });
      setError(null);
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to load user");
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e: any) {
      notify(e.response?.data?.error || "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  if (error)
    return (
      <div className="space-y-4">
        <button onClick={onBack} className={ghostBtn}><ArrowLeft size={15} /> Back</button>
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-400">{error}</div>
      </div>
    );
  if (!detail) return <div className="py-20 text-center text-sm text-muted-foreground">Loading user…</div>;

  // Owner accounts can only be touched by owners.
  const locked = detail.role === "owner" && !actorIsOwner;
  const dirty =
    form.email !== (detail.email || "") || form.username !== detail.username || form.firstName !== detail.firstName ||
    form.lastName !== detail.lastName || form.role !== detail.role || form.notes !== detail.notes;

  const saveIdentity = () =>
    run("identity", async () => {
      await axios.patch(`/api/system/users/${id}`, form);
      notify("User updated");
      await load();
      await onChanged();
    });

  const savePassword = () =>
    run("password", async () => {
      if (newPassword.length < 8) return notify("Password must be at least 8 characters");
      await axios.put(`/api/system/users/${id}/password`, { newPassword });
      notify("Password changed. The user was signed out everywhere.");
      setNewPassword("");
      if (isSelf) window.location.reload();
    });

  const toggleSuspend = () =>
    run("suspend", async () => {
      const next = !detail.suspended;
      const ok = await confirmDialog(
        next
          ? `Suspend "${detail.username}"? They will be signed out immediately and won't be able to log in or use their API keys until unsuspended.`
          : `Unsuspend "${detail.username}"? They will be able to log in again.`,
        { tone: next ? "warning" : "default", confirmLabel: next ? "Suspend" : "Unsuspend" }
      );
      if (!ok) return;
      await axios.put(`/api/system/users/${id}/suspend`, { suspended: next, reason: suspendReason });
      notify(next ? "User suspended" : "User unsuspended");
      setSuspendReason("");
      await load();
      await onChanged();
    });

  const reset2fa = () =>
    run("2fa", async () => {
      const ok = await confirmDialog(`Disable two-factor authentication for "${detail.username}"? They can set it up again from their account settings.`, { tone: "warning", confirmLabel: "Reset 2FA" });
      if (!ok) return;
      await axios.post(`/api/system/users/${id}/reset-2fa`);
      notify("Two-factor authentication reset");
      await load();
      await onChanged();
    });

  const forceLogout = () =>
    run("logout", async () => {
      const ok = await confirmDialog(`Force-logout "${detail.username}" everywhere? Their current session tokens will stop working immediately.`, { tone: "warning", confirmLabel: "Force logout" });
      if (!ok) return;
      await axios.post(`/api/system/users/${id}/terminate`);
      notify(`${detail.username}'s sessions have been terminated.`);
    });

  const banIp = () =>
    run("ban", async () => {
      const ok = await confirmDialog(`Ban ${detail.lastIp}? Anyone on that IP won't be able to reach the panel until it is unbanned.`, { tone: "danger", confirmLabel: "Ban IP" });
      if (!ok) return;
      const res = await axios.post(`/api/system/users/${id}/ban-ip`);
      notify(`Banned IP ${res.data.ip}.`);
      onBannedIpsChanged();
    });

  const deleteUser = () =>
    run("delete", async () => {
      const ok = await confirmDialog(`Delete "${detail.username}" permanently? This cannot be undone.`, { tone: "danger", confirmLabel: "Delete user" });
      if (!ok) return;
      try {
        await axios.delete(`/api/system/users/${id}`);
      } catch (e: any) {
        if (e.response?.status === 409) {
          const n = e.response.data?.serversOwned ?? detail.serversOwned;
          const move = await confirmDialog(
            `"${detail.username}" still owns ${n} server${n === 1 ? "" : "s"}. Transfer them to your account and delete the user?`,
            { tone: "danger", confirmLabel: "Transfer & delete", title: "User owns servers" }
          );
          if (!move) return;
          await axios.delete(`/api/system/users/${id}`, { params: { reassignTo: currentUser.id } });
        } else {
          throw e;
        }
      }
      notify("User deleted");
      await onChanged();
      onBack();
    });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className={ghostBtn + " !p-2.5"} title="Back to users"><ArrowLeft size={16} /></button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold text-foreground">{detail.username}</h2>
              <RoleBadge role={detail.role} />
              {detail.suspended && <SuspendedBadge />}
              {isSelf && <span className="text-[10px] uppercase font-bold tracking-wider bg-theme-500/20 text-theme-400 px-2 py-0.5 rounded border border-theme-500/20">You</span>}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">{fullName(detail) || "Edit this user's account."}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <div><span className="block uppercase tracking-wider font-semibold">Created</span><span className="text-foreground">{formatDate(detail.createdAt)}</span></div>
          <div><span className="block uppercase tracking-wider font-semibold">Last login</span><span className="text-foreground">{formatDate(detail.lastLoginAt)}</span></div>
          <div><span className="block uppercase tracking-wider font-semibold">Last IP</span><span className="text-foreground font-mono">{detail.lastIp || "—"}</span></div>
        </div>
      </div>

      {locked && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400 flex items-center gap-2">
          <AlertTriangle size={16} /> This is an owner account. Only owners can modify it.
        </div>
      )}
      {detail.suspended && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400 flex items-center gap-2">
          <UserX size={16} /> This account is suspended{detail.suspendedReason ? `: ${detail.suspendedReason}` : "."}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2 space-y-6">
          {/* Identity */}
          <Card title="Identity" icon={<UserIcon size={15} className="text-theme-400" />}>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className={labelCls}>Email</label>
                <div className="relative">
                  <Mail size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input type="email" disabled={locked || detail.isGoogleUser} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls + " pl-9"} />
                </div>
                {detail.isGoogleUser && <p className="text-[11px] text-muted-foreground mt-1.5">Managed by Google sign-in.</p>}
              </div>
              <div>
                <label className={labelCls}>Username</label>
                <input disabled={locked} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>First name</label>
                <input disabled={locked} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Last name</label>
                <input disabled={locked} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className={inputCls} />
              </div>
            </div>

            <div className="mt-6">
              <label className={labelCls}>Role</label>
              <RoleSelector value={form.role} onChange={(v) => setForm({ ...form, role: v })} canMakeOwner={actorIsOwner || detail.role === "owner"} disabled={locked || isSelf} />
              {isSelf && <p className="text-[11px] text-muted-foreground mt-1.5">You can't change your own role.</p>}
            </div>

            <div className="mt-6">
              <label className={labelCls}>Admin notes</label>
              <textarea disabled={locked} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={1000} rows={3} placeholder="Only visible to administrators" className={inputCls + " resize-y"} />
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button disabled={!dirty || busy === "identity"} onClick={() => setForm({ email: detail.email || "", username: detail.username, firstName: detail.firstName, lastName: detail.lastName, role: detail.role, notes: detail.notes })} className={ghostBtn}>Reset</button>
              <button disabled={!dirty || locked || busy === "identity"} onClick={saveIdentity} className={primaryBtn}>
                <Save size={15} /> {busy === "identity" ? "Saving…" : "Save changes"}
              </button>
            </div>
          </Card>

          {/* Password */}
          <Card title="Password" icon={<KeyRound size={15} className="text-theme-400" />} description="Setting a new password signs the user out everywhere.">
            {detail.isGoogleUser ? (
              <p className="text-sm text-muted-foreground">This account signs in with Google and has no panel password.</p>
            ) : (
              <>
                <PasswordField value={newPassword} onChange={setNewPassword} placeholder="New password (min 8 characters)" />
                <div className="mt-4 flex justify-end">
                  <button disabled={locked || newPassword.length < 8 || busy === "password"} onClick={savePassword} className={primaryBtn}>
                    <KeyRound size={15} /> {busy === "password" ? "Updating…" : "Update password"}
                  </button>
                </div>
              </>
            )}
          </Card>

          {/* Servers */}
          <Card title={`Servers (${detail.ownedServers.length} owned · ${detail.sharedServers.length} shared)`} icon={<ServerIcon size={15} className="text-theme-400" />}>
            {detail.ownedServers.length === 0 && detail.sharedServers.length === 0 ? (
              <p className="text-sm text-muted-foreground">This user has no servers and no shared access.</p>
            ) : (
              <div className="space-y-5">
                {[{ title: "Owned", list: detail.ownedServers }, { title: "Has access to", list: detail.sharedServers }].map(
                  (group) =>
                    group.list.length > 0 && (
                      <div key={group.title}>
                        <p className={labelCls}>{group.title}</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {group.list.map((s) => (
                            <Link key={s.id} to={`/servers/${s.id}`} className="flex items-center justify-between gap-2 p-3 rounded-xl border border-border-subtle bg-muted-subtle hover:bg-muted transition-colors">
                              <span className="text-sm font-medium text-foreground truncate">{s.name}</span>
                              <ExternalLink size={14} className="text-muted-foreground shrink-0" />
                            </Link>
                          ))}
                        </div>
                      </div>
                    )
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {/* Security */}
          <Card title="Security" icon={<ShieldCheck size={15} className="text-theme-400" />}>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Two-factor auth</p>
                  <p className={`text-xs mt-0.5 ${detail.twoFactorEnabled ? "text-emerald-400" : "text-muted-foreground"}`}>{detail.twoFactorEnabled ? "Enabled" : "Not enabled"}</p>
                </div>
                <button disabled={!detail.twoFactorEnabled || locked || busy === "2fa"} onClick={reset2fa} className={ghostBtn}>
                  Reset 2FA
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {detail.isGoogleUser && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30"><Chrome size={12} /> Google</span>
                )}
                {detail.discordConnected && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/30"><MessageCircle size={12} /> Discord</span>
                )}
                {!detail.isGoogleUser && !detail.discordConnected && <span className="text-xs text-muted-foreground">No linked accounts</span>}
              </div>
              <div className="pt-4 border-t border-border-subtle space-y-2">
                <button disabled={isSelf || locked || busy === "logout"} onClick={forceLogout} className={ghostBtn + " w-full justify-start"}>
                  <Power size={15} className="text-amber-400" /> Force logout everywhere
                </button>
                <button disabled={isSelf || locked || !detail.lastIp || busy === "ban"} onClick={banIp} className={ghostBtn + " w-full justify-start"} title={detail.lastIp ? `Ban ${detail.lastIp}` : "No known IP on record yet"}>
                  <Ban size={15} className="text-red-400" /> Ban last IP{detail.lastIp ? ` (${detail.lastIp})` : ""}
                </button>
              </div>
            </div>
          </Card>

          {/* Suspension */}
          <Card title="Account status" icon={detail.suspended ? <UserX size={15} className="text-red-400" /> : <UserCheck size={15} className="text-emerald-400" />}>
            {!detail.suspended && (
              <div className="mb-4">
                <label className={labelCls}>Reason (optional)</label>
                <input value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} maxLength={200} placeholder="e.g. Payment overdue" className={inputCls} disabled={isSelf || locked} />
              </div>
            )}
            <button
              disabled={isSelf || locked || busy === "suspend"}
              onClick={toggleSuspend}
              className={
                detail.suspended
                  ? primaryBtn + " w-full !bg-emerald-600 hover:!bg-emerald-700"
                  : "w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              }
            >
              {detail.suspended ? <><UserCheck size={15} /> Unsuspend user</> : <><UserX size={15} /> Suspend user</>}
            </button>
            {isSelf && <p className="text-[11px] text-muted-foreground mt-2">You can't suspend your own account.</p>}
          </Card>

          {/* Danger zone */}
          <Card title="Delete user" tone="danger" icon={<Trash2 size={15} />}>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Permanently removes this account. If they own servers you'll be asked to transfer them to your account first.
            </p>
            <button
              disabled={isSelf || locked || busy === "delete"}
              onClick={deleteUser}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 size={15} /> Delete user
            </button>
            {isSelf && <p className="text-[11px] text-muted-foreground mt-2">You can't delete your own account.</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}
