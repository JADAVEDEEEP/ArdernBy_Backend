const getJwtSecret = () => {
  const secret =
    process.env.JWT_SECRET ||
    process.env.JWT_SECRET_KEY ||
    process.env.SECRET_KEY ||
    'Adernby';

  return secret.trim();
};

module.exports = {
  getJwtSecret,
};
