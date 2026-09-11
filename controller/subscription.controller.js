const subscriptionService = require("../services/subscription.service");

// ==========================================
// GET ALL PLANS
// ==========================================

const getPlans = async (req, res) => {
  try {
    const plans = await subscriptionService.getPlans();

    return res.status(200).json({
      success: true,
      count: plans.length,
      plans,
    });
  } catch (error) {
    console.error("Get plans error:", error.message);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// GET PLAN BY ID
// ==========================================

const getPlanById = async (req, res) => {
  try {
    const { planId } = req.params;

    const plan = await subscriptionService.getPlanById(planId);

    return res.status(200).json({
      success: true,
      plan,
    });
  } catch (error) {
    console.error("Get plan error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// GET MY SUBSCRIPTION
// ==========================================

const getMySubscription = async (req, res) => {
  try {
    const userId = req.user.id;

    const subscription =
      await subscriptionService.getUserSubscription(userId);

    return res.status(200).json({
      success: true,
      subscription,
    });
  } catch (error) {
    console.error(
      "Get subscription error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// CREATE SUBSCRIPTION
// ==========================================

const createSubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    const { planId, paymentId } = req.body;

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: "Plan ID is required.",
      });
    }

    const result =
      await subscriptionService.createSubscription({
        userId,
        planId,
        paymentId,
      });

    return res.status(201).json({
      success: true,
      message: "Subscription created successfully.",
      ...result,
    });
  } catch (error) {
    console.error(
      "Create subscription error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// ACTIVATE SUBSCRIPTION
// ==========================================

const activateSubscription = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { paymentId } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        message: "Subscription ID is required.",
      });
    }

    const subscription =
      await subscriptionService.activateSubscription(
        subscriptionId,
        paymentId
      );

    return res.status(200).json({
      success: true,
      message: "Subscription activated successfully.",
      subscription,
    });
  } catch (error) {
    console.error(
      "Activate subscription error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// CANCEL SUBSCRIPTION
// ==========================================

const cancelSubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    const { subscriptionId } = req.params;

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        message: "Subscription ID is required.",
      });
    }

    const subscription =
      await subscriptionService.cancelSubscription(
        userId,
        subscriptionId
      );

    return res.status(200).json({
      success: true,
      message: "Subscription cancelled successfully.",
      subscription,
    });
  } catch (error) {
    console.error(
      "Cancel subscription error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// CHECK ACTIVE SUBSCRIPTION
// ==========================================

const checkActiveSubscription = async (req, res) => {
  try {
    const userId = req.user.id;

    const subscription =
      await subscriptionService.hasActiveSubscription(
        userId
      );

    return res.status(200).json({
      success: true,
      isActive: !!subscription,
      subscription,
    });
  } catch (error) {
    console.error(
      "Check subscription error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getPlans,
  getPlanById,
  getMySubscription,
  createSubscription,
  activateSubscription,
  cancelSubscription,
  checkActiveSubscription,
};