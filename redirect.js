// Lightweight redirect-only server.
//
// Used by the `calripken` Render service so https://calripken.onrender.com
// forwards to the real app. It deliberately does NOT require db.js or any
// credentials -- it needs no DATABASE_URL, SMTP or Twilio config, so the
// service can run with nothing but this file.
//
// Set that service's Start Command to:  node redirect.js
// Override the destination with REDIRECT_TO if the real URL ever changes.

const http = require('http');

const TARGET = (process.env.REDIRECT_TO || 'https://cal-ripken-allstars.onrender.com').replace(/\/+$/, '');
const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  // 302 (not 301) on purpose: browsers cache 301s aggressively and we may
  // want to point this hostname somewhere else later without users being
  // stuck on a stale redirect.
  const location = TARGET + (req.url || '/');
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end('Redirecting to ' + location);
}).listen(PORT, () => {
  console.log(`Redirect server listening on ${PORT} -> ${TARGET}`);
});
