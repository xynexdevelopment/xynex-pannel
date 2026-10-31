import React, { useEffect, useRef, useState } from "react";
import { Bot, Sparkles, Upload, X } from "lucide-react";
import { LoadingCard, SecretInput, SectionCard, Switch, fieldLabelCls, textInputCls, useIntegrationSettings } from "./shared";

/** AI Support assistant (Groq / Gemini key, name, logo). Lives in the Support Tickets tab. */
export default function AiSupportSettings() {
  const { data, loaded, saving, save, notify } = useIntegrationSettings();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<"groq" | "gemini">("groq");
  const [groqKey, setGroqKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [name, setName] = useState("");
  const [logo, setLogo] = useState("");

  useEffect(() => {
    if (!data) return;
    setEnabled(!!data.aiSupportEnabled);
    setProvider(data.aiSupportProvider === "gemini" ? "gemini" : "groq");
    setGroqKey(data.aiSupportGroqApiKey || "");
    setGeminiKey(data.aiSupportGeminiApiKey || "");
    setName(data.aiSupportName || "");
    setLogo(data.aiSupportLogo || "");
  }, [data]);

  const handleLogoUpload = (file: File) => {
    if (!file.type.startsWith("image/")) {
      notify("Please choose an image file.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(reader.result as string);
    reader.readAsDataURL(file);
  };

  if (!loaded) return <LoadingCard label="Loading AI support settings..." />;

  return (
    <SectionCard
      icon={<Bot className="w-5 h-5" />}
      title="AI Support Assistant"
      description="Shows a floating support button to every logged-in user. Users chat with the AI first and can hand the conversation to an online admin as a ticket (see tickets above)."
      saving={saving}
      onSave={() =>
        save({
          aiSupportEnabled: enabled,
          aiSupportProvider: provider,
          aiSupportGroqApiKey: groqKey,
          aiSupportGeminiApiKey: geminiKey,
          aiSupportName: name,
          aiSupportLogo: logo,
        })
      }
    >
      <div className="flex items-center justify-between mb-5 p-4 bg-muted-subtle border border-border-subtle rounded-xl">
        <span className="text-sm font-semibold text-foreground">Enable AI Support</span>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>

      <div className={enabled ? "" : "opacity-50 pointer-events-none"}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className={fieldLabelCls}>Assistant Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. XyneX Assistant" className={textInputCls} />
          </div>
          <div>
            <label className={fieldLabelCls}>Assistant Logo</label>
            <input ref={logoInputRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && handleLogoUpload(e.target.files[0])} />
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl overflow-hidden bg-black/40 border border-border flex items-center justify-center shrink-0">
                {logo ? <img src={logo} alt="" className="w-full h-full object-cover" /> : <Sparkles className="w-4 h-4 text-muted-foreground" />}
              </div>
              <button type="button" onClick={() => logoInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold bg-muted hover:bg-muted-hover text-foreground rounded-lg transition-colors">
                <Upload size={14} /> Upload
              </button>
              {logo && (
                <button type="button" onClick={() => setLogo("")} className="p-2 text-muted-foreground hover:text-red-400 rounded-lg transition-colors" title="Remove logo">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        <label className={fieldLabelCls}>AI Provider</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          {(["groq", "gemini"] as const).map((p) => (
            <button
              type="button"
              key={p}
              onClick={() => setProvider(p)}
              className={`flex items-center justify-between p-4 rounded-xl border transition-all text-left ${provider === p ? "border-theme-500 bg-theme-500/10" : "border-border-subtle bg-black/20 hover:bg-black/30"}`}
            >
              <span className="font-bold text-sm text-foreground">{p === "groq" ? "Groq" : "Google Gemini"}</span>
              <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${provider === p ? "border-theme-400" : "border-muted-foreground"}`}>
                {provider === p && <span className="w-2 h-2 rounded-full bg-theme-400" />}
              </span>
            </button>
          ))}
        </div>

        {provider === "groq" ? (
          <div className="max-w-lg">
            <label className={fieldLabelCls}>Groq API Key</label>
            <SecretInput value={groqKey} onChange={setGroqKey} placeholder="Paste your Groq API key (console.groq.com)" />
          </div>
        ) : (
          <div className="max-w-lg">
            <label className={fieldLabelCls}>Gemini API Key</label>
            <SecretInput value={geminiKey} onChange={setGeminiKey} placeholder="Paste your Gemini API key (aistudio.google.com)" />
          </div>
        )}
      </div>
    </SectionCard>
  );
}
