# Host provider

The dashboard plugin owns one serial `node <providerCheckout>/bin/apg.js provide` worker per host/endpoint. It owns claims, results and credentials; the worker receives only `{id,call,args,repoRoot}`, never the dashboard key. Each claim has limit1; its result is posted before another claim, with the watched real-path grant rechecked at feed time. APG refuses a subfolder rather than widening it to the Git top level.

Requests expire at90s, close stdin and use `runChild`'s existing owned cleanup. Exit3 and owned timeouts back off60s; exit1/2, invalid frames and unexpected signals latch the endpoint until configuration changes or restart. Request refusals remain in-band. Checkout/grant changes, hosting yield and plugin stop close the worker; cleanup warnings survive plugin rebuilds.

Pending polls request25s with a35s deadline. Immediate-empty/old/error servers fall back60s until a successful poll waits; sweeps retain their independent cadence. `provider.runs` counts posted worker answers, not child starts. Run `npm test -- tests/provider-host.test.js` in the private, identity-stripped test environment; set `AIFY_APG_REPO` to the pinned APG checkout to include actual-worker present/absent and subfolder controls. Tests without that peer explicitly skip its composition case.
