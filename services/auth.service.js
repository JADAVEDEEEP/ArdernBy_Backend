const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { sql, poolPromise } = require("../config/sql");

const transporter = require("../config/mailer");
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
    process.env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
};

// =====================================================
// FIND USER
// =====================================================

const findUserByEmail = async (email) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("email", sql.VarChar(255), email)
    .query(`
      SELECT TOP 1
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
      FROM dbo.profiles
      WHERE email = @email
    `);

  return result.recordset[0] || null;
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

  const result = await pool
    .request()
    .input(
      "fullName",
      sql.VarChar(150),
      fullName || null
    )
    .input(
      "phone",
      sql.VarChar(30),
      phone || null
    )
    .input(
      "email",
      sql.VarChar(255),
      email
    )
    .input(
      "passwordHash",
      sql.VarChar(255),
      passwordHash
    )
    .query(`
      INSERT INTO dbo.profiles
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
      OUTPUT
        INSERTED.id,
        INSERTED.full_name,
        INSERTED.phone,
        INSERTED.email,
        INSERTED.role,
        INSERTED.auth_provider,
        INSERTED.email_verified,
        INSERTED.is_active
      VALUES
      (
        NEWID(),
        @fullName,
        @phone,
        @email,
        @passwordHash,
        'customer',
        'email',
        0,
        1,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      )
    `);

  return result.recordset[0];
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

  // Invalidate previous OTP
  await pool
    .request()
    .input(
      "email",
      sql.VarChar(255),
      email
    )
    .input(
      "purpose",
      sql.VarChar(50),
      purpose
    )
    .query(`
      UPDATE dbo.email_otps
      SET used_at = SYSUTCDATETIME()
      WHERE
        email = @email
        AND purpose = @purpose
        AND used_at IS NULL
    `);

  // Save OTP hash
  await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      userId
    )
    .input(
      "email",
      sql.VarChar(255),
      email
    )
    .input(
      "otpHash",
      sql.VarChar(255),
      otpHash
    )
    .input(
      "purpose",
      sql.VarChar(50),
      purpose
    )
    .input(
      "expiresAt",
      sql.DateTime2,
      expiresAt
    )
    .query(`
      INSERT INTO dbo.email_otps
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
        NEWID(),
        @userId,
        @email,
        @otpHash,
        @purpose,
        @expiresAt,
        0,
        SYSUTCDATETIME()
      )
    `);

  // Send OTP email
  await transporter.sendMail({
    from: `"ARDENBY" <${process.env.EMAIL_USER}>`,
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
    style="background:#F4F1EC; padding:45px 15px;"
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

  // ===========================================
  // NEW USER
  // ===========================================

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
      message: "Account created. OTP sent to your email.",
    };
  }

  // ===========================================
  // EXISTING USER
  // ===========================================

  if (!user.is_active) {
    throw new Error("Your account is inactive.");
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
    throw new Error("Invalid email or password.");
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
    message: "OTP sent to your email.",
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

  const result = await pool
    .request()
    .input(
      "email",
      sql.VarChar(255),
      email
    )
    .input(
      "purpose",
      sql.VarChar(50),
      purpose
    )
    .query(`
      SELECT TOP 1
        id,
        user_id,
        email,
        otp_hash,
        purpose,
        expires_at,
        attempts,
        used_at
      FROM dbo.email_otps
      WHERE
        email = @email
        AND purpose = @purpose
        AND used_at IS NULL
      ORDER BY created_at DESC
    `);

  const otpRecord = result.recordset[0];

  if (!otpRecord) {
    throw new Error("OTP not found or already used.");
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
    throw new Error("OTP has expired.");
  }

  const valid = verifyOTP(
    otp,
    otpRecord.otp_hash
  );

  if (!valid) {
    await pool
      .request()
      .input(
        "otpId",
        sql.UniqueIdentifier,
        otpRecord.id
      )
      .query(`
        UPDATE dbo.email_otps
        SET attempts = attempts + 1
        WHERE id = @otpId
      `);

    throw new Error("Invalid OTP.");
  }

  // ===========================================
  // MARK OTP USED
  // ===========================================

  await pool
    .request()
    .input(
      "otpId",
      sql.UniqueIdentifier,
      otpRecord.id
    )
    .query(`
      UPDATE dbo.email_otps
      SET used_at = SYSUTCDATETIME()
      WHERE id = @otpId
    `);

  // ===========================================
  // MARK EMAIL VERIFIED
  // ===========================================

  if (purpose === "email_verification") {
    await pool
      .request()
      .input(
        "userId",
        sql.UniqueIdentifier,
        otpRecord.user_id
      )
      .query(`
        UPDATE dbo.profiles
        SET
          email_verified = 1,
          updated_at = SYSUTCDATETIME()
        WHERE id = @userId
      `);
  }

  // ===========================================
  // GET USER
  // ===========================================

  const userResult = await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      otpRecord.user_id
    )
    .query(`
      SELECT TOP 1
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
      FROM dbo.profiles
      WHERE id = @userId
    `);

  const user = userResult.recordset[0];

  if (!user) {
    throw new Error("User not found.");
  }

  // ===========================================
  // PASSWORD RESET OTP
  // OTP VERIFIED → SHORT-LIVED RESET TOKEN
  // ===========================================

  if (purpose === "password_reset") {
    if (!user.is_active) {
      throw new Error("Your account is inactive.");
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
      process.env.JWT_SECRET,
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

  // ===========================================
  // WELCOME EMAIL
  // ONLY AFTER NEW USER VERIFICATION
  // ===========================================

  if (purpose === "email_verification") {
    await sendWelcomeEmail({
      email: user.email,
      name: user.full_name,
    });
  }

  // ===========================================
  // JWT
  // ===========================================

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
  const normalizedEmail = email.trim().toLowerCase();

  const user = await findUserByEmail(normalizedEmail);

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
    message: "Password reset OTP sent to your email.",
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
  const normalizedEmail = email.trim().toLowerCase();

  const allowedPurposes = [
    "login",
    "email_verification",
    "password_reset",
  ];

  if (!allowedPurposes.includes(purpose)) {
    throw new Error("Invalid OTP purpose.");
  }

  const user = await findUserByEmail(normalizedEmail);

  if (!user || !user.is_active) {
    throw new Error("Unable to resend OTP.");
  }

  if (userId && user.id !== userId) {
    throw new Error("Invalid OTP request.");
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
    message: "A new OTP has been sent to your email.",
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
    throw new Error("New password is required.");
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
      process.env.JWT_SECRET
    );
  } catch (error) {
    throw new Error(
      "Password reset session is invalid or has expired."
    );
  }

  // ===========================================
  // RESET TOKEN MUST BE SPECIFICALLY FOR
  // PASSWORD RESET
  // ===========================================

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

  const result = await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      decoded.id
    )
    .input(
      "email",
      sql.VarChar(255),
      decoded.email
    )
    .query(`
      SELECT TOP 1
        id,
        email,
        password_hash,
        auth_provider,
        is_active,
        updated_at
      FROM dbo.profiles
      WHERE
        id = @userId
        AND email = @email
        AND is_active = 1
    `);

  if (result.recordset.length === 0) {
    throw new Error("User not found.");
  }

  const user = result.recordset[0];

  // ===========================================
  // GOOGLE ACCOUNT
  // ===========================================

  if (user.auth_provider === "google") {
    throw new Error(
      "Google accounts cannot use password reset."
    );
  }

  // ===========================================
  // PREVENT RESET TOKEN REUSE
  //
  // If password was already changed after
  // this token was issued, reject the token.
  // ===========================================

  if (user.updated_at) {
    const updatedAt = new Date(
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

  // ===========================================
  // DON'T ALLOW SAME PASSWORD
  // ===========================================

  if (user.password_hash) {
    const samePassword = await bcrypt.compare(
      newPassword,
      user.password_hash
    );

    if (samePassword) {
      throw new Error(
        "New password must be different from current password."
      );
    }
  }

  // ===========================================
  // HASH NEW PASSWORD
  // ===========================================

  const newPasswordHash = await bcrypt.hash(
    newPassword,
    12
  );

  // ===========================================
  // UPDATE PASSWORD
  // ===========================================

  await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      user.id
    )
    .input(
      "passwordHash",
      sql.VarChar(255),
      newPasswordHash
    )
    .query(`
      UPDATE dbo.profiles
      SET
        password_hash = @passwordHash,
        auth_provider = 'email',
        email_verified = 1,
        updated_at = SYSUTCDATETIME()
      WHERE
        id = @userId
        AND is_active = 1
    `);

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

  // ==========================================
  // VERIFY GOOGLE ID TOKEN
  // ==========================================

  const ticket =
    await googleClient.verifyIdToken({
      idToken: credential,
      audience:
        process.env.GOOGLE_CLIENT_ID,
    });

  const payload = ticket.getPayload();

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

  // ==========================================
  // FIND EXISTING USER
  // ==========================================

  const existingUser =
    await findUserByEmail(
      normalizedEmail
    );

  // ==========================================
  // EXISTING USER
  // ==========================================

  if (existingUser) {

    // ========================================
    // PREVIOUSLY DELETED / INACTIVE USER
    // ========================================

    if (!existingUser.is_active) {
      const pool = await poolPromise;

      await pool
        .request()
        .input(
          "userId",
          sql.UniqueIdentifier,
          existingUser.id
        )
        .input(
          "fullName",
          sql.VarChar(150),
          name || null
        )
        .input(
          "email",
          sql.VarChar(255),
          normalizedEmail
        )
        .input(
          "googleId",
          sql.VarChar(255),
          googleId
        )
        .query(`
          UPDATE dbo.profiles
          SET
            full_name = @fullName,
            phone = NULL,
            email = @email,
            password_hash = NULL,
            auth_provider = 'google',
            google_id = @googleId,
            email_verified = 1,
            is_active = 1,
            updated_at = SYSUTCDATETIME()
          WHERE id = @userId;
        `);

      // Get updated user AFTER UPDATE.
      // No OUTPUT because dbo.profiles
      // has enabled triggers.

      const userResult = await pool
        .request()
        .input(
          "userId",
          sql.UniqueIdentifier,
          existingUser.id
        )
        .query(`
          SELECT TOP 1
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
          FROM dbo.profiles
          WHERE id = @userId;
        `);

      const user =
        userResult.recordset[0];

      if (!user) {
        throw new Error(
          "Unable to reactivate account."
        );
      }

      // Welcome email because this is treated
      // as a fresh ARDENBY customer.

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

    // ========================================
    // ACTIVE EMAIL/PASSWORD ACCOUNT
    // ========================================

    if (
      existingUser.auth_provider ===
      "email"
    ) {
      throw new Error(
        "An account already exists with this email. Please login with email and password."
      );
    }

    // ========================================
    // ACTIVE GOOGLE ACCOUNT
    // ========================================

    if (
      existingUser.google_id !==
      googleId
    ) {
      throw new Error(
        "Google account does not match."
      );
    }

    return {
      token: generateToken(existingUser),
      user: existingUser,
      isNewUser: false,
    };
  }

  // ==========================================
  // BRAND NEW GOOGLE USER
  // ==========================================

  const pool = await poolPromise;

  await pool
    .request()
    .input(
      "fullName",
      sql.VarChar(150),
      name || null
    )
    .input(
      "email",
      sql.VarChar(255),
      normalizedEmail
    )
    .input(
      "googleId",
      sql.VarChar(255),
      googleId
    )
    .query(`
      INSERT INTO dbo.profiles
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
        NEWID(),
        @fullName,
        @email,
        NULL,
        'customer',
        'google',
        @googleId,
        1,
        1,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      );
    `);

  // Get newly created user.
  // No OUTPUT because dbo.profiles has triggers.

  const userResult = await pool
    .request()
    .input(
      "email",
      sql.VarChar(255),
      normalizedEmail
    )
    .query(`
      SELECT TOP 1
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
      FROM dbo.profiles
      WHERE email = @email
      ORDER BY created_at DESC;
    `);

  const user =
    userResult.recordset[0];

  if (!user) {
    throw new Error(
      "Google account could not be created."
    );
  }

  // ==========================================
  // WELCOME EMAIL
  // ==========================================

  await sendWelcomeEmail({
    email: user.email,
    name: user.full_name,
  });

  // ==========================================
  // RETURN
  // ==========================================

  return {
    token: generateToken(user),
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