import React, { useEffect, useMemo, useState } from "react";
import { LoadingOverlay } from "../components/LoadingOverlay";
import axios from "axios";
import { useNavigate, Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Server,
  ArrowLeft,
  Cpu,
  HardDrive,
  MemoryStick,
  Globe,
  User,
  AlertTriangle,
  Sparkles,
  Box,
  CheckCircle2,
  Clock,
  Network,
  Database,
  Archive,
  Terminal,
  Container,
  FileText,
  Gauge,
  X,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import SearchableDropdown from "../components/SearchableDropdown";

// ── Shared look & feel (matches the rest of the panel's theme tokens) ──────
const inputCls =
  "w-full bg-muted-subtle border border-border focus:border-theme-500 focus:ring-1 focus:ring-theme-500/50 rounded-xl px-4 py-3 text-foreground transition-all shadow-inner outline-none disabled:opacity-60";
const monoInputCls = `${inputCls} font-mono`;
const labelCls = "block text-sm font-medium text-foreground-muted mb-2 flex items-center";
const helpCls = "text-xs text-muted-foreground mt-2 leading-relaxed";

function Section({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border-subtle bg-muted-subtle/40 overflow-hidden relative z-10">
      <header className="px-5 py-3.5 border-b border-border-subtle bg-muted-subtle flex items-center gap-3">
        <span className="text-theme-400">{icon}</span>
        <div>
          <h2 className="text-base font-bold text-foreground leading-tight">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </header>
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6">{children}</div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="px-1.5 py-0.5 rounded bg-muted text-[11px] font-mono text-foreground">{children}</code>;
}

export default function CreateServer({ onBack, onCreated }: { onBack?: () => void; onCreated?: () => void } = {}) {
  // ── Core details ──
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [users, setUsers] = useState<any[]>([]);
  const [startOnInstall, setStartOnInstall] = useState(true);

  // ── Allocation management ──
  const [port, setPort] = useState<string>("19100");
  const [nodeIp, setNodeIp] = useState<string>("");
  const [nodeMode, setNodeMode] = useState<"local" | "select">("local");
  const [availableNodes, setAvailableNodes] = useState<any[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [nodeAllocations, setNodeAllocations] = useState<any[]>([]);
  const [allocationId, setAllocationId] = useState<string>("");
  const [additionalIds, setAdditionalIds] = useState<string[]>([]);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [ipAlias, setIpAlias] = useState<string>("");

  // ── Application feature limits (blank = unlimited) ──
  const [databaseLimit, setDatabaseLimit] = useState<string>("");
  const [allocationLimit, setAllocationLimit] = useState<string>("");
  const [backupLimit, setBackupLimit] = useState<string>("");

  // ── Resource management (Pterodactyl units: MiB, 0 = unlimited) ──
  const [cpu, setCpu] = useState<string>("150");
  const [cpuPinning, setCpuPinning] = useState<string>("");
  const [memoryMb, setMemoryMb] = useState<string>("4096");
  const [swapMb, setSwapMb] = useState<string>("0");
  const [diskMb, setDiskMb] = useState<string>("10240");
  const [blockIo, setBlockIo] = useState<string>("500");
  const [oomKiller, setOomKiller] = useState(false);

  // ── Nest / egg ──
  const [eggs, setEggs] = useState<any[]>([]);
  const [category, setCategory] = useState<string>("");
  const [eggId, setEggId] = useState<string>("");
  const [version, setVersion] = useState("");

  // ── Startup & docker configuration ──
  const [startup, setStartup] = useState("");
  const [dockerImage, setDockerImage] = useState("");
  const [envVars, setEnvVars] = useState<Record<string, string>>({});

  // ── Auto-suspend ──
  const [autoSuspendOption, setAutoSuspendOption] = useState<string>("never");
  const [customExpiration, setCustomExpiration] = useState<string>("");

  // ── Submit state ──
  const [loading, setLoading] = useState(false);
  const [createProgress, setCreateProgress] = useState(0);
  const [totalSystemRam, setTotalSystemRam] = useState<number>(0);
  const [showRamWarning, setShowRamWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categories = Array.from(new Set(eggs.map((e: any) => e.category)));
  const eggsInCategory = eggs.filter((e: any) => e.category === category);
  const selectedEgg = eggs.find((e: any) => e.id === eggId);

  const navigate = useNavigate();
  const { user } = useAuth();

  const ramPresets = [2, 4, 8, 16, 24, 32, 48, 64];
  const memoryGb = (Number(memoryMb) || 0) / 1024;

  const handleRamSelect = (gb: number) => {
    setMemoryMb(String(gb * 1024));
    let autoCpu = 100;
    if (gb <= 2) autoCpu = 100;
    else if (gb <= 4) autoCpu = 150;
    else if (gb <= 8) autoCpu = 200;
    else if (gb <= 16) autoCpu = 300;
    else if (gb <= 24) autoCpu = 400;
    else if (gb <= 32) autoCpu = 500;
    else if (gb <= 48) autoCpu = 600;
    else autoCpu = 800;
    setCpu(String(autoCpu));
  };

  // Eggs (server templates)
  useEffect(() => {
    axios.get("/api/eggs").then((res) => {
      setEggs(res.data);
      if (res.data.length > 0) setCategory(res.data[0].category);
    }).catch(() => {});
  }, []);

  // Nodes: real nodes if any exist, otherwise the implicit Local Node.
  useEffect(() => {
    axios.get("/api/nodes/available/for-server").then((res) => {
      if (res.data.mode === "select") {
        setNodeMode("select");
        const nodes = res.data.nodes || [];
        setAvailableNodes(nodes);
        const preferred = nodes.find((n: any) => n.status === "connected" && n.freeAllocations > 0) || nodes[0];
        if (preferred) setSelectedNodeId(preferred.id);
      } else {
        setNodeMode("local");
        setNodeIp(res.data.nodeIp || "0.0.0.0");
      }
    }).catch(() => {});
  }, []);

  // Local node: next free port from the configured range.
  useEffect(() => {
    if (nodeMode !== "local") return;
    axios.get("/api/system/next-port").then((res) => {
      if (res.data.available) {
        setPort(String(res.data.port));
        setNodeIp(res.data.nodeIp || "0.0.0.0");
      }
    }).catch(() => {});
  }, [nodeMode]);

  // Real node: load all of its FREE allocations for the two dropdowns.
  useEffect(() => {
    if (nodeMode !== "select" || !selectedNodeId) return;
    setNodeError(null);
    setAdditionalIds([]);
    const node = availableNodes.find((n: any) => n.id === selectedNodeId);
    if (node && node.status !== "connected") {
      setNodeError("This node is offline right now — server creation is disabled until it reconnects. Pick a different node instead.");
      setNodeAllocations([]);
      setAllocationId("");
      return;
    }
    axios.get(`/api/nodes/${selectedNodeId}/allocations`).then((res) => {
      const free = (res.data || []).filter((a: any) => !a.assigned).sort((a: any, b: any) => a.port - b.port);
      setNodeAllocations(free);
      if (free.length > 0) {
        setAllocationId(free[0].id);
        setNodeIp(free[0].ip);
        setPort(String(free[0].port));
      } else {
        setAllocationId("");
        setNodeError("No free allocations on this node — add more under Admin → Nodes → Allocations, or pick another node.");
      }
    }).catch(() => setNodeError("Could not load allocations for this node."));
  }, [nodeMode, selectedNodeId, availableNodes]);

  // Keep ip/port in sync with the chosen default allocation.
  useEffect(() => {
    if (nodeMode !== "select") return;
    const a = nodeAllocations.find((x: any) => x.id === allocationId);
    if (a) {
      setNodeIp(a.ip);
      setPort(String(a.port));
      setAdditionalIds((ids) => ids.filter((id) => id !== allocationId));
    }
  }, [allocationId, nodeAllocations, nodeMode]);

  // Category → first egg.
  useEffect(() => {
    const first = eggs.find((e: any) => e.category === category);
    setEggId(first ? first.id : "");
  }, [category, eggs]);

  // Egg → default version, startup command, docker image and variable defaults.
  useEffect(() => {
    if (selectedEgg && selectedEgg.versions && selectedEgg.versions.length > 0) {
      setVersion(selectedEgg.versions[selectedEgg.versions.length - 1]);
    } else {
      setVersion("");
    }
    setStartup(selectedEgg?.startup || "");
    setDockerImage(selectedEgg?.dockerImage || "");
    const defaults: Record<string, string> = {};
    for (const v of selectedEgg?.variables || []) {
      if (v?.envVariable) defaults[v.envVariable] = String(v.defaultValue ?? "");
    }
    setEnvVars(defaults);
  }, [eggId]);

  // Version-specific docker images (imported Pterodactyl eggs).
  useEffect(() => {
    if (selectedEgg?.versionImages && version && selectedEgg.versionImages[version]) {
      setDockerImage(selectedEgg.versionImages[version]);
    }
  }, [version]);

  useEffect(() => {
    axios.get("/api/system/stats").then((res) => setTotalSystemRam(res.data.totalMemory / (1024 * 1024 * 1024))).catch(() => {});
    axios.get("/api/auth/users").then((res) => {
      setUsers(res.data);
      if (res.data.length > 0) {
        setOwner(res.data.find((u: any) => u.id === user?.id)?.id || res.data[0].id);
      }
    }).catch(() => {});
  }, [user]);

  const additionalOptions = useMemo(
    () => nodeAllocations.filter((a: any) => a.id !== allocationId),
    [nodeAllocations, allocationId]
  );

  const toggleAdditional = (id: string) =>
    setAdditionalIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (nodeMode === "select") {
      const node = availableNodes.find((n: any) => n.id === selectedNodeId);
      if (node && node.status !== "connected") {
        setNodeError("This node is offline right now — bring it back online or pick a different node before creating the server.");
        return;
      }
      if (!allocationId) {
        setNodeError("No free allocation available on this node — add more under Admin → Nodes → Allocations, or pick another node.");
        return;
      }
    }
    if (cpuPinning.trim() && !/^\d+([,-]\d+)*$/.test(cpuPinning.trim())) {
      setError("CPU Pinning must look like 0, 0-1,3 or 0,1,3,4.");
      return;
    }
    if (totalSystemRam > 0 && memoryGb > totalSystemRam && !showRamWarning) {
      setShowRamWarning(true);
      return;
    }
    executeSubmit();
  };

  const executeSubmit = async () => {
    setShowRamWarning(false);
    setLoading(true);
    setCreateProgress(0);
    setError(null);

    const interval = setInterval(() => {
      setCreateProgress((prev) => {
        if (prev >= 90) {
          clearInterval(interval);
          return 90;
        }
        return prev + (Math.random() * 8 + 2);
      });
    }, 300);

    try {
      const payload: any = {
        name: name.trim(),
        description: description.trim(),
        // The panel stores RAM / disk in GB; the form uses Pterodactyl's MiB.
        ram: (Number(memoryMb) || 0) / 1024,
        disk: (Number(diskMb) || 0) / 1024,
        cpu: Number(cpu) || 0,
        swap: Number(swapMb) || 0,
        cpuPinning: cpuPinning.trim(),
        blockIoWeight: Number(blockIo) || 500,
        oomKiller,
        startOnInstall,
        databaseLimit: databaseLimit === "" ? null : Number(databaseLimit),
        allocationLimit: allocationLimit === "" ? null : Number(allocationLimit),
        backupLimit: backupLimit === "" ? null : Number(backupLimit),
        port: Number(port),
        ipAlias,
        eggId,
      };
      if (nodeMode === "select") {
        payload.nodeId = selectedNodeId;
        payload.allocationId = allocationId;
        payload.additionalAllocationIds = additionalIds;
      }
      if (version) payload.version = version;
      if (owner) payload.owner = owner;

      if (selectedEgg) {
        payload.startup = startup;
        payload.dockerImage = dockerImage;
        // Only send variables the admin actually changed from the egg defaults.
        const changed: Record<string, string> = {};
        for (const v of selectedEgg.variables || []) {
          if (v?.envVariable && envVars[v.envVariable] !== String(v.defaultValue ?? "")) {
            changed[v.envVariable] = envVars[v.envVariable];
          }
        }
        if (Object.keys(changed).length > 0) payload.variables = changed;
      }

      if (autoSuspendOption === "custom" && customExpiration) {
        payload.expirationDate = new Date(customExpiration).toISOString();
      } else if (autoSuspendOption !== "never") {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + Number(autoSuspendOption));
        payload.expirationDate = expiry.toISOString();
      }

      await axios.post("/api/servers", payload);
      clearInterval(interval);
      setCreateProgress(100);
      setTimeout(() => { if (onCreated) onCreated(); else navigate("/servers"); }, 800);
    } catch (e: any) {
      clearInterval(interval);
      setCreateProgress(0);
      setError(e.response?.data?.error || "Failed to create server instance");
      setLoading(false);
    }
  };

  const portError = !!error?.includes("Port");

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="w-full max-w-6xl mx-auto relative z-10"
    >
      <div className="mb-8">
        {onBack ? (
          <button type="button" onClick={onBack} className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors mb-4">
            <ArrowLeft size={16} className="mr-2" /> Back to Instances
          </button>
        ) : (
          <Link to="/servers" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors mb-4">
            <ArrowLeft size={16} className="mr-2" /> Back to Instances
          </Link>
        )}
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-foreground mb-2">Create Server</h1>
        <p className="text-muted-foreground">Add a new server to the panel — every option below is applied when the container is created.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ───────────── Core Details ───────────── */}
        <Section icon={<FileText className="w-5 h-5" />} title="Core Details">
          <div>
            <label className={labelCls}><Server className="w-4 h-4 mr-2 text-theme-400" /> Server Name</label>
            <input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Production Survival" />
            <p className={helpCls}>Character limits: <Code>a-z A-Z 0-9 _ - .</Code> and <Code>[Space]</Code>.</p>
          </div>
          <div className="md:row-span-2">
            <label className={labelCls}><FileText className="w-4 h-4 mr-2 text-theme-400" /> Server Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={500} className={`${inputCls} resize-y`} />
            <p className={helpCls}>A brief description of this server.</p>
            <label className="mt-4 flex items-center gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={startOnInstall} onChange={(e) => setStartOnInstall(e.target.checked)} className="w-4 h-4 accent-[var(--theme-500,#6366f1)]" />
              <span className="text-sm font-semibold text-foreground">Start Server when Installed</span>
            </label>
          </div>
          <div className="relative z-20">
            <label className={labelCls}><User className="w-4 h-4 mr-2 text-theme-400" /> Server Owner</label>
            <SearchableDropdown
              value={owner}
              onChange={setOwner}
              options={users.map((u) => ({ value: u.id, label: `${u.username} ${u.id === user?.id ? "(You)" : u.role ? `(${u.role})` : ""}` }))}
              placeholder="Select a user..."
              searchPlaceholder="Search users..."
            />
            <p className={helpCls}>The user who owns this server and has access to it.</p>
          </div>
        </Section>

        {/* ───────────── Allocation Management ───────────── */}
        <Section icon={<Network className="w-5 h-5" />} title="Allocation Management">
          <div>
            <label className={labelCls}><Server className="w-4 h-4 mr-2 text-theme-400" /> Node</label>
            {nodeMode === "select" ? (
              <select required value={selectedNodeId} onChange={(e) => setSelectedNodeId(e.target.value)} className={inputCls}>
                {availableNodes.map((n: any) => (
                  <option key={n.id} value={n.id} disabled={n.freeAllocations === 0 || n.status !== "connected"}>
                    {n.name} ({n.fqdn}) — {n.status === "connected" ? "Connected" : "Offline"} — {n.freeAllocations} free
                  </option>
                ))}
              </select>
            ) : (
              <div className="w-full bg-muted-subtle border border-border-subtle rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                  <span className="text-foreground font-medium truncate">Local Node</span>
                  <span className="text-xs text-muted-foreground hidden sm:inline">(no custom nodes created yet)</span>
                </div>
              </div>
            )}
            <p className={helpCls}>The node which this server will be deployed to.</p>
          </div>

          <div>
            <label className={`${labelCls} ${portError ? "text-red-400" : ""}`}><Globe className={`w-4 h-4 mr-2 ${portError ? "text-red-400" : "text-orange-400"}`} /> Default Allocation</label>
            {nodeMode === "select" ? (
              <select required value={allocationId} onChange={(e) => setAllocationId(e.target.value)} className={monoInputCls} disabled={nodeAllocations.length === 0}>
                {nodeAllocations.length === 0 && <option value="">No free allocations</option>}
                {nodeAllocations.map((a: any) => (
                  <option key={a.id} value={a.id}>{a.ip}:{a.port}</option>
                ))}
              </select>
            ) : (
              <div className="flex gap-2">
                <div className="px-4 py-3 rounded-xl bg-muted border border-border-subtle font-mono text-sm text-muted-foreground flex items-center">{nodeIp || "0.0.0.0"}</div>
                <input
                  type="number" required min={1} max={65535} value={port}
                  onChange={(e) => { setPort(e.target.value); setError(null); }}
                  className={`${monoInputCls} ${portError ? "!border-red-500" : ""}`}
                />
              </div>
            )}
            <p className={helpCls}>The main allocation that will be assigned to this server.</p>
            {portError && <p className="mt-2 text-sm text-red-400 flex items-center"><AlertTriangle className="w-4 h-4 mr-1.5" />{error}</p>}
          </div>

          <div className="md:col-span-2">
            <label className={labelCls}><Network className="w-4 h-4 mr-2 text-theme-400" /> Additional Allocation(s)</label>
            {nodeMode === "select" ? (
              <>
                {additionalIds.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {additionalIds.map((id) => {
                      const a = nodeAllocations.find((x: any) => x.id === id);
                      return a ? (
                        <span key={id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-theme-500/15 border border-theme-500/30 text-theme-300 text-xs font-mono">
                          {a.ip}:{a.port}
                          <button type="button" onClick={() => toggleAdditional(id)} className="hover:text-white"><X className="w-3 h-3" /></button>
                        </span>
                      ) : null;
                    })}
                  </div>
                )}
                <div className="max-h-40 overflow-y-auto rounded-xl border border-border bg-muted-subtle p-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
                  {additionalOptions.length === 0 && <p className="col-span-full text-xs text-muted-foreground px-2 py-1">No other free allocations on this node.</p>}
                  {additionalOptions.map((a: any) => {
                    const on = additionalIds.includes(a.id);
                    return (
                      <button
                        key={a.id} type="button" onClick={() => toggleAdditional(a.id)}
                        className={`px-2 py-1.5 rounded-lg text-xs font-mono text-left border transition-colors ${on ? "bg-theme-500/20 border-theme-500/50 text-theme-300" : "border-transparent hover:bg-muted text-muted-foreground"}`}
                      >
                        {a.ip}:{a.port}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Additional allocations are available once you create a node under Admin → Nodes and add allocations to it.</p>
            )}
            <p className={helpCls}>Additional allocations to assign to this server on creation. Every selected port is published on the container.</p>
          </div>

          <div>
            <label className={labelCls}><Globe className="w-4 h-4 mr-2 text-theme-400" /> IP Alias</label>
            <input type="text" value={ipAlias} onChange={(e) => setIpAlias(e.target.value)} placeholder="e.g. play.example.com" className={monoInputCls} />
            <p className={helpCls}>
              {nodeIp && port ? <>Players will connect at <span className="font-mono text-foreground">{ipAlias || nodeIp}:{port}</span>.</> : "Shown to players instead of the raw node IP."}
            </p>
          </div>
          {nodeError && (
            <div className="md:col-span-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400 flex items-center">
              <AlertTriangle className="w-4 h-4 mr-2 shrink-0" />{nodeError}
            </div>
          )}
        </Section>

        {/* ───────────── Application Feature Limits ───────────── */}
        <Section icon={<Database className="w-5 h-5" />} title="Application Feature Limits">
          <div>
            <label className={labelCls}><Database className="w-4 h-4 mr-2 text-blue-400" /> Database Limit</label>
            <input type="number" min={0} value={databaseLimit} onChange={(e) => setDatabaseLimit(e.target.value)} placeholder="Unlimited" className={monoInputCls} />
            <p className={helpCls}>The total number of databases a user is allowed to create for this server. Leave blank for unlimited.</p>
          </div>
          <div>
            <label className={labelCls}><Network className="w-4 h-4 mr-2 text-orange-400" /> Allocation Limit</label>
            <input type="number" min={0} value={allocationLimit} onChange={(e) => setAllocationLimit(e.target.value)} placeholder="Unlimited" className={monoInputCls} />
            <p className={helpCls}>The total number of allocations a user is allowed to create for this server. Leave blank for unlimited.</p>
          </div>
          <div>
            <label className={labelCls}><Archive className="w-4 h-4 mr-2 text-emerald-400" /> Backup Limit</label>
            <input type="number" min={0} value={backupLimit} onChange={(e) => setBackupLimit(e.target.value)} placeholder="Unlimited" className={monoInputCls} />
            <p className={helpCls}>The total number of backups that can be created for this server. Leave blank for unlimited.</p>
          </div>
        </Section>

        {/* ───────────── Resource Management ───────────── */}
        <Section icon={<Gauge className="w-5 h-5" />} title="Resource Management">
          <div className="md:col-span-2">
            <label className={labelCls}><MemoryStick className="w-4 h-4 mr-2 text-purple-400" /> Quick Memory Presets</label>
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
              {ramPresets.map((gb) => (
                <button
                  key={gb} type="button" onClick={() => handleRamSelect(gb)}
                  className={`py-2 px-1 rounded-lg text-sm font-medium transition-all border ${
                    Number(memoryMb) === gb * 1024
                      ? "bg-theme-500/20 border-theme-500/50 text-theme-300 shadow-[0_0_10px_rgba(99,102,241,0.2)]"
                      : "bg-muted border-border text-muted-foreground hover:border-border-strong"
                  }`}
                >
                  {gb}GB
                </button>
              ))}
            </div>
            <p className={helpCls}>Picking a preset also sets a matching CPU limit; you can still edit every value below.</p>
          </div>

          <div>
            <label className={labelCls}><Cpu className="w-4 h-4 mr-2 text-blue-400" /> CPU Limit</label>
            <div className="flex">
              <input type="number" required min={0} value={cpu} onChange={(e) => setCpu(e.target.value)} className={`${monoInputCls} !rounded-r-none`} />
              <span className="px-4 flex items-center rounded-r-xl border border-l-0 border-border bg-muted text-sm text-muted-foreground">%</span>
            </div>
            <p className={helpCls}>
              If you do not want to limit CPU usage, set the value to <Code>0</Code>. To determine a value, take the number of threads and multiply it by 100 (<Code>4 * 100 = 400</Code> → <Code>400%</Code> available). Half a thread is <Code>50</Code>, two threads is <Code>200</Code>.
            </p>
          </div>
          <div>
            <label className={labelCls}><Cpu className="w-4 h-4 mr-2 text-cyan-400" /> CPU Pinning</label>
            <input type="text" value={cpuPinning} onChange={(e) => setCpuPinning(e.target.value)} placeholder="All threads" className={monoInputCls} />
            <p className={helpCls}>
              <strong>Advanced:</strong> Enter the specific CPU threads this process can run on, or leave blank to allow all threads. A single number or a comma separated list. Example: <Code>0</Code>, <Code>0-1,3</Code> or <Code>0,1,3,4</Code>.
            </p>
          </div>

          <div>
            <label className={labelCls}><MemoryStick className="w-4 h-4 mr-2 text-purple-400" /> Memory</label>
            <div className="flex">
              <input type="number" required min={0} value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} className={`${monoInputCls} !rounded-r-none`} />
              <span className="px-4 flex items-center rounded-r-xl border border-l-0 border-border bg-muted text-sm text-muted-foreground">MiB</span>
            </div>
            <p className={helpCls}>The maximum amount of memory allowed for this container. Setting this to <Code>0</Code> will allow unlimited memory in a container.{memoryGb > 0 && <> (= {memoryGb.toFixed(memoryGb % 1 ? 2 : 0)} GB)</>}</p>
          </div>
          <div>
            <label className={labelCls}><MemoryStick className="w-4 h-4 mr-2 text-fuchsia-400" /> Swap</label>
            <div className="flex">
              <input type="number" required min={-1} value={swapMb} onChange={(e) => setSwapMb(e.target.value)} className={`${monoInputCls} !rounded-r-none`} />
              <span className="px-4 flex items-center rounded-r-xl border border-l-0 border-border bg-muted text-sm text-muted-foreground">MiB</span>
            </div>
            <p className={helpCls}>Setting this to <Code>0</Code> will disable swap space on this server. Setting to <Code>-1</Code> will allow unlimited swap.</p>
          </div>

          <div>
            <label className={labelCls}><HardDrive className="w-4 h-4 mr-2 text-emerald-400" /> Disk Space</label>
            <div className="flex">
              <input type="number" required min={0} value={diskMb} onChange={(e) => setDiskMb(e.target.value)} className={`${monoInputCls} !rounded-r-none`} />
              <span className="px-4 flex items-center rounded-r-xl border border-l-0 border-border bg-muted text-sm text-muted-foreground">MiB</span>
            </div>
            <p className={helpCls}>This server will not be allowed to boot if it is using more than this amount of space. If a server goes over this limit while running it will be safely stopped and locked until enough space is available. Set to <Code>0</Code> to allow unlimited disk usage.</p>
          </div>
          <div>
            <label className={labelCls}><Gauge className="w-4 h-4 mr-2 text-amber-400" /> Block IO Weight</label>
            <input type="number" required min={10} max={1000} value={blockIo} onChange={(e) => setBlockIo(e.target.value)} className={monoInputCls} />
            <p className={helpCls}>
              <strong>Advanced:</strong> The IO performance of this server relative to other <em>running</em> containers on the system. Value should be between <Code>10</Code> and <Code>1000</Code>.
            </p>
          </div>

          <div className="md:col-span-2">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={oomKiller} onChange={(e) => setOomKiller(e.target.checked)} className="w-4 h-4 accent-[var(--theme-500,#6366f1)]" />
              <span className="text-sm font-semibold text-foreground">Enable OOM Killer</span>
            </label>
            <p className={helpCls}>Terminates the server if it breaches the memory limits. Enabling OOM killer may cause server processes to exit unexpectedly.</p>
          </div>
        </Section>

        {/* ───────────── Nest / Egg Configuration ───────────── */}
        <Section icon={<Box className="w-5 h-5" />} title="Nest Configuration">
          <div className="md:col-span-2">
            <label className={`${labelCls} mb-3`}><Box className="w-4 h-4 mr-2 text-theme-400" /> Nest (Category)</label>
            {eggs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No eggs available yet — upload one in Settings first.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {categories.map((cat) => (
                  <button
                    key={cat} type="button" onClick={() => setCategory(cat)}
                    className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all ${
                      category === cat
                        ? "bg-theme-500/20 border-theme-500/50 text-theme-300 shadow-[0_0_10px_rgba(99,102,241,0.2)]"
                        : "bg-muted-subtle border-border-subtle text-foreground-muted hover:border-border-strong hover:bg-muted"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            )}
          </div>

          {eggsInCategory.length > 0 && (
            <div className="md:col-span-2">
              <label className={`${labelCls} mb-3`}><Box className="w-4 h-4 mr-2 text-theme-400" /> Egg (Server Software)</label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {eggsInCategory.map((egg: any) => {
                  const isSelected = eggId === egg.id;
                  return (
                    <button
                      key={egg.id} type="button" onClick={() => setEggId(egg.id)}
                      className={`flex flex-col items-center justify-center p-4 rounded-2xl border transition-all duration-200 relative overflow-hidden group ${
                        isSelected ? "bg-theme-500/10 border-theme-500/30 ring-1 ring-theme-500/50 shadow-lg" : "bg-muted-subtle border-border-subtle hover:border-border-strong hover:bg-muted"
                      }`}
                    >
                      <Box className={`w-7 h-7 mb-2 ${isSelected ? "text-theme-400" : "text-muted-foreground group-hover:text-foreground-muted"} transition-colors`} />
                      <span className={`text-sm font-bold ${isSelected ? "text-foreground" : "text-foreground-muted"}`}>{egg.name}</span>
                      <span className="text-[10px] text-center mt-1 text-muted-foreground truncate max-w-full">{egg.dockerImage}</span>
                      {isSelected && <div className="absolute top-2 right-2 text-theme-400"><CheckCircle2 className="w-4 h-4" /></div>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selectedEgg && selectedEgg.versions && selectedEgg.versions.length > 0 && (
            <div className="md:col-span-2 relative z-10">
              <label className={labelCls}><Box className="w-4 h-4 mr-2 text-cyan-400" /> Software Version</label>
              <SearchableDropdown
                value={version}
                onChange={setVersion}
                options={selectedEgg.versions.map((v: string) => ({ value: v, label: v }))}
                placeholder="Select a version..."
                searchPlaceholder="Search versions..."
                className="font-mono"
              />
            </div>
          )}
        </Section>

        {/* ───────────── Service Variables (egg variables) ───────────── */}
        {selectedEgg && Array.isArray(selectedEgg.variables) && selectedEgg.variables.length > 0 && (
          <Section icon={<Terminal className="w-5 h-5" />} title="Service Variables" subtitle={`Environment variables defined by the ${selectedEgg.name} egg`}>
            {selectedEgg.variables.filter((v: any) => v?.envVariable).map((v: any) => (
              <div key={v.envVariable}>
                <label className={labelCls}>{v.name} <span className="ml-2"><Code>{v.envVariable}</Code></span></label>
                <input
                  type="text"
                  disabled={v.editable === false}
                  value={envVars[v.envVariable] ?? ""}
                  onChange={(e) => setEnvVars((cur) => ({ ...cur, [v.envVariable]: e.target.value }))}
                  className={monoInputCls}
                />
                {v.description && <p className={helpCls}>{v.description}</p>}
              </div>
            ))}
          </Section>
        )}

        {/* ───────────── Startup & Docker Configuration ───────────── */}
        {selectedEgg && (
          <Section icon={<Container className="w-5 h-5" />} title="Startup & Docker Configuration">
            <div className="md:col-span-2">
              <label className={labelCls}><Terminal className="w-4 h-4 mr-2 text-theme-400" /> Startup Command</label>
              <textarea value={startup} onChange={(e) => setStartup(e.target.value)} rows={2} className={`${monoInputCls} resize-y`} placeholder="Egg default startup command" />
              <p className={helpCls}>The command used to start this server. Use <Code>{"{{VARIABLE}}"}</Code> tokens to insert service variables. Defaults to the egg's command.</p>
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}><Container className="w-4 h-4 mr-2 text-theme-400" /> Docker Image</label>
              <input type="text" value={dockerImage} onChange={(e) => setDockerImage(e.target.value)} className={monoInputCls} placeholder="e.g. ghcr.io/pterodactyl/yolks:java_21" />
              <p className={helpCls}>The Docker image this server runs in. Only change this if you know the image is compatible with the egg.</p>
            </div>
          </Section>
        )}

        {/* ───────────── Auto-Suspend ───────────── */}
        <Section icon={<Clock className="w-5 h-5" />} title="Auto-Suspend">
          <div className="md:col-span-2">
            <select value={autoSuspendOption} onChange={(e) => setAutoSuspendOption(e.target.value)} className={inputCls}>
              <option value="never">Never (no expiration)</option>
              <option value="1">Suspend after 1 day</option>
              <option value="3">Suspend after 3 days</option>
              <option value="7">Suspend after 7 days</option>
              <option value="30">Suspend after 30 days</option>
              <option value="custom">Custom date...</option>
            </select>
            {autoSuspendOption === "custom" && (
              <input type="datetime-local" value={customExpiration} onChange={(e) => setCustomExpiration(e.target.value)} className={`${inputCls} mt-2`} />
            )}
            <p className={helpCls}>The server will be automatically suspended once this date passes. You can change this anytime from the server's Settings tab.</p>
          </div>
        </Section>

        {/* ───────────── Submit ───────────── */}
        <div className="rounded-2xl border border-border-subtle bg-muted-subtle/40 p-5 relative z-10">
          {loading && (
            <div className="mb-6 p-4 border border-zinc-800 bg-muted rounded-xl">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-theme-400">{version ? `Downloading ${version} and c` : "C"}reating container...</span>
                <span className="text-sm font-mono text-theme-400/80">{Math.round(createProgress)}%</span>
              </div>
              <div className="w-full bg-zinc-800/50 rounded-full h-2.5 overflow-hidden">
                <div className="bg-theme-500 h-2.5 rounded-full transition-all duration-300 ease-out" style={{ width: `${createProgress}%` }} />
              </div>
            </div>
          )}
          {error && !portError && (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start text-red-400 mb-6">
              <AlertTriangle className="w-5 h-5 mr-3 shrink-0 mt-0.5" />
              <p className="text-sm font-medium whitespace-pre-wrap font-mono">{error}</p>
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-3.5 bg-white text-zinc-900 hover:bg-zinc-200 font-bold rounded-xl transition-all shadow-lg active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 flex justify-center items-center gap-2"
          >
            {loading ? (
              <>
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} className="w-5 h-5 border-2 border-zinc-900 border-t-transparent rounded-full mr-2" />
                Creating Server...
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                Create Server
              </>
            )}
          </button>
        </div>
      </form>

      <AnimatePresence>
        {showRamWarning && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-[#121214] border border-red-500/30 shadow-2xl shadow-red-500/10 rounded-2xl p-6 max-w-md w-full relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-500 to-amber-500" />
              <div className="flex items-start mb-4">
                <div className="bg-red-500/10 p-3 rounded-full mr-4"><AlertTriangle className="w-6 h-6 text-red-500" /></div>
                <div>
                  <h3 className="text-xl font-bold text-foreground mb-1">High RAM Allocation</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    You are attempting to allocate <strong className="text-foreground">{memoryGb.toFixed(1)}GB</strong> of RAM, but this system only has <strong className="text-foreground">{totalSystemRam.toFixed(1)}GB</strong> physically available.
                  </p>
                  <p className="text-muted-foreground text-sm leading-relaxed mt-2">
                    If the server actually consumes more than the available physical RAM during runtime, the host operating system may forcibly terminate (crash) it to prevent system instability.
                  </p>
                </div>
              </div>
              <div className="flex justify-end space-x-3 mt-6">
                <button type="button" onClick={() => setShowRamWarning(false)} className="px-4 py-2 bg-muted hover:bg-muted-hover text-foreground font-medium rounded-xl transition-colors">Cancel</button>
                <button type="button" onClick={executeSubmit} className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold rounded-xl transition-colors border border-red-500/30">Yes, Proceed Anyway</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {loading && <LoadingOverlay message="Provisioning server resources..." />}
    </motion.div>
  );
}
