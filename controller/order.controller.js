const orderService = require("../services/order.service");


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

    for (const field of requiredFields) {
      if (!shippingAddress[field]) {
        return res.status(400).json({
          success: false,
          message: `${field} is required.`,
        });
      }
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
      message: error.message,
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
      message: error.message,
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
      message: error.message,
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

    return res.status(200).json({
      success: true,
      message: "Order cancelled successfully.",
      order: result,
    });
  } catch (error) {
    console.error("Cancel Order Error:", error);

    return res.status(400).json({
      success: false,
      message: error.message,
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
      message: error.message,
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

    return res.status(400).json({
      success: false,
      message: error.message,
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
};