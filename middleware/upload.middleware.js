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

    // Both the declared type and the extension must be an allowed image
    // (the client controls both, so the real bytes are checked afterwards).
    if (
      allowedTypes.includes(file.mimetype) &&
      allowedExtensions.includes(extension)
    ) {
      cb(null, true);
    } else {
      const error = new Error("Only JPG, PNG, WEBP and AVIF images are allowed");
      error.type = "upload.invalid";
      cb(error);
    }
  },
});

// Magic-byte check: the file content must really be one of the allowed images.
const hasImageSignature = (buffer) => {
  if (!buffer || buffer.length < 12) return false;

  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png =
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp =
    buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  const avif =
    buffer.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(buffer.toString("ascii", 8, 12));

  return jpeg || png || webp || avif;
};

const verifyImageSignatures = (req, res, next) => {
  const files = req.files || (req.file ? [req.file] : []);

  if (files.some((file) => !hasImageSignature(file.buffer))) {
    return res.status(400).json({
      success: false,
      message: "One of the uploaded files is not a valid image.",
    });
  }

  return next();
};

module.exports = upload;
module.exports.verifyImageSignatures = verifyImageSignatures;