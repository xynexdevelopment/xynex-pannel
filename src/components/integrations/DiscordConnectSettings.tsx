import React, { useEffect, useState } from "react";
import { ExternalLink, MessageSquare } from "lucide-react";
import { LoadingCard, SecretInput, SectionCard, Switch, fieldLabelCls, secretInputCls, useIntegrationSettings } from "./shared";

/** Discord OAuth app (Client ID / Secret) for linking accounts. Lives in the Login & Auth tab. */
export default function DiscordConnectSettings() {
  const { data, loaded, saving, save, notify } = useIntegrationSettings();
  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const redirectUri = `${window.location.origin}/api/auth/discord/callback`;

  useEffect(() => {
    if (!data) return;
    setEnabled(!!data.enableDiscordConnect);
    setClientId(data.discordClientId || "");
    setClientSecret(data.discordClientSecret || "");
  }, [data]);

  if (!loaded) return <LoadingCard label="Loading Discord settings..." />;

  return (
    <SectionCard
      icon={<MessageSquare className="w-5 h-5 text-[#5865F2]" />}
      title="Discord Account Connect"
      description="Lets users link their Discord account from the Settings page (identity only — no server access, no message reading)."
      saving={saving}
      onSave={() => save({ enableDiscordConnect: enabled, discordClientId: clientId, discordClientSecret: clientSecret })}
    >
      <div className="flex items-center justify-between mb-5 p-4 bg-muted-subtle border border-border-subtle rounded-xl">
        <span className="text-sm font-semibold text-foreground">Enable Discord Connect</span>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>

      <div className={enabled ? "" : "opacity-50 pointer-events-none"}>
        <div className="p-3 bg-black/30 border border-border-subtle rounded-xl mb-4 text-xs text-muted-foreground">
          <p className="font-bold text-foreground mb-1">Setup:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>
              Create an app at{" "}
              <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="text-[#5865F2] underline inline-flex items-center gap-1">
                Discord Developer Portal <ExternalLink size={11} />
              </a>
            </li>
            <li>Go to <strong>OAuth2</strong> and add this exact Redirect URL:</li>
          </ol>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 bg-black/40 px-2 py-1.5 rounded-lg text-[11px] font-mono text-foreground break-all">{redirectUri}</code>
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(redirectUri); notify("Copied!", "success"); }}
              className="px-2.5 py-1.5 text-[11px] font-bold bg-muted hover:bg-muted-hover text-foreground rounded-lg transition-colors flex-shrink-0"
            >
              Copy
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={fieldLabelCls}>Client ID</label>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234567890123456789" className={secretInputCls.replace(" pr-10", "")} />
          </div>
          <div>
            <label className={fieldLabelCls}>Client Secret</label>
            <SecretInput value={clientSecret} onChange={setClientSecret} placeholder="Paste your Client Secret" />
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
