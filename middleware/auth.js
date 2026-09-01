const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in the environment (see .env.example)');
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.session;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, name, isAdmin }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  next();
}

// Decodes the session cookie if present but never rejects — used by endpoints
// that serve both the public, unauthenticated page and the admin dashboard.
function optionalAuth(req, res, next) {
  const token = req.cookies && req.cookies.session;
  if (!token) return next();
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    // Expired/invalid token on a route that doesn't require auth — ignore it.
  }
  next();
}

function signToken(account) {
  return jwt.sign(
    { id: account.id, name: account.name, isAdmin: !!account.is_admin },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = { requireAuth, requireAdmin, optionalAuth, signToken };
