import assert from "node:assert/strict";
import test from "node:test";
import { captureCurrencyHeartbeats } from "./_currency-heartbeats.mjs";

test("daemon plugin currency on the wire", { concurrency: true }, async (t) => {
  await Promise.all([true, false].map((advertise) => t.test(
    `startup and refreshed disk identities with advertising ${advertise}`, async (t) => {
    const receipt = await captureCurrencyHeartbeats({ advertise });
    t.diagnostic(JSON.stringify({ advertise, ...receipt }));
    const { before, after, first, second, advertisement } = receipt;
    assert.equal(first.metadata.instance, before.build, "plugin omitted or changed the startup source hash");
    assert.equal(first.metadata.codeOnDisk, before.codeOnDisk, "plugin omitted the disk source hash");
    assert.equal(second.metadata.instance, before.build, "plugin recomputed startup identity after disk changed");
    assert.equal(second.metadata.codeOnDisk, after.codeOnDisk, "plugin did not refresh disk identity per heartbeat");
    assert.notEqual(second.metadata.instance, second.metadata.codeOnDisk, "drift observation was vacuous");
    assert.equal(second.bridgeId, first.bridgeId, "the test switched claimers instead of updating one daemon");
    if (advertise) {
      assert.ok(advertisement, "the independent full advertiser did not run");
      assert.equal(advertisement.metadata.instance, before.build);
      assert.equal(advertisement.metadata.codeOnDisk, before.codeOnDisk);
    } else {
      assert.equal(advertisement, null, "the disabled advertiser ran");
    }
  })));
});
