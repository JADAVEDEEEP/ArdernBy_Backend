const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");

const { poolPromise } = require("../config/sql");

const {
  transporter,
  getBrevoSender,
} = require("../config/mailer");

const { getJwtSecret } = require("../config/jwt");
const sendWelcomeEmail = require("../utils/welcomeEmail");
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID
);

const {
  generateOTP,
  hashOTP,
  verifyOTP,
} = require("../utils/otp");

// =====================================================
// JWT
// =====================================================

const generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    getJwtSecret(),
    {
      // Privileged sessions are shorter-lived than customer sessions.
      expiresIn: ["admin", "superadmin"].includes(user.role) ? "24h" : "7d",
    }
  );
};

// =====================================================
// FIND USER
// =====================================================

const findUserByEmail = async (email) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        full_name,
        phone,
        email,
        password_hash,
        gender,
        role,
        auth_provider,
        google_id,
        email_verified,
        is_active,
        updated_at
      FROM profiles
      WHERE email = ?
      LIMIT 1
    `,
    [email]
  );

  return rows[0] || null;
};

// =====================================================
// CREATE CUSTOMER
// =====================================================

const createCustomer = async ({
  fullName,
  phone,
  email,
  password,
}) => {
  const pool = await poolPromise;

  const passwordHash = await bcrypt.hash(password, 12);
  const userId = randomUUID();

  await pool.execute(
    `
      INSERT INTO profiles
      (
        id,
        full_name,
        phone,
        email,
        password_hash,
        role,
        auth_provider,
        email_verified,
        is_active,
        created_at,
        updated_at
      )
      VALUES
      (
        ?,
        ?,
        ?,
        ?,
        ?,
        'customer',
        'email',
        0,
        1,
        UTC_TIMESTAMP(6),
        UTC_TIMESTAMP(6)
      )
    `,
    [
      userId,
      fullName || null,
      phone || null,
      email,
      passwordHash,
    ]
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        full_name,
        phone,
        email,
        role,
        auth_provider,
        email_verified,
        is_active
      FROM profiles
      WHERE id = ?
      LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
};

// =====================================================
// SEND OTP
// =====================================================

const sendOTP = async ({
  userId,
  email,
  purpose,
}) => {
  const pool = await poolPromise;

  const otp = generateOTP();

  const otpHash = hashOTP(otp);

  const expiresAt = new Date(
    Date.now() + 10 * 60 * 1000
  );

  // ===================================================
  // INVALIDATE PREVIOUS OTP
  // ===================================================

  await pool.execute(
    `
      UPDATE email_otps
      SET used_at = UTC_TIMESTAMP(6)
      WHERE
        email = ?
        AND purpose = ?
        AND used_at IS NULL
    `,
    [
      email,
      purpose,
    ]
  );

  // ===================================================
  // SAVE OTP HASH
  // ===================================================

  const otpId = randomUUID();

  await pool.execute(
    `
      INSERT INTO email_otps
      (
        id,
        user_id,
        email,
        otp_hash,
        purpose,
        expires_at,
        attempts,
        created_at
      )
      VALUES
      (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        0,
        UTC_TIMESTAMP(6)
      )
    `,
    [
      otpId,
      userId,
      email,
      otpHash,
      purpose,
      expiresAt,
    ]
  );

  // ===================================================
  // SEND OTP EMAIL
  // ===================================================

  const sender = getBrevoSender();

  await transporter.sendMail({
    from: sender.from,

    envelope: {
      from: sender.envelopeFrom,
      to: email,
    },

    to: email,

    subject: "Your ARDENBY Verification Code",

    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />

  <title>ARDENBY Verification</title>
</head>

<body style="
  margin:0;
  padding:0;
  background:#F4F1EC;
  font-family:Arial, Helvetica, sans-serif;
  color:#171717;
">

  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="
      background:#F4F1EC;
      padding:45px 15px;
    "
  >
    <tr>
      <td align="center">

        <table
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="
            max-width:560px;
            background:#FFFFFF;
            border:1px solid #E6E0D7;
          "
        >

          <tr>
            <td
              align="center"
              style="padding:38px 30px 28px;"
            >

              <div style="
                font-family:Georgia, 'Times New Roman', serif;
                font-size:30px;
                font-weight:bold;
                letter-spacing:8px;
                color:#111111;
              ">
                ARDENBY
              </div>

              <div style="
                width:45px;
                height:1px;
                background:#B8A98F;
                margin:18px auto 0;
              "></div>

            </td>
          </tr>

          <tr>
            <td style="padding:10px 45px 45px;">

              <h1 style="
                margin:0 0 14px;
                text-align:center;
                font-family:Georgia, 'Times New Roman', serif;
                font-size:28px;
                font-weight:normal;
                color:#191919;
              ">
                Verify your account
              </h1>

              <p style="
                margin:0 auto;
                max-width:400px;
                text-align:center;
                font-size:15px;
                line-height:1.7;
                color:#666666;
              ">
                Use the verification code below to securely
                continue with your ARDENBY account.
              </p>

              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="
                  margin:32px 0 25px;
                  background:#FBF9F5;
                  border:1px solid #E3DCD1;
                "
              >
                <tr>

                  <td
                    align="center"
                    style="padding:28px 20px;"
                  >

                    <div style="
                      font-size:11px;
                      font-weight:bold;
                      letter-spacing:3px;
                      color:#8A7C69;
                      text-transform:uppercase;
                      margin-bottom:15px;
                    ">
                      Verification Code
                    </div>

                    <div style="
                      font-family:Arial, Helvetica, sans-serif;
                      font-size:34px;
                      font-weight:bold;
                      letter-spacing:9px;
                      color:#111111;
                      padding-left:9px;
                    ">
                      ${otp}
                    </div>

                  </td>

                </tr>
              </table>

              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="margin-bottom:28px;"
              >
                <tr>

                  <td width="28" valign="top">

                    <div style="
                      width:22px;
                      height:22px;
                      line-height:22px;
                      text-align:center;
                      border:1px solid #CFC6B8;
                      border-radius:50%;
                      font-size:12px;
                      color:#756A5B;
                    ">
                      ⏱
                    </div>

                  </td>

                  <td style="
                    padding-left:10px;
                    font-size:13px;
                    line-height:1.6;
                    color:#666666;
                  ">

                    This verification code will expire in

                    <strong style="color:#333333;">
                      10 minutes
                    </strong>.

                  </td>

                </tr>
              </table>

              <div style="
                border-top:1px solid #EAE5DE;
                padding-top:22px;
              ">

                <p style="
                  margin:0;
                  font-size:13px;
                  line-height:1.7;
                  color:#777777;
                  text-align:center;
                ">
                  If you didn't request this verification code,
                  you can safely ignore this email.
                </p>

              </div>

            </td>
          </tr>

          <tr>

            <td style="
              background:#171717;
              padding:25px 30px;
              text-align:center;
            ">

              <div style="
                font-family:Georgia, 'Times New Roman', serif;
                font-size:16px;
                letter-spacing:4px;
                color:#FFFFFF;
                margin-bottom:10px;
              ">
                ARDENBY
              </div>

              <p style="
                margin:0;
                font-size:11px;
                line-height:1.6;
                color:#A8A8A8;
              ">
                © ${new Date().getFullYear()} ARDENBY.
                All rights reserved.
              </p>

            </td>

          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>
    `,
  });
};

// =====================================================
// AUTH
// ONE API → REGISTER OR LOGIN
// =====================================================

const authenticate = async ({
  fullName,
  phone,
  email,
  password,
}) => {
  const user = await findUserByEmail(email);

  // ===================================================
  // NEW USER
  // ===================================================

  if (!user) {
    const newUser = await createCustomer({
      fullName,
      phone,
      email,
      password,
    });

    await sendOTP({
      userId: newUser.id,
      email: newUser.email,
      purpose: "email_verification",
    });

    return {
      userId: newUser.id,
      email: newUser.email,
      isNewUser: true,
      requiresOTP: true,
      purpose: "email_verification",
      message:
        "Account created. OTP sent to your email.",
    };
  }

  // ===================================================
  // EXISTING USER
  // ===================================================

  if (!user.is_active) {
    throw new Error(
      "Your account is inactive."
    );
  }

  if (!user.password_hash) {
    throw new Error(
      "This account uses Google Login. Please continue with Google."
    );
  }

  const passwordMatch = await bcrypt.compare(
    password,
    user.password_hash
  );

  if (!passwordMatch) {
    throw new Error(
      "Invalid email or password."
    );
  }

  await sendOTP({
    userId: user.id,
    email: user.email,
    purpose: "login",
  });

  return {
    userId: user.id,
    email: user.email,
    isNewUser: false,
    requiresOTP: true,
    purpose: "login",
    message:
      "OTP sent to your email.",
  };
};

// =====================================================
// VERIFY OTP
// =====================================================

const verifyUserOTP = async ({
  email,
  otp,
  purpose,
}) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        email,
        otp_hash,
        purpose,
        expires_at,
        attempts,
        used_at
      FROM email_otps
      WHERE
        email = ?
        AND purpose = ?
        AND used_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [
      email,
      purpose,
    ]
  );

  const otpRecord = rows[0];

  if (!otpRecord) {
    throw new Error(
      "OTP not found or already used."
    );
  }

  if (otpRecord.attempts >= 5) {
    throw new Error(
      "Too many OTP attempts. Please request a new OTP."
    );
  }

  if (
    new Date(otpRecord.expires_at).getTime() <
    Date.now()
  ) {
    throw new Error(
      "OTP has expired."
    );
  }

  const valid = verifyOTP(
    otp,
    otpRecord.otp_hash
  );

  if (!valid) {
    await pool.execute(
      `
        UPDATE email_otps
        SET attempts = attempts + 1
        WHERE id = ?
      `,
      [otpRecord.id]
    );

    throw new Error(
      "Invalid OTP."
    );
  }

  // ===================================================
  // MARK OTP USED
  // ===================================================

  await pool.execute(
    `
      UPDATE email_otps
      SET used_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [otpRecord.id]
  );

  // ===================================================
  // MARK EMAIL VERIFIED
  // ===================================================

  if (purpose === "email_verification") {
    await pool.execute(
      `
        UPDATE profiles
        SET
          email_verified = 1,
          updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?
      `,
      [otpRecord.user_id]
    );
  }

  // ===================================================
  // GET USER
  // ===================================================

  const [userRows] = await pool.execute(
    `
      SELECT
        id,
        full_name,
        phone,
        email,
        gender,
        role,
        auth_provider,
        email_verified,
        is_active,
        updated_at
      FROM profiles
      WHERE id = ?
      LIMIT 1
    `,
    [otpRecord.user_id]
  );

  const user = userRows[0];

  if (!user) {
    throw new Error(
      "User not found."
    );
  }

  if (!user.is_active) {
    throw new Error(
      "Your account is inactive."
    );
  }

  // ===================================================
  // PASSWORD RESET OTP
  // OTP VERIFIED → SHORT-LIVED RESET TOKEN
  // ===================================================

  if (purpose === "password_reset") {

    if (!user.is_active) {
      throw new Error(
        "Your account is inactive."
      );
    }

    if (user.auth_provider === "google") {
      throw new Error(
        "Google accounts cannot use password reset."
      );
    }

    const resetToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        purpose: "password_reset",
      },
      getJwtSecret(),
      {
        expiresIn: "10m",
      }
    );

    return {
      resetToken,
      purpose: "password_reset",
      message:
        "OTP verified. You can now reset your password.",
    };
  }

  // ===================================================
  // WELCOME EMAIL
  // ONLY AFTER NEW USER VERIFICATION
  // ===================================================

  if (purpose === "email_verification") {
    await sendWelcomeEmail({
      email: user.email,
      name: user.full_name,
    });
  }

  // ===================================================
  // JWT
  // ===================================================

  const token = generateToken(user);

  return {
    token,
    user,
  };
};

// =====================================================
// FORGOT PASSWORD — REQUEST OTP
// =====================================================

const requestPasswordReset = async (email) => {
  const normalizedEmail =
    email.trim().toLowerCase();

  const user =
    await findUserByEmail(
      normalizedEmail
    );

  /*
    IMPORTANT:
    Do not reveal whether an email exists.
    This prevents account/email enumeration.
  */

  if (!user || !user.is_active) {
    return {
      message:
        "If an account exists with this email, a password reset OTP has been sent.",
    };
  }

  /*
    Google accounts don't have a normal password.
    We still return the same generic message.
  */

  if (
    user.auth_provider === "google" ||
    !user.password_hash
  ) {
    return {
      message:
        "If an account exists with this email, a password reset OTP has been sent.",
    };
  }

  await sendOTP({
    userId: user.id,
    email: user.email,
    purpose: "password_reset",
  });

  return {
    userId: user.id,
    email: user.email,
    requiresOTP: true,
    purpose: "password_reset",
    message:
      "Password reset OTP sent to your email.",
  };
};

// =====================================================
// RESEND OTP
// =====================================================

const resendOTP = async ({
  email,
  userId,
  purpose,
}) => {
  const normalizedEmail =
    email.trim().toLowerCase();

  const allowedPurposes = [
    "login",
    "email_verification",
    "password_reset",
  ];

  if (!allowedPurposes.includes(purpose)) {
    throw new Error(
      "Invalid OTP purpose."
    );
  }

  const user =
    await findUserByEmail(
      normalizedEmail
    );

  if (!user || !user.is_active) {
    throw new Error(
      "Unable to resend OTP."
    );
  }

  if (userId && user.id !== userId) {
    throw new Error(
      "Invalid OTP request."
    );
  }

  if (
    purpose === "password_reset" &&
    (
      user.auth_provider === "google" ||
      !user.password_hash
    )
  ) {
    throw new Error(
      "This account uses Google Login. Please continue with Google."
    );
  }

  await sendOTP({
    userId: user.id,
    email: user.email,
    purpose,
  });

  return {
    email: user.email,
    purpose,
    message:
      "A new OTP has been sent to your email.",
  };
};

// =====================================================
// RESET PASSWORD
// OTP VERIFIED → RESET TOKEN REQUIRED
// =====================================================

const resetPassword = async ({
  resetToken,
  newPassword,
}) => {

  if (!resetToken) {
    throw new Error(
      "Password reset token is required."
    );
  }

  if (!newPassword) {
    throw new Error(
      "New password is required."
    );
  }

  if (newPassword.length < 8) {
    throw new Error(
      "New password must be at least 8 characters."
    );
  }

  let decoded;

  try {
    decoded = jwt.verify(
      resetToken,
      getJwtSecret()
    );
  } catch (error) {
    throw new Error(
      "Password reset session is invalid or has expired."
    );
  }

  // ===================================================
  // RESET TOKEN MUST BE SPECIFICALLY FOR
  // PASSWORD RESET
  // ===================================================

  if (
    !decoded ||
    decoded.purpose !== "password_reset" ||
    !decoded.id ||
    !decoded.email ||
    !decoded.iat
  ) {
    throw new Error(
      "Invalid password reset token."
    );
  }

  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        email,
        password_hash,
        auth_provider,
        is_active,
        updated_at
      FROM profiles
      WHERE
        id = ?
        AND email = ?
        AND is_active = 1
      LIMIT 1
    `,
    [
      decoded.id,
      decoded.email,
    ]
  );

  if (rows.length === 0) {
    throw new Error(
      "User not found."
    );
  }

  const user = rows[0];

  // ===================================================
  // GOOGLE ACCOUNT
  // ===================================================

  if (user.auth_provider === "google") {
    throw new Error(
      "Google accounts cannot use password reset."
    );
  }

  // ===================================================
  // PREVENT RESET TOKEN REUSE
  //
  // If password was already changed after
  // this token was issued, reject the token.
  // ===================================================

  if (user.updated_at) {

    const updatedAt =
      new Date(
        user.updated_at
      ).getTime();

    const tokenIssuedAt =
      decoded.iat * 1000;

    if (updatedAt > tokenIssuedAt) {
      throw new Error(
        "Password reset session is no longer valid."
      );
    }
  }

  // ===================================================
  // DON'T ALLOW SAME PASSWORD
  // ===================================================

  if (user.password_hash) {

    const samePassword =
      await bcrypt.compare(
        newPassword,
        user.password_hash
      );

    if (samePassword) {
      throw new Error(
        "New password must be different from current password."
      );
    }
  }

  // ===================================================
  // HASH NEW PASSWORD
  // ===================================================

  const newPasswordHash =
    await bcrypt.hash(
      newPassword,
      12
    );

  // ===================================================
  // UPDATE PASSWORD
  // ===================================================

  await pool.execute(
    `
      UPDATE profiles
      SET
        password_hash = ?,
        auth_provider = 'email',
        email_verified = 1,
        updated_at = UTC_TIMESTAMP(6)
      WHERE
        id = ?
        AND is_active = 1
    `,
    [
      newPasswordHash,
      user.id,
    ]
  );

  return true;
};

// =====================================================
// GOOGLE LOGIN
// =====================================================

const googleLogin = async (credential) => {

  if (!credential) {
    throw new Error(
      "Google credential is required."
    );
  }

  // ===================================================
  // VERIFY GOOGLE ID TOKEN
  // ===================================================

  const ticket =
    await googleClient.verifyIdToken({
      idToken: credential,
      audience:
        process.env.GOOGLE_CLIENT_ID,
    });

  const payload =
    ticket.getPayload();

  const {
    sub: googleId,
    email,
    name,
    email_verified,
  } = payload;

  if (!email || !email_verified) {
    throw new Error(
      "Google email is not verified."
    );
  }

  const normalizedEmail =
    email.trim().toLowerCase();

  // ===================================================
  // FIND EXISTING USER
  // ===================================================

  const existingUser =
    await findUserByEmail(
      normalizedEmail
    );

  // ===================================================
  // EXISTING USER
  // ===================================================

  if (existingUser) {

    // =================================================
    // PREVIOUSLY DELETED / INACTIVE USER
    // =================================================

    if (!existingUser.is_active) {
      // Only a customer who deleted their own account may be revived this way.
      // A deactivated admin must be re-enabled by the store owner in the database.
      if (existingUser.role !== "customer") {
        throw new Error(
          "Your account is inactive."
        );
      }

      const pool =
        await poolPromise;

      await pool.execute(
        `
          UPDATE profiles
          SET
            full_name = ?,
            phone = NULL,
            email = ?,
            password_hash = NULL,
            auth_provider = 'google',
            google_id = ?,
            email_verified = 1,
            is_active = 1,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = ?
        `,
        [
          name || null,
          normalizedEmail,
          googleId,
          existingUser.id,
        ]
      );

      // ===============================================
      // GET UPDATED USER AFTER UPDATE
      // ===============================================

      const [userRows] =
        await pool.execute(
          `
            SELECT
              id,
              full_name,
              phone,
              email,
              gender,
              role,
              auth_provider,
              google_id,
              email_verified,
              is_active,
              updated_at
            FROM profiles
            WHERE id = ?
            LIMIT 1
          `,
          [existingUser.id]
        );

      const user =
        userRows[0];

      if (!user) {
        throw new Error(
          "Unable to reactivate account."
        );
      }

      // ===============================================
      // WELCOME EMAIL
      // ===============================================

      await sendWelcomeEmail({
        email: user.email,
        name: user.full_name,
      });

      return {
        token: generateToken(user),
        user,
        isNewUser: true,
      };
    }

    // =================================================
    // ACTIVE EMAIL/PASSWORD ACCOUNT
    // =================================================

    if (
      existingUser.auth_provider ===
      "email"
    ) {
      throw new Error(
        "An account already exists with this email. Please login with email and password."
      );
    }

    // =================================================
    // ACTIVE GOOGLE ACCOUNT
    // =================================================

    if (
      existingUser.google_id !==
      googleId
    ) {
      throw new Error(
        "Google account does not match."
      );
    }

    return {
      token:
        generateToken(existingUser),

      user: existingUser,

      isNewUser: false,
    };
  }

  // ===================================================
  // BRAND NEW GOOGLE USER
  // ===================================================

  const pool =
    await poolPromise;

  const userId =
    randomUUID();

  await pool.execute(
    `
      INSERT INTO profiles
      (
        id,
        full_name,
        email,
        password_hash,
        role,
        auth_provider,
        google_id,
        email_verified,
        is_active,
        created_at,
        updated_at
      )
      VALUES
      (
        ?,
        ?,
        ?,
        NULL,
        'customer',
        'google',
        ?,
        1,
        1,
        UTC_TIMESTAMP(6),
        UTC_TIMESTAMP(6)
      )
    `,
    [
      userId,
      name || null,
      normalizedEmail,
      googleId,
    ]
  );

  // ===================================================
  // GET NEWLY CREATED USER
  // ===================================================

  const [userRows] =
    await pool.execute(
      `
        SELECT
          id,
          full_name,
          phone,
          email,
          gender,
          role,
          auth_provider,
          google_id,
          email_verified,
          is_active,
          updated_at
        FROM profiles
        WHERE email = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [normalizedEmail]
    );

  const user =
    userRows[0];

  if (!user) {
    throw new Error(
      "Google account could not be created."
    );
  }

  // ===================================================
  // WELCOME EMAIL
  // ===================================================

  await sendWelcomeEmail({
    email: user.email,
    name: user.full_name,
  });

  // ===================================================
  // RETURN
  // ===================================================

  return {
    token:
      generateToken(user),

    user,

    isNewUser: true,
  };
};

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  authenticate,
  verifyUserOTP,
  sendOTP,
  googleLogin,
  requestPasswordReset,
  resendOTP,
  resetPassword,
};