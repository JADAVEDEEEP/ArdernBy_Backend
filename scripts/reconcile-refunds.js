// Reconcile cancelled orders still marked "Refund Pending" with Razorpay.
//   node scripts/reconcile-refunds.js            dry run: report only, writes nothing
//   node scripts/reconcile-refunds.js --apply    mark Refunded where Razorpay confirms
// Only reads from Razorpay and never creates a refund.
require("dotenv").config();

const { reconcilePendingRefunds } = require("../services/order.service");

const apply = process.argv.includes("--apply");

reconcilePendingRefunds({ apply })
  .then((report) => {
    console.log(apply ? "APPLY mode" : "DRY RUN (no writes)");
    console.table(report);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Reconcile failed:", error.message);
    process.exit(1);
  });
