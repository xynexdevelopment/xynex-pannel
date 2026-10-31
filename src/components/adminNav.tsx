import React from "react";
import {
  LayoutDashboard, Server, Cpu, Package, FolderTree, Database, Users, Shield, Key, LifeBuoy,
  Settings as SettingsIcon, Puzzle, Globe, Ban, Activity, RefreshCw, Layout, Palette, ToggleRight, Megaphone,
} from "lucide-react";

export type AdminTabKey =
  | "dashboard" | "database" | "extensions" | "eggs" | "playit" | "users" | "mounts" | "nodes" | "traffic"
  | "createserver" | "manageserver" | "apikeys" | "activity" | "support" | "general" | "auth" | "system";

export type GeneralSectionKey = "branding" | "appearance" | "features" | "announcement";

export interface AdminNavTab {
  key: AdminTabKey;
  label: string;
  description: string;
  keywords?: string[];
  icon: React.ReactNode;
}
export interface AdminNavGroup {
  label: string;
  tabs: AdminNavTab[];
}

/** Single source of truth for the admin sidebar, breadcrumb strip and the Ctrl+K palette. */
export const ADMIN_NAV: AdminNavGroup[] = [
  { label: "Overview", tabs: [
    { key: "dashboard", label: "Dashboard", description: "Live system stats and quick actions.", keywords: ["home", "stats", "cpu", "ram"], icon: <LayoutDashboard size={17} /> },
  ] },
  { label: "Servers", tabs: [
    { key: "createserver", label: "Servers", description: "Create, suspend and manage every game server.", keywords: ["create", "minecraft", "suspend"], icon: <Server size={17} /> },
    { key: "nodes", label: "Nodes", description: "Machines and Cloudflare hostnames that run your servers.", keywords: ["cloudflare", "dns", "machine"], icon: <Cpu size={17} /> },
    { key: "eggs", label: "Eggs", description: "Server types shown on the Create Server page.", keywords: ["template", "docker", "image"], icon: <Package size={17} /> },
    { key: "mounts", label: "Mounts", description: "Shared folders that can be attached to servers.", keywords: ["folder", "volume", "storage"], icon: <FolderTree size={17} /> },
    { key: "database", label: "Databases", description: "Database hosts and per-server databases.", keywords: ["mysql", "sql"], icon: <Database size={17} /> },
  ] },
  { label: "Users & Access", tabs: [
    { key: "users", label: "Users", description: "Accounts, roles, suspension and 2FA resets.", keywords: ["accounts", "admin", "password", "suspend"], icon: <Users size={17} /> },
    { key: "auth", label: "Login & Auth", description: "Google sign-in, Firebase and Discord account linking.", keywords: ["google", "firebase", "discord", "oauth", "sso"], icon: <Shield size={17} /> },
    { key: "apikeys", label: "API Keys", description: "Keys for accessing this panel's own API.", keywords: ["token", "api"], icon: <Key size={17} /> },
    { key: "support", label: "Support Tickets", description: "Tickets from users and the AI support assistant.", keywords: ["ai", "groq", "gemini", "help", "chat"], icon: <LifeBuoy size={17} /> },
  ] },
  { label: "Platform", tabs: [
    { key: "general", label: "General", description: "Branding, appearance, features and announcements.", keywords: ["theme", "logo", "name", "background", "banner", "maintenance", "registration", "color", "layout"], icon: <SettingsIcon size={17} /> },
    { key: "extensions", label: "Extensions", description: "Add-ons plus the CurseForge key for world browsing.", keywords: ["curseforge", "plugins", "addons"], icon: <Puzzle size={17} /> },
    { key: "playit", label: "Network & Tunnels", description: "playit.gg tunnels and network settings.", keywords: ["playit", "tunnel", "port"], icon: <Globe size={17} /> },
  ] },
  { label: "Monitoring", tabs: [
    { key: "traffic", label: "Traffic & IP Bans", description: "Request stats, tracked IPs and banned addresses.", keywords: ["ip", "ban", "requests"], icon: <Ban size={17} /> },
    { key: "activity", label: "Activity Log", description: "Audit trail plus Discord webhook notifications.", keywords: ["audit", "logs", "webhook", "discord"], icon: <Activity size={17} /> },
  ] },
  { label: "System", tabs: [
    { key: "system", label: "Updates", description: "Check for and install panel updates.", keywords: ["version", "upgrade", "docker"], icon: <RefreshCw size={17} /> },
  ] },
];

export const GENERAL_SECTIONS: { key: GeneralSectionKey; label: string; hint: string; icon: React.ReactNode; keywords: string[] }[] = [
  { key: "branding", label: "Branding", hint: "Name, logo, background", icon: <Layout size={16} />, keywords: ["logo", "name", "background", "wallpaper", "blur"] },
  { key: "appearance", label: "Appearance", hint: "Accent theme & navigation", icon: <Palette size={16} />, keywords: ["theme", "color", "accent", "layout", "sidebar"] },
  { key: "features", label: "Features", hint: "Tutorial, registration, maintenance", icon: <ToggleRight size={16} />, keywords: ["onboarding", "registration", "maintenance", "login"] },
  { key: "announcement", label: "Announcement", hint: "Banner for all users", icon: <Megaphone size={16} />, keywords: ["banner", "message", "notice"] },
];

export const ADMIN_TAB_KEYS: AdminTabKey[] = [
  ...ADMIN_NAV.flatMap((g) => g.tabs.map((t) => t.key)),
  "manageserver",
];
