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

const deleteProductImage = async (publicId) => {
  return cloudinary.uploader.destroy(publicId);
};

module.exports = {
  uploadProductImages,
  deleteProductImage,
};