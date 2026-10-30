const reviewService = require("../services/review.service");
const { publicMessage } = require("../utils/public-error");

const fail = (res, error, fallbackStatus) => {
  const status = error.statusCode || fallbackStatus;
  if (status >= 500 && status !== 503) console.error("Review error:", error.message);
  return res.status(status).json({
    success: false,
    message:
      status >= 500 && !error.statusCode
        ? "Something went wrong. Please try again."
        : publicMessage(error),
  });
};

// Validation errors are plain Errors without a status: treat as 400. Driver
// errors (they carry a code / sqlMessage) are server faults.
const writeFallback = (error) => (error.sqlMessage || error.code ? 500 : 400);

const getReviews = async (req, res) => {
  try {
    const data = await reviewService.getReviews({
      slug: req.params.slug,
      page: req.query?.page,
      limit: req.query?.limit,
    });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, 500);
  }
};

const getReviewEligibility = async (req, res) => {
  try {
    const data = await reviewService.getEligibility({
      slug: req.params.slug,
      userId: req.user.id,
    });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, 500);
  }
};

const createReview = async (req, res) => {
  try {
    const review = await reviewService.createReview({
      slug: req.params.slug,
      userId: req.user.id,
      body: req.body,
      files: req.files || [],
    });
    return res.status(201).json({
      success: true,
      message: "Thank you! Your review has been posted.",
      review,
    });
  } catch (error) {
    return fail(res, error, writeFallback(error));
  }
};

const updateReview = async (req, res) => {
  try {
    const review = await reviewService.updateOwnReview({
      slug: req.params.slug,
      userId: req.user.id,
      body: req.body,
      files: req.files || [],
    });
    return res.status(200).json({ success: true, message: "Your review has been updated.", review });
  } catch (error) {
    return fail(res, error, writeFallback(error));
  }
};

const deleteReview = async (req, res) => {
  try {
    await reviewService.deleteOwnReview({
      slug: req.params.slug,
      userId: req.user.id,
    });
    return res.status(200).json({ success: true, message: "Your review has been deleted." });
  } catch (error) {
    return fail(res, error, writeFallback(error));
  }
};

module.exports = {
  getReviews,
  getReviewEligibility,
  createReview,
  updateReview,
  deleteReview,
};
