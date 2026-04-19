import { useState } from "react";
import { api, type SetupStatus } from "../lib/api";

interface Props {
  status: SetupStatus;
  onConfigured: () => void;
}

export default function SetupWizard({ status, onConfigured }: Props) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const callbackDomain = status.callback_domain;

  const copyDomain = async () => {
    try {
      await navigator.clipboard.writeText(callbackDomain);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be unavailable in dev / non-secure contexts
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const result = await api.saveSetup(clientId.trim(), clientSecret.trim());
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? `Save failed (${result.status}).`);
      return;
    }
    onConfigured();
  };

  return (
    <div className="setup">
      <header className="setup-header">
        <h1>Welcome — let's connect Strava</h1>
        <p className="muted">
          Your Worker is deployed. One quick step to hook it up to your Strava account.
        </p>
      </header>

      <ol className="setup-steps">
        <li>
          <h3>1. Create a Strava API application</h3>
          <p>
            Open{" "}
            <a
              href="https://www.strava.com/settings/api"
              target="_blank"
              rel="noreferrer noopener"
            >
              strava.com/settings/api
            </a>{" "}
            and create a new application.
          </p>
          <p>
            When you're asked for the <strong>Authorization Callback Domain</strong>, paste
            this exact value (no scheme, no path):
          </p>
          <div className="copy-row">
            <code>{callbackDomain}</code>
            <button type="button" className="btn small" onClick={copyDomain}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="muted small">
            Everything else (name, website, description, category) can be anything — Strava
            doesn't validate these. Leave the icon blank or upload a placeholder.
          </p>
        </li>

        <li>
          <h3>2. Copy your credentials</h3>
          <p>
            Once created, the Strava settings page shows your{" "}
            <strong>Client ID</strong> (a short number) and <strong>Client Secret</strong>{" "}
            (a long hex string — click <em>Show</em> to reveal it). Paste them below.
          </p>
        </li>

        <li>
          <h3>3. Save and connect</h3>
          <form onSubmit={onSubmit} className="setup-form">
            <label>
              Client ID
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="e.g. 123456"
                required
              />
            </label>
            <label>
              Client Secret
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="40-character hex string"
                required
              />
            </label>
            {error && <div className="error">{error}</div>}
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? "Saving…" : "Save credentials"}
            </button>
          </form>
        </li>
      </ol>

      {status.claimed && (
        <p className="muted small">
          This instance is already claimed. Only the current owner can update credentials.
        </p>
      )}

      <footer className="setup-footer muted small">
        <details>
          <summary>Where is this stored?</summary>
          <p>
            Credentials are saved to Cloudflare KV attached to this Worker. You can rotate
            them anytime by re-running this wizard as the owner, or clear them with{" "}
            <code>wrangler kv key delete --binding=STRAVA_KV "config:strava_app"</code>.
          </p>
        </details>
      </footer>
    </div>
  );
}
