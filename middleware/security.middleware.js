// Small dependency-free security helpers: CORS allowlist, security headers and
// an in-memory rate limiter. (Single-process only; use a shared store if the
// API is ever scaled to several instances.)

const parseOrigins = () =>
  (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const LOCAL_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

// With CORS_ORIGINS set, only those sites (plus localhost outside production)
// may call the API from a browser. Without it the API stays open, like before,
// so a missing variable cannot take the live site down - but a warning is logged.
const corsOptions = () => {
  const configured = parseOrigins();

  if (configured.length === 0) {
    console.warn(
      "CORS_ORIGINS is not set: the API accepts requests from any website. Set it in production."
    );
    return {};
  }

  const allowed = new Set(
    process.env.NODE_ENV === "production"
      ? configured
      : [...configured, ...LOCAL_ORIGINS]
  );

  return {
    origin(origin, callback) {
      // No Origin header = server-to-server / curl / same-origin.
      if (!origin || allowed.has(origin)) return callback(null, true);
      return callback(null, false);
    },
  };
};

const securityHeaders = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  // This server only returns JSON: nothing on it should ever be rendered,
  // framed or cached (responses carry personal and order data).
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store");
  next();
};

// `keyFn(req)` picks what is counted (default: client IP). Returning a falsy
// value skips counting for that request.
const rateLimit = ({ windowMs, max, message, keyFn }) => {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn
      ? keyFn(req)
      : req.ip || req.socket?.remoteAddress || "unknown";

    if (!key) return next();

    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({
        success: false,
        message: message || "Too many requests. Please try again shortly.",
      });
    }

    return next();
  };
};

// Counts per signed-in account (falls back to IP), for use after authentication.
const perUser = (req) => `u:${req.user?.id || req.ip || "unknown"}`;

// Counts per target email and client IP, so a single client cannot flood one
// address with OTP emails or hammer one account, while other users are unaffected.
const perEmail = (req) => {
  const email = req.body?.email;
  if (typeof email !== "string" || !email) return null;
  // Email + IP: an attacker cannot lock a victim out by spamming their address.
  return `e:${email.trim().toLowerCase().slice(0, 254)}|${req.ip || "unknown"}`;
};

module.exports = { corsOptions, securityHeaders, rateLimit, perUser, perEmail };
