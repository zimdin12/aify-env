// Child-client fixture only: preserve the URL and real HTTP Host, redirect this one test name to loopback.
// Never loaded into a daemon, installed launcher or the parent test process.
const dns = require('node:dns');
const lookup = dns.lookup;
dns.lookup = function (host, options, callback) {
  if (host !== 'forwarded.example') return lookup.apply(this, arguments);
  if (typeof options === 'function') { callback = options; options = {}; }
  process.nextTick(() => options?.all
    ? callback(null, [{ address: '127.0.0.1', family: 4 }])
    : callback(null, '127.0.0.1', 4));
};
