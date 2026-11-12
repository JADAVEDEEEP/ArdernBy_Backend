const { deliver } = require("../services/notification.service");

// Welcome e-mail (branded template in services/email/templates.js).
const sendWelcomeEmail = async ({ email, name }) => {
  await deliver({
    to: email,
    template: "welcome",
    data: { name: name ? String(name).split(" ")[0] : "" },
  });
};

module.exports = sendWelcomeEmail;
