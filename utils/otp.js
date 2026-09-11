const crypto = require("crypto");

const generateOTP = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

const hashOTP = (otp) => {
  return crypto
    .createHash("sha256")
    .update(otp)
    .digest("hex");
};

const verifyOTP = (otp, otpHash) => {
  const hash = hashOTP(otp);

  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(otpHash, "hex")
  );
};

module.exports = {
  generateOTP,
  hashOTP,
  verifyOTP,
};