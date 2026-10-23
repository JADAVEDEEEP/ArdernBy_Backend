// Error messages that are safe to show a customer are thrown deliberately as
// plain `new Error("...")`. Driver / network errors (MySQL, SMTP, fetch) carry a
// machine `code`, `sqlMessage` or `responseCode` and can expose table names,
// hosts or queries, so those are replaced with a generic message.
const publicMessage = (error, fallback = "Something went wrong. Please try again.") => {
  if (!error || typeof error.message !== "string" || !error.message) {
    return fallback;
  }

  if (
    error.sqlMessage ||
    error.sqlState ||
    error.responseCode ||
    error.command ||
    error.razorpayStatus ||
    (typeof error.code === "string" && /^(ER_|E[A-Z]+$|PROTOCOL_|ERR_)/.test(error.code))
  ) {
    return fallback;
  }

  // Errors raised by JS itself ("x.trim is not a function") are bugs, not copy.
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return fallback;
  }

  return error.message;
};

module.exports = { publicMessage };
