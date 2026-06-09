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
import type { CaptureBundle, PersistedCredential, ValidationResult } from "./types.ts";

export interface CaptureEvents {
  /** Called once the bootstrap URL is live, before the browser opens. */
  onBootstrapUrl?(url: string): void;
  /** Human-readable progress for the CLI to print. */
  onStatus?(message: string): void;
}

/**
 * Probes whether a freshly-captured credential actually works, by calling the
 * provider's `x-mastro-auth.verify` operation. Injected by the CLI so the broker
 * (in @mastro/core) doesn't depend on the SDK's Connector. Returns the real
 * outcome to store on the credential. Should not throw — a failed probe is a
 * `{ ok: false }` result, not an exception.
 */
export type CredentialVerifier = (
  provider: Provider,
  credential: PersistedCredential,
) => Promise<ValidationResult>;

export interface CaptureOptions {
  /** Optional liveness probe; runs only if the spec declares a verify op. */
  verify?: CredentialVerifier;
}

export class BrokerError extends Error {}

export class AuthBroker {
  constructor(private readonly store: CredentialStore) {}

  /**
   * Run the full capture flow for a provider and persist the result.
   * Returns the stored credential.
   */
  async capture(
    provider: Provider,
    events: CaptureEvents = {},
    options: CaptureOptions = {},
  ): Promise<PersistedCredential> {
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

    // If the spec declares a verify op and the CLI injected a verifier, probe
    // the live session so `validation` reflects reality (a 401 here means the
    // capture is structurally fine but the session doesn't actually work).
    const verifyOp = provider.spec?.auth().verify;
    if (verifyOp && options.verify) {
      events.onStatus?.("Verifying the session works…");
      // The verifier is contracted not to throw, but a misbehaving one must not
      // take down the capture or leave the credential unrecorded — treat an
      // unexpected throw as a failed probe.
      try {
        credential.validation = await options.verify(provider, credential);
      } catch (err) {
        credential.validation = {
          ok: false,
          checked_at: unixNow(),
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (!credential.validation.ok) {
        this.store.set(provider.id, credential);
        throw new BrokerError(
          `Captured a credential for ${manifest.display_name}, but a test call failed` +
            (credential.validation.detail ? ` (${credential.validation.detail})` : "") +
            `. The session may not be fully authenticated — try logging in again.`,
        );
      }
    }

    this.store.set(provider.id, credential);
    return credential;
  }

  /**
   * Reduce a capture bundle to the minimal persisted credential. `validation`
   * is intentionally left unset here — it's filled only by a real liveness
   * probe (see `capture`), so its presence honestly means "the session was
   * actually tested", not just "the fields parsed".
   */
  private toCredential(provider: Provider, bundle: CaptureBundle): PersistedCredential {
    return {
      provider_id: provider.id,
      captured_at: bundle.captured_at ?? unixNow(),
      expires_at: bundle.expires_at,
      fields: bundle.credentials,
      browser_context: bundle.browser_context,
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
