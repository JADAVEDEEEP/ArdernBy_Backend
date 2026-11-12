// Builds the mysql2 `ssl` option from environment variables.
//
//   DB_SSL unset / empty  -> undefined (no TLS requested; behaviour unchanged)
//   DB_SSL=required       -> encrypted connection, server certificate NOT verified
//   DB_SSL=verify         -> encrypted connection, certificate verified against DB_CA_CERT
//
// DB_CA_CERT holds the PEM text of the provider's CA certificate. Real newlines or
// literal "\n" sequences (as many hosts' env editors produce) are both accepted.
// An unknown DB_SSL value, or `verify` without a CA, throws at startup instead of
// silently falling back to a weaker mode.

function buildSslOption(env = process.env) {
  const mode = String(env.DB_SSL || "").trim().toLowerCase();
  if (!mode) return undefined;

  if (mode === "required") return { rejectUnauthorized: false };

  if (mode === "verify") {
    const ca = String(env.DB_CA_CERT || "").replace(/\\n/g, "\n").trim();
    if (!ca.includes("BEGIN CERTIFICATE")) {
      throw new Error("DB_SSL=verify needs DB_CA_CERT to contain the CA certificate in PEM format.");
    }
    return { ca, rejectUnauthorized: true };
  }

  throw new Error(`Invalid DB_SSL value "${mode}". Use "required", "verify", or leave it unset.`);
}

module.exports = { buildSslOption };
