// Standalone credential-step orchestration. Planning is pure; registration remains wrapper-owned.
import fs from 'node:fs';
import path from 'node:path';
import { readServices, registryIsReadable, registryReferences, serviceIdentity } from './services.mjs';
import { describePlan, planInstall, planIsIncomplete, WILL_ASK } from './install-plan.mjs';

export class InstallCredentials {
  #registry; #readiness; #registration; #plugins; #ask; #say;
  constructor({ registry, readiness, registration, plugins, ask, say }) {
    if (typeof registry !== 'string' || !path.isAbsolute(registry)) throw new TypeError('the credential step needs its exact absolute registry');
    if (!(plugins instanceof Set) || typeof readiness?.inspect !== 'function' || typeof registration?.publish !== 'function'
      || typeof ask !== 'function' || typeof say !== 'function') throw new TypeError('the credential step needs explicit readiness, registration and interaction ports');
    this.#registry = registry; this.#readiness = readiness; this.#registration = registration;
    this.#plugins = plugins; this.#ask = ask; this.#say = say;
  }
  #snapshot() {
    let text;
    try { text = fs.readFileSync(this.#registry, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
    if (registryReferences({ text }).unknown || (text.trim() && !registryIsReadable(text))) throw Error('registry-unavailable');
    const raw = text.trim() ? JSON.parse(text).services : {};
    const services = readServices(text).map(service => ({ ...service, credentialRef: raw[service.name]?.credentialRef ?? '' }));
    if (Object.keys(raw).length !== services.length) throw Error('registry-unavailable');
    const names = services.map(service => serviceIdentity(service).name);
    if (names.some(name => !name) || new Set(names).size !== names.length) throw Error('registry-unavailable');
    return { services, raw };
  }
  async #inspect(snapshot) {
    const readings = new Map();
    for (const service of snapshot.services) {
      const { name } = serviceIdentity(service);
      if (this.#plugins.has(name)) readings.set(name, await this.#readiness.inspect(service));
    }
    return readings;
  }
  #plan(snapshot, readings, interactive) {
    return planInstall({ services: snapshot.services, hasPlugin: name => this.#plugins.has(name),
      readinessFor: name => readings.get(name), interactive });
  }
  #show(plan) { for (const line of describePlan(plan)) this.#say(line); }

  async run({ interactive = false } = {}) {
    try {
      const before = this.#snapshot(), readings = await this.#inspect(before);
      const plan = this.#plan(before, readings, interactive);
      this.#show(plan);
      const requested = plan.steps.filter(step => step.action === WILL_ASK);
      if (!requested.length) return { exit: planIsIncomplete(plan) ? 1 : 0, plan };
      let failed = false;
      for (const step of requested) {
        const target = before.services.find(service => serviceIdentity(service).name === step.service);
        this.#say(`${step.service}: repair uses full approved service reconnect; artifact work and launcher rerender may occur`);
        const key = await this.#ask(`[aify-env] API key for ${step.service} (input hidden): `);
        if (typeof key !== 'string' || key === '') { failed = true; this.#say(`${step.service}: nothing entered; no registration requested`); continue; }
        const current = this.#snapshot();
        if (JSON.stringify(current.raw[target.name]) !== JSON.stringify(before.raw[target.name])) {
          failed = true; this.#say(`${step.service}: registration refused because the selected entry changed`); continue;
        }
        let answer;
        try { answer = await this.#registration.publish(target, key); }
        catch { answer = { status: 75 }; }
        if (answer.status !== 0) {
          failed = true;
          this.#say(`${step.service}: registration ${answer.status === 75 ? 'outcome is unknown' : 'was refused'}; not ready; inspect the owning reconnect command`);
          continue;
        }
        const after = this.#snapshot();
        const updated = after.services.find(service => service.name === target.name);
        if (!updated || serviceIdentity(updated).endpoint !== serviceIdentity(target).endpoint
          || !(await this.#readiness.inspect(updated, { expectedValue: key, requirePublishedRef: true })).ready) {
          failed = true; this.#say(`${step.service}: registration acknowledged, but exact published credential readback is not ready`);
          continue;
        }
        this.#say(`${step.service}: published credential verified through runtime resolution`);
      }
      const after = this.#snapshot(), final = this.#plan(after, await this.#inspect(after), false);
      this.#show(final);
      return { exit: failed || planIsIncomplete(final) ? 1 : 0, plan: final };
    } catch {
      this.#say('credential readiness could not be established from the selected registry; no success is assumed');
      return { exit: 1, plan: null };
    }
  }
}
