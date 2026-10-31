import React, { useEffect, useState } from "react";
import axios from "axios";
import { MessageSquare } from "lucide-react";
import { LoadingCard, SectionCard, Switch, secretInputCls, useIntegrationSettings } from "./shared";

/** Discord webhook for server-event notifications. Lives in the Activity Log tab. */
export default function DiscordWebhookSettings() {
  const { data, loaded, saving, save, notify } = useIntegrationSettings();
  const [url, setUrl] = useState("");
  const [notifyEvents, setNotifyEvents] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!data) return;
    setUrl(data.discordWebhookUrl || "");
    setNotifyEvents(!!data.discordNotifyServerEvents);
  }, [data]);

  const sendTest = async () => {
    setTesting(true);
    try {
      await axios.post("/api/system/test-discord-webhook", { webhookUrl: url });
      notify("Test message sent — check your Discord channel!", "success");
    } catch (e: any) {
      notify(e.response?.data?.error || "Failed to send test message.", "error");
    } finally {
      setTesting(false);
    }
  };

  if (!loaded) return <LoadingCard label="Loading webhook settings..." />;

  return (
    <SectionCard
      icon={<MessageSquare className="w-5 h-5" />}
      title="Discord Webhook Notifications"
      description="Post a message to a Discord channel whenever a server is created, deleted, suspended, or unsuspended."
      saving={saving}
      onSave={() => save({ discordWebhookUrl: url, discordNotifyServerEvents: notifyEvents })}
    >
      <div className="flex items-center justify-between mb-5 p-4 bg-muted-subtle border border-border-subtle rounded-xl">
        <span className="text-sm font-semibold text-foreground">Send server event notifications</span>
        <Switch checked={notifyEvents} onChange={setNotifyEvents} />
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/..."
          className={secretInputCls.replace(" pr-10", "") + " flex-1"}
        />
        <button
          type="button"
          onClick={sendTest}
          disabled={testing || !url}
          className="flex-shrink-0 px-4 py-2.5 rounded-xl bg-muted hover:bg-muted-hover text-foreground text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
        >
          {testing ? "Sending…" : "Send Test"}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground mt-2">Create one under your Discord channel's Settings → Integrations → Webhooks.</p>
    </SectionCard>
  );
}
