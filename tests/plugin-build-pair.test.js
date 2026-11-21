import assert from "node:assert/strict";
import test from "node:test";
import { captureCurrencyHeartbeats } from "./_currency-heartbeats.mjs";

test("daemon plugin currency on the wire", { concurrency: true }, async (t) => {
  await Promise.all([true, false].map((advertise) => t.test(
    `startup and refreshed disk identities with advertising ${advertise}`, async (t) => {
    const receipt = await captureCurrencyHeartbeats({ advertise });
    t.diagnostic(JSON.stringify({ advertise, ...receipt }));
    const { before, after, first, second, plainHeartbeats } = receipt;
    assert.equal(first.metadata.instance, before.build, "plugin omitted or changed the startup source hash");
    assert.equal(first.metadata.codeOnDisk, before.codeOnDisk, "plugin omitted the disk source hash");
    assert.equal(second.metadata.instance, before.build, "plugin recomputed startup identity after disk changed");
    assert.equal(second.metadata.codeOnDisk, after.codeOnDisk, "plugin did not refresh disk identity per heartbeat");
    assert.notEqual(second.metadata.instance, second.metadata.codeOnDisk, "drift observation was vacuous");
    assert.equal(second.bridgeId, first.bridgeId, "the test switched claimers instead of updating one daemon");
    // f760e02 merged host facts into the claimer beat for the same admitted target.
    for (const beat of [first, second]) {
      assert.equal(beat.metadata.advertiser, advertise ? "aify-env" : undefined, "host facts belong on the claimer beat only when advertising is enabled");
      assert.equal(Object.hasOwn(beat, "runtimes"), advertise, "host runtime inventory must follow the same advertising decision");
    }
    assert.equal(plainHeartbeats, 0, "a matching plugin target must not get a duplicate host-only heartbeat");
  })));
});
