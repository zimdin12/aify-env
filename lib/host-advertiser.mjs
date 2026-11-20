// Telling every registered service what this host can do, on a beat, and what /health says of it.
//
// ON BY DEFAULT, and the collision it used to risk is closed rather than avoided. `runtimes` and
// `terminalRuntimes` are last-writer-wins, so two advertisers computing them differently would flap
// the row -- which reads like failing hardware rather than like two components disagreeing. The
// bridge now asks this daemon's `/health` whether it is advertising and omits host facts when it is,
// so exactly one tier describes a host. `AIFY_ADVERTISE=0` hands the job back to the bridge.
//
// STANDING DOWN IS SAFE because a heartbeat that omits a field no longer erases it: see aify-comms
// `service/api_core/environment_registration.py`, which preserves what a caller did not mention.
//
// THE ONE OBJECT THAT REMEMBERS. Each decision is a pure function in lib/advertise.mjs; this holds what
// the beats have learned -- the runtimes last detected, the targets, which beats were accepted and how
// each last attempt ended -- so /health answers from the same resolution the beat used. It moved out of
// bin/aify-env.mjs (0.9.9), whose module-level variables it was.

import {
  acceptanceKey,
  advertiseTo,
  advertisementHealth,
  advertisementStaleMs,
  advertisementTargets,
  advertisingChoice,
  attemptsByService,
  capabilityFingerprint,
  environmentAdvertisement,
  revokesAcceptance,
  runtimeAvailability,
  serviceTarget,
  shouldRedetect,
} from "./advertise.mjs";
import { credentialForTarget, credentialReadinessFor } from "./credential-resolve.mjs";
import { readServices, registryIsReadable } from "./services.mjs";

function sameTarget(a, b) {
  return acceptanceKey(a) === acceptanceKey(b) && a.credentialRef === b.credentialRef
    && JSON.stringify(a.keyEnv) === JSON.stringify(b.keyEnv);
}

export class HostAdvertiser {
  #enabled;
  #everyMs;
  #redetectMs;
  #readRegistry;
  #onServices;
  #stopped;
  #host;
  #harnesses;
  #pathFor;
  #pluginTargets;
  #post;
  #credentialReading;
  #credential;
  #env;
  #now;
  #say;
  #lastDetectedAt = 0;
  #runtimes = [];
  #fingerprint = "";
  //: What /health reports, refreshed by each beat. Read from the SAME resolution the beat uses, so the
  //: answer cannot say "somebody is being told" while the beat posts to nobody -- which is the one
  //: wrong answer that strands a host, because the bridge stands down on it.
  #targets = [];
  #choice = advertisingChoice([]); //: who this host beats to, who opted out, what was ignored (advertise.mjs)
  //: Target url -> epoch ms of the last beat that came back 2xx. THE ONLY EVIDENCE that a service is
  //: actually being described by this daemon. Reporting "advertising" from the target LIST instead
  //: meant a 401 counted as success, and the aify-comms bridge stands down on that answer.
  #accepted = new Map();
  //: The LAST OUTCOME per target, accepted or not -- which `#accepted` deliberately cannot carry,
  //: because it records only 2xx. Without it "we are not being heard" is one undifferentiated state,
  //: and a service that is DOWN is indistinguishable from one that REFUSED our credential. Those need
  //: different words from the doctor: one is somebody else's outage, the other is a key to set here.
  #attempts = new Map();

  /**
   * @param enabled           whether this daemon advertises at all (`advertisingEnabled(AIFY_ADVERTISE)`)
   * @param everyMs           the beat
   * @param redetectMs        how often the installed harnesses are walked again
   * @param readRegistry      () => the registry's text; a throw is no registry, which is "not advertising"
   * @param onServices        told the services of every registry that parses: the plugins follow it
   * @param stopped           () => true once this process may describe nothing (a view that refused a takeover)
   * @param host              () => this host's own facts in the body: hostname, kind, os, machineId, terminal,
   *                          terminalReason, version, instance, codeOnDisk, launchRoots
   * @param harnesses         () => the installed harness rows, asked at most once every `redetectMs`
   * @param pathFor           a plugin's advertisement route for a service (`advertisementPathFor`)
   * @param post              the transport (`postAdvertisement`)
   * @param credentialReading () => how a stored key is read; `credential` resolves a target's key through it
   * @param say               one line for the operator
   */
  constructor({ enabled, everyMs, redetectMs, readRegistry, onServices = () => {}, stopped = () => false, host, harnesses,
    pathFor, pluginTargets = () => [], post, credentialReading, credential = null, env = process.env, now = Date.now, say = () => {} }) {
    this.#enabled = enabled;
    this.#everyMs = everyMs;
    this.#redetectMs = redetectMs;
    this.#readRegistry = readRegistry;
    this.#onServices = onServices;
    this.#stopped = stopped;
    this.#host = host;
    this.#harnesses = harnesses;
    this.#pathFor = pathFor;
    this.#pluginTargets = pluginTargets;
    this.#post = post;
    this.#credentialReading = credentialReading;
    // THE STORE-AWARE RESOLVER, which is what makes the carrier deliver rather than only diagnose.
    // A fault -- unreadable, insecure, invalid, conflicting -- yields NO key, so a beat goes out
    // unauthenticated and is refused, and the refusal is then reported with its real cause instead of
    // this daemon inventing one.
    this.#credential = credential ?? (async (target) => (await credentialForTarget(target, credentialReading())).value);
    this.#env = env;
    this.#now = now;
    this.#say = say;
  }

  /** The host-only beat still follows the registry and sends to targets without a matching plugin beat. */
  async beat() {
    if (this.#stopped()) return;
    this.#readTargets({ follow: true });
    const carried = this.#pluginTargets();
    const targets = this.#targets.filter(target => !carried.some(other => sameTarget(target, other)));
    if (!targets.length) return;
    const results = await advertiseTo({ targets, body: this.#body(), post: this.#post, env: this.#env, credential: this.#credential });
    for (const result of results) this.#record(result, result);
  }

  /** Join the plugin's existing beat only for this exact admitted route and credential reference. */
  forPlugin(target) {
    if (!this.#enabled || this.#stopped()) return null;
    this.#readTargets();
    const match = this.#targets.find(other => sameTarget(target, other));
    if (!match) return null;
    let body;
    try { body = this.#body(); }
    catch (error) {
      this.#record(match, { ok: false, error: `host facts: ${error?.message || error}` });
      return null;
    }
    return { body, record: result => {
      if (this.#stopped()) return;
      // A late reply from a replaced endpoint or a newly disabled advertisement is not current evidence.
      this.#readTargets();
      if (this.#targets.some(other => sameTarget(match, other))) this.#record(match, result, true);
    } };
  }

  #readTargets({ follow = false } = {}) {
    let registryText;
    try { registryText = this.#readRegistry(); } catch { registryText = ""; }
    const services = readServices(registryText);
    if (follow && registryIsReadable(registryText)) this.#onServices(services);
    this.#choice = advertisingChoice(services);
    this.#targets = this.#choice.advertised.flatMap(service => advertisementTargets([service], this.#pathFor)
      .map(target => ({ ...target, endpoint: serviceTarget(service).endpoint })));
  }

  #body() {
    const now = this.#now();
    if (shouldRedetect({ lastDetectedAt: this.#lastDetectedAt, now, intervalMs: this.#redetectMs })) {
      this.#runtimes = runtimeAvailability(this.#harnesses());
      this.#lastDetectedAt = now;
    }
    // NO `cwdRoots`. Which directories work may run in is the service's policy, and an advertiser
    // sending an empty list would erase what the operator configured. Omitted means "kept".
    const body = environmentAdvertisement({ ...this.#host(), runtimes: this.#runtimes });

    // WHAT CHANGED, said once rather than every beat. The fingerprint covers exactly the fields a
    // re-walk could move, so a line here means a harness was installed or disappeared -- which is the
    // event an operator is watching for, and it is invisible in a stream of identical heartbeats.
    const fingerprint = capabilityFingerprint(body);
    if (this.#fingerprint !== "" && fingerprint !== this.#fingerprint) {
      this.#say(`capabilities changed: ${body.terminalRuntimes.join(", ") || "none"}`);
    }
    this.#fingerprint = fingerprint;
    return body;
  }

  #record(target, result, carried = false) {
      this.#attempts.set(acceptanceKey(target), {
        at: this.#now(), ok: result.ok === true, carried,
        status: Number(result.status || 0), error: String(result.error || ""),
      });
      if (result.ok) {
        // Only a 2xx counts. This is the whole fix: acceptance is recorded, refusal is not.
        this.#accepted.set(acceptanceKey(target), this.#now());
        return;
      }
      // A CREDENTIAL REFUSAL REVOKES THE STANDING ACCEPTANCE IMMEDIATELY, rather than letting it age
      // out over the staleness window. Between a key being rotated and the old acceptance expiring,
      // this daemon would still report `advertising: true` for that service -- so the aify-comms
      // bridge would keep standing down while every beat was being refused, and the host would be
      // described by NOBODY for the length of the window. That is the exact outage the standdown fix
      // exists to prevent, arriving through the fix for it.
      //
      // Scoped to 401 and 403: those are the service SAYING our credential is wrong. A 500 or an
      // unreachable host says nothing about the key, and dropping an acceptance on one would hand the
      // job back to the bridge every time somebody restarted a service.
      if (revokesAcceptance(result)) this.#accepted.delete(acceptanceKey(target));
      this.#say(`advertisement to ${target.url} failed (${result.status || result.error})`);
  }

  contacts() {
    return this.#targets.flatMap(target => {
      const result = this.#attempts.get(acceptanceKey(target));
      if (!result || result.carried) return [];
      const { at, ok, error, status } = result;
      return [{ name: target.name, endpoint: target.endpoint, channel: 'host advertisement', at, ok,
        error: ok ? '' : error || (status ? `HTTP ${status}` : '') }];
    });
  }

  /** What /health says of advertising: armed, heard by whom, refused by whom and why. */
  async healthFields() {
    const heard = advertisementHealth({
      enabled: this.#enabled, targets: this.#targets.map(target => {
        const carrier = this.#pluginTargets().find(other => sameTarget(target, other));
        return carrier ? { ...target, staleMs: advertisementStaleMs(carrier.everyMs) } : target;
      }), acceptedAt: this.#accepted, now: this.#now(),
      staleMs: advertisementStaleMs(this.#everyMs),
    });
    return {
      advertising: heard.advertising,
      // ARMED is a different question from BEING HEARD, and the doctor needs both: a daemon told
      // not to advertise is silent by design, and reporting a missing credential there would fail
      // a host configured exactly as intended.
      advertisingEnabled: this.#enabled,
      advertisingTo: heard.services,
      advertiseOptedOut: this.#choice.optedOut,
      advertiseIgnored: this.#choice.ignored,
      // NAMES AND A BOOLEAN, never a key. Without this, a daemon with no credential is invisible:
      // every advertisement is refused, `advertising` stays false, the bridge correctly keeps
      // describing the host, and the operator sees a daemon that runs and is never believed.
      advertiseCredentials: await credentialReadinessFor(this.#targets, this.#credentialReading()),
      // The outcome of the last beat per target, so a reader can tell a refusal from an outage.
      // No response BODY travels -- a service's error text is its own, and could carry anything.
      advertiseAttempts: attemptsByService(this.#targets, this.#attempts),
    };
  }

  /**
   * Beat now and on every interval, and return the stop. NEVER UNHANDLED: the daemon registers no
   * unhandledRejection handler, so a throw anywhere in a pass -- reading the registry, detecting runtimes,
   * describing the host -- was the end of the process, and with it every worker it owned. A failed pass is a log line.
   */
  start({ log = () => {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
    const safely = () => this.beat().catch((error) => log(`advertise failed: ${error?.message || error}`));
    safely();
    // `unref`'d like the daemon's sweep: a daemon whose last outstanding work is a heartbeat should still be able to exit.
    const timer = setIntervalImpl(safely, this.#everyMs);
    timer?.unref?.();
    return () => clearIntervalImpl(timer);
  }
}
