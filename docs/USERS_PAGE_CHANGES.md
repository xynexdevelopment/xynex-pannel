# XyneX Panel - Users page + API keys reorganised

Copy these files over your project (same paths), then `npm run build`.

## 1) Pterodactyl-style Users page
- src/components/AdminUsers.tsx        (NEW)
- src/server/routes/system.ts          (user endpoints, suspend, reset-2fa)
- src/server/middleware/auth.ts        (suspended accounts rejected)
- src/server/controllers/auth.ts       (suspended accounts can't log in)
- server.ts                            (suspended accounts rejected on sockets)

## 2) API keys moved next to the feature they power
- API Keys tab        -> only the panel's own API keys
- Support Tickets tab -> AI Support (Groq / Gemini key, name, logo)
- Login & Auth tab    -> Discord Account Connect (Client ID / Secret)
- Activity Log tab    -> Discord Webhook notifications
- Extensions tab      -> CurseForge API key
New files: src/components/integrations/{shared,AiSupportSettings,CurseForgeSettings,DiscordConnectSettings,DiscordWebhookSettings}.tsx
Each section has its own Save button and saves only its own keys.
DELETE: src/components/IntegrationsManager.tsx (replaced by the files above)
Changed: src/pages/AdminPanel.tsx

No backend changes needed for (2); no new dependencies.

## 3) Branding + Theme & Layout merged into General
General tab now has a section switcher: Branding (name, logo, background), Appearance (accent theme,
custom theme upload, navigation layout), Features (tutorial, login intro, registration, maintenance),
Announcement (banner). The separate "Branding" and "Theme & Layout" sidebar entries are gone.
Old links ?tab=personalization / ?tab=theme still work (open General on the matching section);
?tab=general&section=appearance also works.
Changed: src/pages/AdminPanel.tsx only.

## 4) Admin shell: navigation + orientation
- NEW src/components/adminNav.tsx            single source of truth for sidebar / breadcrumb / search
- NEW src/components/AdminCommandPalette.tsx Ctrl/Cmd+K "jump to any page or setting" (try: logo, discord, ban)
- NEW src/lib/navSearch.ts + tests/navSearch.test.ts
- Breadcrumb + one-line description above every admin page
- Refresh / shared link keeps you on the same page (?tab=..&section=..); last page is remembered
- Page scrolls back to top when you switch tabs
- Owner role now gets the full admin console (before, AdminPanel only checked role === "admin")
Changed: src/pages/AdminPanel.tsx
