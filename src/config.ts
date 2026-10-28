export const DEFAULT_BASE_URL = "https://api.deafassistant.com";
const KEY_PATTERN = /^cck_[A-Za-z0-9_-]{20,100}$/;

export interface Config {
  baseUrl: string;
  /** Developer API key (owner credential). Read-only. */
  key?: string;
  /** A secured stream's attendee code, for reading captions without being the owner. */
  auth?: string;
  /** Default stream name. */
  stream?: string;
  /** True for the hosted HTTP server: the key arrives in the Authorization header, not in an environment variable. */
  hosted?: boolean;
}

/** Reads configuration from environment variables. Credentials are never tool arguments the model can fill in. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const baseUrl = (env.CONFCAP_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = new URL(baseUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("CONFCAP_API_URL must be https (credentials are sent to it).");
  const key = env.CONFCAP_KEY?.trim() || undefined;
  if (key && !KEY_PATTERN.test(key)) throw new Error("CONFCAP_KEY does not look like a developer API key (it starts with cck_). Create one in the portal under Advanced Settings.");
  return {
    baseUrl,
    key,
    auth: env.CONFCAP_AUTH?.trim() || undefined,
    stream: env.CONFCAP_STREAM?.trim().toLowerCase() || undefined,
  };
}

/** Removes any configured credential from text that might be shown to the model or logged. */
export function redact(text: string, config: Pick<Config, "key" | "auth">): string {
  let out = text;
  for (const secret of [config.key, config.auth]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/cck_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/([?&](?:auth|uid|key)=)[^&\s"]+/gi, "$1[redacted]");
}
