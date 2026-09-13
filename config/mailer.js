const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',  // <-- FIXED: Changed from '://gmail.com'
  port: 587,
  secure: false,
  family: 4,
  localAddress: '0.0.0.0', 
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

module.exports = transporter;