// UPI ID (VPA) validation: "handle@bank". Shared by the return form check and the payout.
// Letters, digits and . - _ before the @, letters after it; 100 characters at most.
const UPI_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}@[a-zA-Z][a-zA-Z0-9]{1,31}$/;

const normalizeUpi = (value) => String(value == null ? "" : value).trim().toLowerCase();

const isValidUpi = (value) => {
  const upi = normalizeUpi(value);
  return upi.length >= 5 && upi.length <= 100 && UPI_PATTERN.test(upi);
};

// "deep.jadav@okhdfc" -> "de****@okhdfc": what a customer or e-mail may show.
const maskUpi = (value) => {
  const upi = normalizeUpi(value);
  const at = upi.indexOf("@");
  if (at < 1) return "";
  return `${upi.slice(0, Math.min(2, at))}****${upi.slice(at)}`;
};

module.exports = { isValidUpi, normalizeUpi, maskUpi };
