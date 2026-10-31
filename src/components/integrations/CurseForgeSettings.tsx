import React, { useEffect, useState } from "react";
import { Blocks } from "lucide-react";
import { LoadingCard, SecretInput, SectionCard, useIntegrationSettings } from "./shared";

/** CurseForge API key - powers "Browse Worlds" in the World Manager. Lives in the Extensions tab. */
export default function CurseForgeSettings() {
  const { data, loaded, saving, save } = useIntegrationSettings();
  const [key, setKey] = useState("");

  useEffect(() => {
    if (data) setKey(data.curseforgeApiKey || "");
  }, [data]);

  if (!loaded) return <LoadingCard label="Loading CurseForge settings..." />;

  return (
    <SectionCard
      icon={<Blocks className="w-5 h-5" />}
      title="CurseForge API Key"
      description="Powers the “Browse Worlds” tab in World Manager. Get a free key at console.curseforge.com. Stored server-side and never shown to regular users."
      saving={saving}
      onSave={() => save({ curseforgeApiKey: key })}
    >
      <SecretInput className="max-w-lg" value={key} onChange={setKey} placeholder="Paste your CurseForge API key" />
    </SectionCard>
  );
}
