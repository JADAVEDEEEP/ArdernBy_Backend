const express = require("express");

const { requestReturn, previewReturn, getMyReturn, shipMyReturn } = require("../controller/return.controller");
const { authenticateToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { rateLimit, perUser } = require("../middleware/security.middleware");

const returnRouter = express.Router();

// Customers only. Admins review returns through /api/admin/returns.
returnRouter.use(
  authenticateToken,
  authorizeRoles("customer"),
  rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    keyFn: perUser,
    message: "Too many requests. Please wait a moment and try again.",
  })
);

returnRouter.post("/", requestReturn);
returnRouter.post("/preview", previewReturn);
returnRouter.patch("/:id/shipped", shipMyReturn);
returnRouter.get("/order/:orderId", getMyReturn);

module.exports = returnRouter;
