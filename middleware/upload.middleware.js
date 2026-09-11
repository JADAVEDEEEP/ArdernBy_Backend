const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 6,
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
    ];

    const allowedExtensions = [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".avif",
    ];

    const extension = file.originalname
      .toLowerCase()
      .substring(file.originalname.lastIndexOf("."));

    if (
      allowedTypes.includes(file.mimetype) ||
      allowedExtensions.includes(extension)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG, WEBP and AVIF images are allowed"));
    }
  },
});

module.exports = upload;