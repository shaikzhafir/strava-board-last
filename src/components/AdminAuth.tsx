import { useState } from "react";
import { api, type SetupStatus } from "../lib/api";

interface Props {
  status: SetupStatus;
  onAuthenticated: () => void;
}

const MIN_PASSWORD_LENGTH = 8;

export default function AdminAuth({ status, onAuthenticated }: Props) {
  const mode: "register" | "login" = status.admin_registered ? "login" : "register";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const u = username.trim().toLowerCase();
    if (!u) {
      setError("Enter your GitHub username.");
      return;
    }
    if (mode === "register") {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirm) {
        setError("Passwords do not match.");
        return;
      }
    }

    setSubmitting(true);
    const result =
      mode === "register"
        ? await api.adminRegister(u, password)
        : await api.adminLogin(u, password);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error ?? `Request failed (${result.status}).`);
      return;
    }
    onAuthenticated();
  };

  return (
    <div className="admin-auth">
      <header className="admin-auth-header">
        <h1>
          {mode === "register"
            ? "Claim this instance"
            : "Sign in to continue setup"}
        </h1>
        <p className="muted">
          {mode === "register" ? (
            <>
              This Worker isn't connected to Strava yet. Set a GitHub username and
              password now so only you can continue the setup flow.
            </>
          ) : (
            <>
              Strava isn't fully connected yet. Sign in as the admin to resume the
              setup wizard.
            </>
          )}
        </p>
      </header>

      <form onSubmit={onSubmit} className="setup-form admin-auth-form">
        <label>
          GitHub username
          <input
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. octocat"
            required
            disabled={submitting}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              mode === "register"
                ? `at least ${MIN_PASSWORD_LENGTH} characters`
                : "your admin password"
            }
            required
            minLength={mode === "register" ? MIN_PASSWORD_LENGTH : undefined}
            disabled={submitting}
          />
        </label>
        {mode === "register" && (
          <label>
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              disabled={submitting}
            />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button type="submit" className="btn primary" disabled={submitting}>
          {submitting
            ? mode === "register"
              ? "Creating…"
              : "Signing in…"
            : mode === "register"
              ? "Create admin account"
              : "Sign in"}
        </button>
      </form>

      {mode === "register" && (
        <p className="muted small admin-auth-note">
          Heads up: whoever visits this page first can claim this instance.
          After deploying, open your Worker URL immediately and complete this
          step to keep anyone else from beating you to it.
        </p>
      )}
      {mode === "login" && (
        <p className="muted small admin-auth-note">
          Lost your password? Delete the <code>config:admin</code> key from the
          Worker's KV namespace to start over:{" "}
          <code>wrangler kv key delete --binding=STRAVA_KV "config:admin"</code>.
        </p>
      )}
    </div>
  );
}
