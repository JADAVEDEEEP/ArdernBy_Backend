const getJwtSecret = () => {
  const secret =
    process.env.JWT_SECRET ||
    process.env.JWT_SECRET_KEY ||
    process.env.SECRET_KEY;

  if (!secret || !secret.trim()) {
    // A publicly known fallback secret would let anyone forge admin tokens.
    throw new Error('JWT_SECRET is not configured.');
  }

  return secret.trim();
};

module.exports = {
  getJwtSecret,
};
