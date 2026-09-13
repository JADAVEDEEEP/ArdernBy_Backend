const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 2525,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_KEY,
  },
});

const getBrevoSender = () => {
  const address = process.env.BREVO_FROM_EMAIL?.trim();

  if (!address) {
    throw new Error('BREVO_FROM_EMAIL is required.');
  }

  return {
    from: {
      name: 'ARDENBY',
      address,
    },
    envelopeFrom: address,
  };
};

module.exports = {
  transporter,
  getBrevoSender,
};
