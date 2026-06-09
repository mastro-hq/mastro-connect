/**
 * Auth broker — orchestrates a single capture.
 *
 *   load provider → start receiver → open browser → wait for capture
 *     → validate against the manifest → persist a minimal credential.
 *
 * The broker owns the *how* of capture; the provider manifest owns the *what*.
 */
import { openInBrowser } from "./browser.ts";
import { Receiver } from "./receiver.ts";
import { isExpired, unixNow, type CredentialStore } from "./store.ts";
import type { Provider } from "./registry.ts";
import type { CaptureBundle, PersistedCredential } from "./types.ts";

export interface CaptureEvents {
  /** Called once the bootstrap URL is live, before the browser opens. */
  onBootstrapUrl?(url: string): void;
  /** Human-readable progress for the CLI to print. */
  onStatus?(message: string): void;
}

export class BrokerError extends Error {}

export class AuthBroker {
  constructor(private readonly store: CredentialStore) {}

  /**
   * Run the full capture flow for a provider and persist the result.
   * Returns the stored credential.
   */
  async capture(provider: Provider, events: CaptureEvents = {}): Promise<PersistedCredential> {
    const { manifest } = provider;
    const receiver = new Receiver({
      providerId: provider.id,
      displayName: manifest.display_name,
      launchUrl: manifest.launch.url,
      manifest,
    });

    const bootstrapUrl = receiver.start();
    events.onBootstrapUrl?.(bootstrapUrl);
    events.onStatus?.(`Opening ${manifest.display_name} in your browser…`);
    openInBrowser(bootstrapUrl);

    let bundle: CaptureBundle;
    try {
      bundle = await receiver.waitForCapture(manifest.launch.timeout_seconds * 1000);
    } catch (err) {
      throw new BrokerError(
        err instanceof Error ? err.message : "capture failed before completion",
      );
    } finally {
      receiver.stop();
    }

    events.onStatus?.("Captured. Validating…");
    const credential = this.toCredential(provider, bundle);
    this.validate(provider, credential);
    this.store.set(provider.id, credential);
    return credential;
  }

  /** Reduce a capture bundle to the minimal persisted credential. */
  private toCredential(provider: Provider, bundle: CaptureBundle): PersistedCredential {
    return {
      provider_id: provider.id,
      captured_at: bundle.captured_at ?? unixNow(),
      expires_at: bundle.expires_at,
      fields: bundle.credentials,
      browser_context: bundle.browser_context,
      validation: { ok: true, checked_at: unixNow() },
    };
  }

  /** Structural validation against the manifest + OpenAPI x-mastro-auth requirements. */
  private validate(provider: Provider, credential: PersistedCredential): void {
    if (isExpired(credential)) {
      throw new BrokerError("captured credential is already expired");
    }

    // Every field the spec's x-mastro-auth needs must be present & truthy.
    const required = provider.spec?.auth().required_fields ?? [];
    const missing = required.filter((f) => !truthy(credential.fields[f]));
    if (missing.length > 0) {
      throw new BrokerError(
        `capture is missing required field(s): ${missing.join(", ")}. ` +
          `Are you fully logged in to ${provider.manifest.display_name}?`,
      );
    }
  }
}

function truthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}
