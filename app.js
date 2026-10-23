const express = require("express");
const cors = require("cors");
require('dotenv').config()
const productRouter = require("./routes/product.routes");
const userRouter = require("./routes/user.routes");
const authRouter = require("./routes/auth.route");
const categoryRouter = require("./routes/category.routes")
const cartRouter = require("./routes/cart.routes");
const couponRouter = require("./routes/coupon.routes");
const addressRoutes = require("./routes/address.routes");
const orderRoutes = require("./routes/order.routes");
const paymentRoutes = require("./routes/payment.routes");
const wishlistRouter = require("./routes/wishlist.routes");
const subscriptionRouter = require("./routes/subscription.routes");
const superAdminRouter = require("./routes/superadmin.routes");
const {
  corsOptions,
  securityHeaders,
  rateLimit,
} = require("./middleware/security.middleware");



const app = express();

app.disable("x-powered-by");
// Render / most hosts sit behind one proxy; needed for correct client IPs.
app.set("trust proxy", 1);

app.use(securityHeaders);
app.use(cors(corsOptions()));
app.use(express.json({ limit: "100kb" }));

// Brute-force protection on login / OTP endpoints, and a general API ceiling.
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: "Too many attempts. Please wait a few minutes and try again.",
  })
);
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 300 }));

// Routes
app.use("/api/products", productRouter);
app.use("/api/auth",authRouter)
app.use("/api/users",userRouter)
app.use("/api/categories",categoryRouter);
app.use("/api/cart", cartRouter);
app.use("/api/coupons", couponRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/subscriptions", subscriptionRouter);
app.use("/api/addresses", addressRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/superadmin", superAdminRouter);

app.get("/",(req,res)=>{
  res.send("Welcome to ArdenBy API")
})

// Unknown API paths answer with JSON, never an HTML stack page.
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "Not found." });
});

// Malformed JSON and other unexpected errors: never leak internals.
app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON body." });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "Request body too large." });
  }
  if (error?.type === "upload.invalid" || error?.name === "MulterError") {
    return res.status(400).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "Each image must be 5 MB or smaller."
          : error.type === "upload.invalid"
          ? error.message
          : "Invalid upload.",
    });
  }

  console.error("Unhandled error:", error);
  return res.status(500).json({ success: false, message: "Something went wrong." });
});

module.exports = app;
