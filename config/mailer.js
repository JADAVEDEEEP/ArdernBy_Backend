const dns = require('dns');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,

  lookup: (hostname, options, callback) => {
    dns.lookup(hostname, { family: 4 }, callback);
  },

  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

module.exports = transporter;