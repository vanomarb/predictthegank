// Vercel's entry point. Every request — pages, static files and API alike — is
// handled by the same Express app that `node server.js` runs locally, so there
// is one code path and no "works on my machine" gap between the two.
//
// It has to be the whole app rather than just /api: index.html and admin.html
// carry an inline <script type="importmap">, which the CSP only allows with a
// per-request nonce stamped in by server.js. Serving those two documents as
// static files would skip the stamp and break the 3D countdown's module
// resolution — see sendHtmlWithNonce there, and the routes in vercel.json that
// keep Vercel from serving public/ itself.
module.exports = require('../server.js');
