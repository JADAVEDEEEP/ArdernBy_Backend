const { sql, poolPromise } = require("../config/sql");

// ==========================================
// GET ALL SUBSCRIPTION PLANS
// ==========================================

const getPlans = async () => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .query(`
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
    `);

  const plans = {};

  for (const row of result.recordset) {
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

  const result = await pool
    .request()
    .input("planId", sql.UniqueIdentifier, planId)
    .query(`
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

      WHERE p.id = @planId

      ORDER BY b.created_at ASC
    `);

  if (result.recordset.length === 0) {
    throw new Error("Subscription plan not found.");
  }

  const first = result.recordset[0];

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

  for (const row of result.recordset) {
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

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
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

      WHERE s.user_id = @userId

      ORDER BY s.created_at DESC, b.created_at ASC
    `);

  if (result.recordset.length === 0) {
    return null;
  }

  const first = result.recordset[0];

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

  for (const row of result.recordset) {
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

  // Check plan
  const planResult = await pool
    .request()
    .input("planId", sql.UniqueIdentifier, planId)
    .query(`
      SELECT TOP 1
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
      WHERE id = @planId
    `);

  if (planResult.recordset.length === 0) {
    throw new Error("Subscription plan not found.");
  }

  const plan = planResult.recordset[0];

  if (!plan.active) {
    throw new Error("Subscription plan is inactive.");
  }

  // Get active subscription
  const activeResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
        id
      FROM subscriptions
      WHERE
        user_id = @userId
        AND status = 'active'
        AND end_date > SYSUTCDATETIME()
    `);

  if (activeResult.recordset.length > 0) {
    throw new Error(
      "You already have an active subscription."
    );
  }

  // Create pending subscription
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("planId", sql.UniqueIdentifier, planId)
    .input("paymentId", sql.NVarChar(100), paymentId)
    .query(`
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
      OUTPUT
        INSERTED.id,
        INSERTED.user_id,
        INSERTED.plan_id,
        INSERTED.status,
        INSERTED.start_date,
        INSERTED.end_date,
        INSERTED.auto_renew,
        INSERTED.payment_id,
        INSERTED.created_at,
        INSERTED.updated_at
      VALUES
      (
        NEWID(),
        @userId,
        @planId,
        'pending',
        NULL,
        NULL,
        0,
        @paymentId,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      )
    `);

  return {
    subscription: result.recordset[0],
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

  const result = await pool
    .request()
    .input(
      "subscriptionId",
      sql.UniqueIdentifier,
      subscriptionId
    )
    .query(`
      SELECT TOP 1
        s.id,
        s.user_id,
        s.plan_id,
        s.status,
        p.duration_days
      FROM subscriptions s
      INNER JOIN subscription_plans p
        ON s.plan_id = p.id
      WHERE s.id = @subscriptionId
    `);

  if (result.recordset.length === 0) {
    throw new Error("Subscription not found.");
  }

  const subscription = result.recordset[0];

  if (subscription.status !== "pending") {
    throw new Error(
      "Only pending subscriptions can be activated."
    );
  }

  // Check if user already has active subscription
  const activeResult = await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      subscription.user_id
    )
    .query(`
      SELECT TOP 1 id
      FROM subscriptions
      WHERE
        user_id = @userId
        AND status = 'active'
        AND end_date > SYSUTCDATETIME()
    `);

  if (activeResult.recordset.length > 0) {
    throw new Error(
      "User already has an active subscription."
    );
  }

  const startDate = new Date();

  const endDate = new Date(startDate);

  endDate.setDate(
    endDate.getDate() +
      subscription.duration_days
  );

  const updateResult = await pool
    .request()
    .input(
      "subscriptionId",
      sql.UniqueIdentifier,
      subscriptionId
    )
    .input(
      "startDate",
      sql.DateTime2,
      startDate
    )
    .input(
      "endDate",
      sql.DateTime2,
      endDate
    )
    .input(
      "paymentId",
      sql.NVarChar(100),
      paymentId
    )
    .query(`
      UPDATE subscriptions

      SET
        status = 'active',
        start_date = @startDate,
        end_date = @endDate,

        payment_id =
          COALESCE(@paymentId, payment_id),

        updated_at = SYSUTCDATETIME()

      OUTPUT
        INSERTED.id,
        INSERTED.user_id,
        INSERTED.plan_id,
        INSERTED.status,
        INSERTED.start_date,
        INSERTED.end_date,
        INSERTED.auto_renew,
        INSERTED.payment_id,
        INSERTED.created_at,
        INSERTED.updated_at

      WHERE id = @subscriptionId
    `);

  return updateResult.recordset[0];
};

// ==========================================
// CANCEL SUBSCRIPTION
// ==========================================

const cancelSubscription = async (
  userId,
  subscriptionId
) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      userId
    )
    .input(
      "subscriptionId",
      sql.UniqueIdentifier,
      subscriptionId
    )
    .query(`
      UPDATE subscriptions

      SET
        status = 'cancelled',
        auto_renew = 0,
        updated_at = SYSUTCDATETIME()

      OUTPUT
        INSERTED.id,
        INSERTED.user_id,
        INSERTED.plan_id,
        INSERTED.status,
        INSERTED.start_date,
        INSERTED.end_date,
        INSERTED.auto_renew,
        INSERTED.payment_id

      WHERE
        id = @subscriptionId
        AND user_id = @userId
        AND status = 'active'
    `);

  if (result.recordset.length === 0) {
    throw new Error(
      "Active subscription not found."
    );
  }

  return result.recordset[0];
};

// ==========================================
// CHECK ACTIVE SUBSCRIPTION
// ==========================================

const hasActiveSubscription = async (userId) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      userId
    )
    .query(`
      SELECT TOP 1

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
        s.user_id = @userId
        AND s.status = 'active'
        AND s.end_date > SYSUTCDATETIME()

      ORDER BY s.end_date DESC
    `);

  return result.recordset[0] || null;
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