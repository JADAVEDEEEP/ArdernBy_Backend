require("dotenv").config();

const app = require("./app");
const { testDatabaseConnection } = require("./config/sql");
const {
  releaseExpiredUnpaidOrders,
  reconcilePendingRefunds,
} = require("./services/order.service");

// Database connection test
testDatabaseConnection();

const PORT = Number(process.env.PORT) || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Unpaid online orders hold stock; give it back when payment is abandoned.
  const sweep = () =>
    releaseExpiredUnpaidOrders().catch((error) =>
      console.error("Unpaid order sweep failed:", error.message)
    );
  setTimeout(sweep, 30 * 1000).unref();
  setInterval(sweep, 10 * 60 * 1000).unref();

  // Refunds Razorpay finished after we recorded them as Refund Pending are
  // marked Refunded once Razorpay confirms (read-only on Razorpay; never creates
  // a refund).
  const reconcile = () =>
    reconcilePendingRefunds().catch((error) =>
      console.error("Refund reconcile failed:", error.message)
    );
  setTimeout(reconcile, 45 * 1000).unref();
  setInterval(reconcile, 15 * 60 * 1000).unref();
});
