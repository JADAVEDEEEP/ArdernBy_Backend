const { poolPromise } = require("../config/sql");
const crypto = require("crypto");

// ==========================================
// GET ALL SUBSCRIPTION PLANS
// ==========================================

const getPlans = async () => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        p.id,
        p.name,
        p.slug,
        p.description,
        p.price,
        p.duration_days,
        p.free_delivery,
        p.discount_percent,
        p.active,
        p.created_at,
        p.updated_at,

        b.id AS benefit_id,
        b.benefit_type,
        b.benefit_value,
        b.description AS benefit_description

      FROM subscription_plans p

      LEFT JOIN subscription_plan_benefits b
        ON p.id = b.plan_id
        AND b.active = 1

      WHERE p.active = 1

      ORDER BY p.price ASC, b.created_at ASC
    `
  );

  const plans = {};

  for (const row of rows) {
    if (!plans[row.id]) {
      plans[row.id] = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        price: row.price,
        duration_days: row.duration_days,
        free_delivery: row.free_delivery,
        discount_percent: row.discount_percent,
        active: row.active,
        created_at: row.created_at,
        updated_at: row.updated_at,
        benefits: [],
      };
    }

    if (row.benefit_id) {
      plans[row.id].benefits.push({
        id: row.benefit_id,
        type: row.benefit_type,
        value: row.benefit_value,
        description: row.benefit_description,
      });
    }
  }

  return Object.values(plans);
};

// ==========================================
// GET PLAN BY ID
// ==========================================

const getPlanById = async (planId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        p.id,
        p.name,
        p.slug,
        p.description,
        p.price,
        p.duration_days,
        p.free_delivery,
        p.discount_percent,
        p.active,
        p.created_at,
        p.updated_at,

        b.id AS benefit_id,
        b.benefit_type,
        b.benefit_value,
        b.description AS benefit_description

      FROM subscription_plans p

      LEFT JOIN subscription_plan_benefits b
        ON p.id = b.plan_id
        AND b.active = 1

      WHERE p.id = ?

      ORDER BY b.created_at ASC
    `,
    [planId]
  );

  if (rows.length === 0) {
    throw new Error("Subscription plan not found.");
  }

  const first = rows[0];

  const plan = {
    id: first.id,
    name: first.name,
    slug: first.slug,
    description: first.description,
    price: first.price,
    duration_days: first.duration_days,
    free_delivery: first.free_delivery,
    discount_percent: first.discount_percent,
    active: first.active,
    created_at: first.created_at,
    updated_at: first.updated_at,
    benefits: [],
  };

  for (const row of rows) {
    if (row.benefit_id) {
      plan.benefits.push({
        id: row.benefit_id,
        type: row.benefit_type,
        value: row.benefit_value,
        description: row.benefit_description,
      });
    }
  }

  return plan;
};

// ==========================================
// GET USER SUBSCRIPTION
// ==========================================

const getUserSubscription = async (userId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        s.id,
        s.user_id,
        s.plan_id,
        s.status,
        s.start_date,
        s.end_date,
        s.auto_renew,
        s.payment_id,
        s.created_at,
        s.updated_at,

        p.name AS plan_name,
        p.slug AS plan_slug,
        p.description AS plan_description,
        p.price AS plan_price,
        p.duration_days,
        p.free_delivery,
        p.discount_percent,

        b.id AS benefit_id,
        b.benefit_type,
        b.benefit_value,
        b.description AS benefit_description

      FROM subscriptions s

      INNER JOIN subscription_plans p
        ON s.plan_id = p.id

      LEFT JOIN subscription_plan_benefits b
        ON p.id = b.plan_id
        AND b.active = 1

      WHERE s.user_id = ?

      ORDER BY s.created_at DESC, b.created_at ASC
    `,
    [userId]
  );

  if (rows.length === 0) {
    return null;
  }

  const first = rows[0];

  const subscription = {
    id: first.id,
    user_id: first.user_id,
    plan_id: first.plan_id,
    status: first.status,
    start_date: first.start_date,
    end_date: first.end_date,
    auto_renew: first.auto_renew,
    payment_id: first.payment_id,
    created_at: first.created_at,
    updated_at: first.updated_at,

    plan: {
      name: first.plan_name,
      slug: first.plan_slug,
      description: first.plan_description,
      price: first.plan_price,
      duration_days: first.duration_days,
      free_delivery: first.free_delivery,
      discount_percent: first.discount_percent,
      benefits: [],
    },
  };

  for (const row of rows) {
    if (row.benefit_id) {
      subscription.plan.benefits.push({
        id: row.benefit_id,
        type: row.benefit_type,
        value: row.benefit_value,
        description: row.benefit_description,
      });
    }
  }

  return subscription;
};

// ==========================================
// CREATE PENDING SUBSCRIPTION
// ==========================================

const createSubscription = async ({
  userId,
  planId,
  paymentId = null,
}) => {
  const pool = await poolPromise;

  // ==========================================
  // CHECK PLAN
  // ==========================================

  const [planRows] = await pool.execute(
    `
      SELECT
        id,
        name,
        slug,
        description,
        price,
        duration_days,
        active,
        free_delivery,
        discount_percent
      FROM subscription_plans
      WHERE id = ?
      LIMIT 1
    `,
    [planId]
  );

  if (planRows.length === 0) {
    throw new Error("Subscription plan not found.");
  }

  const plan = planRows[0];

  if (!plan.active) {
    throw new Error("Subscription plan is inactive.");
  }

  // ==========================================
  // GET ACTIVE SUBSCRIPTION
  // ==========================================

  const [activeRows] = await pool.execute(
    `
      SELECT id
      FROM subscriptions
      WHERE
        user_id = ?
        AND status = 'active'
        AND end_date > UTC_TIMESTAMP()
      LIMIT 1
    `,
    [userId]
  );

  if (activeRows.length > 0) {
    throw new Error(
      "You already have an active subscription."
    );
  }

  // ==========================================
  // CREATE PENDING SUBSCRIPTION
  // ==========================================

  const subscriptionId = crypto.randomUUID();

  await pool.execute(
    `
      INSERT INTO subscriptions
      (
        id,
        user_id,
        plan_id,
        status,
        start_date,
        end_date,
        auto_renew,
        payment_id,
        created_at,
        updated_at
      )
      VALUES
      (
        ?,
        ?,
        ?,
        'pending',
        NULL,
        NULL,
        0,
        ?,
        UTC_TIMESTAMP(6),
        UTC_TIMESTAMP(6)
      )
    `,
    [
      subscriptionId,
      userId,
      planId,
      paymentId,
    ]
  );

  const [subscriptionRows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        plan_id,
        status,
        start_date,
        end_date,
        auto_renew,
        payment_id,
        created_at,
        updated_at
      FROM subscriptions
      WHERE id = ?
      LIMIT 1
    `,
    [subscriptionId]
  );

  return {
    subscription: subscriptionRows[0],
    plan,
  };
};

// ==========================================
// ACTIVATE SUBSCRIPTION
// ==========================================

const activateSubscription = async (
  subscriptionId,
  paymentId = null
) => {
  const pool = await poolPromise;

  // ==========================================
  // GET SUBSCRIPTION
  // ==========================================

  const [subscriptionRows] = await pool.execute(
    `
      SELECT
        s.id,
        s.user_id,
        s.plan_id,
        s.status,
        p.duration_days
      FROM subscriptions s

      INNER JOIN subscription_plans p
        ON s.plan_id = p.id

      WHERE s.id = ?

      LIMIT 1
    `,
    [subscriptionId]
  );

  if (subscriptionRows.length === 0) {
    throw new Error("Subscription not found.");
  }

  const subscription = subscriptionRows[0];

  if (subscription.status !== "pending") {
    throw new Error(
      "Only pending subscriptions can be activated."
    );
  }

  // ==========================================
  // CHECK ACTIVE SUBSCRIPTION
  // ==========================================

  const [activeRows] = await pool.execute(
    `
      SELECT id
      FROM subscriptions
      WHERE
        user_id = ?
        AND status = 'active'
        AND end_date > UTC_TIMESTAMP()
      LIMIT 1
    `,
    [subscription.user_id]
  );

  if (activeRows.length > 0) {
    throw new Error(
      "User already has an active subscription."
    );
  }

  // ==========================================
  // CALCULATE DATES
  // ==========================================

  const startDate = new Date();

  const endDate = new Date(startDate);

  endDate.setDate(
    endDate.getDate() +
      Number(subscription.duration_days)
  );

  // ==========================================
  // UPDATE SUBSCRIPTION
  // ==========================================

  await pool.execute(
    `
      UPDATE subscriptions
      SET
        status = 'active',
        start_date = ?,
        end_date = ?,
        payment_id = COALESCE(?, payment_id),
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [
      startDate,
      endDate,
      paymentId,
      subscriptionId,
    ]
  );

  // ==========================================
  // RETURN UPDATED SUBSCRIPTION
  // ==========================================

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        plan_id,
        status,
        start_date,
        end_date,
        auto_renew,
        payment_id,
        created_at,
        updated_at
      FROM subscriptions
      WHERE id = ?
      LIMIT 1
    `,
    [subscriptionId]
  );

  if (rows.length === 0) {
    throw new Error("Subscription not found.");
  }

  return rows[0];
};

// ==========================================
// CANCEL SUBSCRIPTION
// ==========================================

const cancelSubscription = async (
  userId,
  subscriptionId
) => {
  const pool = await poolPromise;

  // ==========================================
  // CHECK ACTIVE SUBSCRIPTION
  // ==========================================

  const [existingRows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        plan_id,
        status,
        start_date,
        end_date,
        auto_renew,
        payment_id
      FROM subscriptions
      WHERE
        id = ?
        AND user_id = ?
        AND status = 'active'
      LIMIT 1
    `,
    [
      subscriptionId,
      userId,
    ]
  );

  if (existingRows.length === 0) {
    throw new Error(
      "Active subscription not found."
    );
  }

  // ==========================================
  // CANCEL SUBSCRIPTION
  // ==========================================

  await pool.execute(
    `
      UPDATE subscriptions
      SET
        status = 'cancelled',
        auto_renew = 0,
        updated_at = UTC_TIMESTAMP(6)
      WHERE
        id = ?
        AND user_id = ?
        AND status = 'active'
    `,
    [
      subscriptionId,
      userId,
    ]
  );

  // ==========================================
  // RETURN UPDATED SUBSCRIPTION
  // ==========================================

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        plan_id,
        status,
        start_date,
        end_date,
        auto_renew,
        payment_id
      FROM subscriptions
      WHERE id = ?
      LIMIT 1
    `,
    [subscriptionId]
  );

  if (rows.length === 0) {
    throw new Error(
      "Active subscription not found."
    );
  }

  return rows[0];
};

// ==========================================
// CHECK ACTIVE SUBSCRIPTION
// ==========================================

const hasActiveSubscription = async (userId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        s.id,
        s.user_id,
        s.plan_id,

        p.name AS plan_name,
        p.slug AS plan_slug,

        p.free_delivery,
        p.discount_percent,

        s.start_date,
        s.end_date

      FROM subscriptions s

      INNER JOIN subscription_plans p
        ON s.plan_id = p.id

      WHERE
        s.user_id = ?
        AND s.status = 'active'
        AND s.end_date > UTC_TIMESTAMP()

      ORDER BY s.end_date DESC

      LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getPlans,
  getPlanById,
  getUserSubscription,
  createSubscription,
  activateSubscription,
  cancelSubscription,
  hasActiveSubscription,
};