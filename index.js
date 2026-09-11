const express = require("express");
const cors = require("cors");
require('dotenv').config()
const productRouter = require("./routes/product.routes");
const userRouter = require("./routes/user.routes");
const authRouter = require("./routes/auth.route");
const categoryRouter = require("./routes/category.routes")
const { testDatabaseConnection } = require("./config/sql");
const cartRouter = require("./routes/cart.routes");
const couponRouter = require("./routes/coupon.routes");
const addressRoutes = require("./routes/address.routes");
const orderRoutes = require("./routes/order.routes");
const wishlistRouter = require("./routes/wishlist.routes");
const subscriptionRouter = require("./routes/subscription.routes");



const app = express();

app.use(cors());
app.use(express.json());

// Database connection test
testDatabaseConnection();

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
const PORT = 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});