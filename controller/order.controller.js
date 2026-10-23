const orderService = require("../services/order.service");
const { publicMessage } = require("../utils/public-error");


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

const cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    const result = await orderService.cancelOrder(
      req.user.id,
      orderId
    );

    // The customer only ever sees "Cancelled". Refund bookkeeping (queued /
    // pending / processed) stays internal and is shown to admins only.
    return res.status(200).json({
      success: true,
      message: "Your order has been cancelled.",
      order: { id: result.id, status: "Cancelled" },
    });
  } catch (error) {
    console.error("Cancel Order Error:", error);

    return res.status(error.statusCode || 400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};


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

    const order = await orderService.updateOrderStatus(
      orderId,
      status
    );

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
    const result = await orderService.retryCancellationRefund(
      req.params.orderId
    );

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