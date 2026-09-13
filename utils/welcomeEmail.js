const transporter = require("../config/mailer");

const SITE_URL = "https://ardenby.vercel.app";

const sendWelcomeEmail = async ({ email, name }) => {
  const firstName = name ? name.split(" ")[0] : "there";

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Welcome to ARDENBY</title>
  </head>
  <body style="margin:0; padding:0; background-color:#0D0D0D; font-family: 'Poppins', Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0D0D0D; padding: 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px; width:100%;">

            <!-- Full-bleed black hero -->
            <tr>
              <td style="background-color:#000000; padding: 56px 32px 48px 32px; text-align:center;">
                <p style="color:#D6C3A5; letter-spacing: 6px; margin:0 0 24px 0; font-size: 13px; font-weight:600;">
                  A R D E N B Y
                </p>
                <h1 style="color:#FFFFFF; font-size: 34px; line-height:1.25; margin: 0 0 16px 0; font-weight:700;">
                  Welcome in,<br/>${firstName}.
                </h1>
                <p style="color:#9C9C9C; font-size: 14px; line-height: 1.7; margin: 0 auto 32px auto; max-width: 400px;">
                  You've just stepped into ARDENBY. Wear Beyond Ordinary
                  starts the moment you open the store.
                </p>
                <a href="${SITE_URL}"
                  style="display:inline-block; background-color:#D6C3A5; color:#000000; text-decoration:none;
                  padding: 16px 44px; border-radius: 999px; font-size: 13px; font-weight:700; letter-spacing: 1.5px; text-transform:uppercase;">
                  Enter the Store
                </a>
              </td>
            </tr>

            <!-- Beige content panel -->
            <tr>
              <td style="background-color:#F5F1EB; padding: 48px 32px;">

                <!-- Section label -->
                <p style="color:#000000; font-size:11px; letter-spacing:3px; margin:0 0 28px 0; text-transform:uppercase; font-weight:700; text-align:center;">
                  Why ARDENBY
                </p>

                <!-- 3 stacked rows, editorial numbered style -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 8px;">
                  <tr>
                    <td style="padding: 18px 0; border-bottom: 1px solid #D6C3A5;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="48" style="vertical-align:top;">
                            <p style="margin:0; font-size:22px; font-weight:700; color:#6B705C;">01</p>
                          </td>
                          <td style="vertical-align:top;">
                            <p style="margin:0; font-size:15px; font-weight:700; color:#111111;">Limited Drops</p>
                            <p style="margin:4px 0 0 0; font-size:13px; color:#6B705C; line-height:1.5;">
                              Every collection is capped. Once it's gone, it's gone.
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 18px 0; border-bottom: 1px solid #D6C3A5;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="48" style="vertical-align:top;">
                            <p style="margin:0; font-size:22px; font-weight:700; color:#6B705C;">02</p>
                          </td>
                          <td style="vertical-align:top;">
                            <p style="margin:0; font-size:15px; font-weight:700; color:#111111;">Premium Fabric</p>
                            <p style="margin:4px 0 0 0; font-size:13px; color:#6B705C; line-height:1.5;">
                              Built for fit and feel, not just the drop day photo.
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 18px 0;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="48" style="vertical-align:top;">
                            <p style="margin:0; font-size:22px; font-weight:700; color:#6B705C;">03</p>
                          </td>
                          <td style="vertical-align:top;">
                            <p style="margin:0; font-size:15px; font-weight:700; color:#111111;">Fast, Free Shipping</p>
                            <p style="margin:4px 0 0 0; font-size:13px; color:#6B705C; line-height:1.5;">
                              Free on orders above ₹1,999, delivered fast pan-India.
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

              </td>
            </tr>

            <!-- Olive CTA banner -->
            <tr>
              <td style="background-color:#6B705C; padding: 36px 32px; text-align:center;">
                <p style="color:#FFFFFF; font-size:18px; font-weight:700; margin:0 0 6px 0;">
                  Your first order is waiting.
                </p>
                <p style="color:#E5E1D6; font-size:13px; margin:0 0 22px 0;">
                  Explore the full ARDENBY catalogue now.
                </p>
                <a href="${SITE_URL}"
                  style="display:inline-block; background-color:#000000; color:#FFFFFF; text-decoration:none;
                  padding: 14px 36px; border-radius: 999px; font-size: 12px; font-weight:700; letter-spacing: 1.5px; text-transform:uppercase;">
                  Shop Now
                </a>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color:#000000; padding: 32px; text-align:center;">
                <p style="color:#D6C3A5; letter-spacing: 4px; margin:0 0 14px 0; font-size: 13px; font-weight: 700;">
                  ARDENBY
                </p>
                <p style="color:#7A7A7A; font-size: 11px; margin:0 0 6px 0;">
                  © ${new Date().getFullYear()} ARDENBY. All rights reserved.
                </p>
                <a href="${SITE_URL}" style="color:#9C9C9C; text-decoration:underline; font-size: 11px;">
                  ${SITE_URL.replace("https://", "")}
                </a>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  await transporter.sendMail({
  from: `"ARDENBY" <${process.env.BREVO_FROM_EMAIL}>`,
  to: email,
  subject: `Welcome in, ${firstName}. ARDENBY is yours now.`,
  html,
});
};

module.exports = sendWelcomeEmail;