const nodemailer = require('nodemailer');



const transporter = nodemailer.createTransport({
  host: '://gmail.com',
  port: 587,
  secure: false,
  family: 4,
  localAddress: '0.0.0.0', // <-- Add this line to force IPv4 routing
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

module.exports = transporter;