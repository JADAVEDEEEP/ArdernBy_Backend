const orderService = require("../services/order.service");
const { publicMessage } = require("../utils/public-error");
const audit = require("../services/audit.service");
const cancellationController = require("./cancellation.controller");
const cancellationService = require("../services/cancellation.service");


// ==========================================
// CREATE ORDER
// ==========================================

const createOrder = async (req, res) => {
  try {
    const { paymentMethod, shippingAddress } = req.body;

    if (!paymentMethod) {
      return res.status(400).json({
        success: false,
        message: "Payment method is required.",
      });
    }

    if (!["cod", "online"].includes(String(paymentMethod).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "Unsupported payment method.",
      });
    }

    if (
      String(paymentMethod).toLowerCase() === "online" &&
      !require("../services/razorpay.service").isConfigured()
    ) {
      return res.status(503).json({
        success: false,
        message: "Online payment is temporarily unavailable.",
      });
    }

    if (!shippingAddress) {
      return res.status(400).json({
        success: false,
        message: "Shipping address is required.",
      });
    }

    const requiredFields = [
      "name",
      "phone",
      "pincode",
      "address",
      "city",
      "state",
    ];

    if (typeof shippingAddress !== "object" || Array.isArray(shippingAddress)) {
      return res.status(400).json({
        success: false,
        message: "Shipping address is invalid.",
      });
    }

    for (const field of requiredFields) {
      if (!shippingAddress[field]) {
        return res.status(400).json({
          success: false,
          message: `${field} is required.`,
        });
      }

      // Plain, bounded strings only (no objects / arrays smuggled into SQL params).
      if (
        typeof shippingAddress[field] !== "string" ||
        shippingAddress[field].length > (field === "address" ? 500 : 100)
      ) {
        return res.status(400).json({
          success: false,
          message: `${field} is invalid.`,
        });
      }
    }

    if (!/^\d{6}$/.test(shippingAddress.pincode.trim())) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid 6-digit pincode.",
      });
    }

    if (!/^[0-9+()\-\s]{7,20}$/.test(shippingAddress.phone.trim())) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid phone number.",
      });
    }

    const result = await orderService.createOrder({
      userId: req.user.id,
      paymentMethod,
      shippingAddress,
    });

    return res.status(201).json({
      success: true,
      message: "Order created successfully.",
      order: result,
    });
  } catch (error) {
    console.error("Create Order Error:", error);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};


// ==========================================
// GET MY ORDERS
// ==========================================

const getMyOrders = async (req, res) => {
  try {
    const orders = await orderService.getMyOrders(req.user.id);

    return res.status(200).json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (error) {
    console.error("Get My Orders Error:", error);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};


// ==========================================
// GET ORDER BY ID
// ==========================================

const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await orderService.getOrderById(
      req.user.id,
      orderId
    );

    return res.status(200).json({
      success: true,
      order,
    });
  } catch (error) {
    console.error("Get Order Error:", error);

    return res.status(404).json({
      success: false,
      message: publicMessage(error),
    });
  }
};


// ==========================================
// CANCEL ORDER
// ==========================================

// Reason (and optional items) are now part of the request; see cancellation.controller.
const cancelOrder = (req, res) => cancellationController.cancelMine(req, res);


// ==========================================
// GET ALL ORDERS - ADMIN
// ==========================================

const getAllOrders = async (req, res) => {
  try {
    const orders = await orderService.getAllOrders();

    return res.status(200).json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (error) {
    console.error("Get All Orders Error:", error);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};


// ==========================================
// UPDATE ORDER STATUS - ADMIN
// ==========================================

const updateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Order status is required.",
      });
    }

    // Cancelling needs a reason and may be partial: it has its own endpoint logic
    // (cancellation.service). The status box keeps working for it.
    if (status === "Cancelled") {
      return cancellationController.adminCancel(req, res);
    }

    const before = await orderService.getOrderStateSnapshot(orderId);

    const order = await orderService.updateOrderStatus(
      orderId,
      status,
      req.user?.id || null
    );

    // Cancelling a paid online order starts a Razorpay refund, so it is logged
    // as its own action for finance review.
    await audit.record({
      req,
      action: status === "Cancelled" ? "order.cancel" : "order.status_change",
      resourceType: "order",
      resourceId: orderId,
      before,
      after: {
        status: order?.status ?? status,
        paymentStatus: order?.paymentStatus ?? order?.payment_status,
        refundStatus: order?.refundStatus,
        refundAmount: order?.refundAmount,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Order status updated successfully.",
      order,
    });
  } catch (error) {
    console.error("Update Order Status Error:", error);

    return res.status(error.statusCode || 400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};


// ==========================================
// RETRY REFUND FOR A PENDING CANCELLATION - ADMIN
// ==========================================

const retryCancellationRefund = async (req, res) => {
  try {
    // Refunds made by the new cancellation engine are retried by that engine.
    const engine = await cancellationService.retryForOrder({
      orderId: req.params.orderId,
      actor: audit.actorFrom(req),
    });
    if (engine) {
      const processed = engine.every((r) => r.refundStatus === "completed");
      return res.status(200).json({
        success: true,
        message: processed
          ? "Refund processed by Razorpay and recorded."
          : "Refund sent to Razorpay but not confirmed yet; it stays in progress until Razorpay confirms.",
        order: { refunds: engine },
      });
    }

    const before = await orderService.getOrderStateSnapshot(req.params.orderId);

    const result = await orderService.retryCancellationRefund(
      req.params.orderId
    );

    await audit.record({
      req,
      action: "order.refund_retry",
      resourceType: "order",
      resourceId: req.params.orderId,
      before,
      after: {
        status: result?.status,
        paymentStatus: result?.paymentStatus,
        refundStatus: result?.refundStatus,
        refundAmount: result?.refundAmount,
      },
    });

    const message =
      result.refundStatus === "processed"
        ? "Refund processed by Razorpay and recorded."
        : "Refund accepted by Razorpay but not processed yet; it stays Refund Pending until Razorpay confirms.";

    return res.status(200).json({
      success: true,
      message,
      order: result,
    });
  } catch (error) {
    console.error("Retry Cancellation Refund Error:", error);

    return res.status(error.statusCode || 400).json({
      success: false,
      code: error.code || null,
      message: publicMessage(error),
    });
  }
};


module.exports = {
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  getAllOrders,
  updateOrderStatus,
  retryCancellationRefund,
};