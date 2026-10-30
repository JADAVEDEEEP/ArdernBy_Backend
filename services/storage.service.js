const cloudinary = require("../config/cloudinary");

const uploadProductImages = async (files) => {
  const uploadedImages = [];

  for (const file of files) {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "ardenby/products",
          resource_type: "image",
        },
        (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        }
      );

      stream.end(file.buffer);
    });

    uploadedImages.push({
      url: result.secure_url,
      publicId: result.public_id,
      originalName: file.originalname,
    });
  }

  return uploadedImages;
};

const uploadReviewImages = async (files) => {
  const uploaded = [];

  try {
    for (const file of files) {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "ardenby/reviews",
            resource_type: "image",
            // Re-encode and cap the size so a customer upload is never served raw.
            transformation: [
              { width: 1600, height: 1600, crop: "limit", quality: "auto", fetch_format: "auto" },
            ],
          },
          (error, res) => (error ? reject(error) : resolve(res))
        );

        stream.end(file.buffer);
      });

      uploaded.push({ url: result.secure_url, publicId: result.public_id });
    }
  } catch (error) {
    await Promise.all(
      uploaded.map((item) => cloudinary.uploader.destroy(item.publicId).catch(() => {}))
    );
    throw error;
  }

  return uploaded;
};

const deleteProductImage = async (publicId) => {
  return cloudinary.uploader.destroy(publicId);
};

module.exports = {
  uploadProductImages,
  uploadReviewImages,
  deleteProductImage,
};