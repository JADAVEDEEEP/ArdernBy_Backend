const addressService = require("../services/address.service");

// ==========================================
// GET ALL ADDRESSES
// ==========================================

const getAddresses = async (req, res) => {
  try {
    const userId = req.user.id;

    const addresses = await addressService.getAddresses(userId);

    return res.status(200).json({
      success: true,
      count: addresses.length,
      addresses,
    });
  } catch (error) {
    console.error("Get addresses error:", error.message);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// GET ADDRESS BY ID
// ==========================================

const getAddressById = async (req, res) => {
  try {
    const userId = req.user.id;
    const { addressId } = req.params;

    const address = await addressService.getAddressById(
      userId,
      addressId
    );

    return res.status(200).json({
      success: true,
      address,
    });
  } catch (error) {
    console.error("Get address error:", error.message);

    return res.status(404).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// CREATE ADDRESS
// ==========================================

const createAddress = async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      name,
      phone,
      pincode,
      address,
      city,
      state,
      addressType,
      isDefault,
    } = req.body;

    if (
      !name ||
      !phone ||
      !pincode ||
      !address ||
      !city ||
      !state
    ) {
      return res.status(400).json({
        success: false,
        message: "All required address fields are required.",
      });
    }

    const newAddress = await addressService.createAddress(
      userId,
      {
        name,
        phone,
        pincode,
        address,
        city,
        state,
        addressType,
        isDefault,
      }
    );

    return res.status(201).json({
      success: true,
      message: "Address added successfully.",
      address: newAddress,
    });
  } catch (error) {
    console.error("Create address error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// UPDATE ADDRESS
// ==========================================

const updateAddress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { addressId } = req.params;

    const {
      name,
      phone,
      pincode,
      address,
      city,
      state,
      addressType,
      isDefault,
    } = req.body;

    const updatedAddress =
      await addressService.updateAddress(
        userId,
        addressId,
        {
          name,
          phone,
          pincode,
          address,
          city,
          state,
          addressType,
          isDefault,
        }
      );

    return res.status(200).json({
      success: true,
      message: "Address updated successfully.",
      address: updatedAddress,
    });
  } catch (error) {
    console.error("Update address error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// DELETE ADDRESS
// ==========================================

const deleteAddress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { addressId } = req.params;

    const deletedAddress =
      await addressService.deleteAddress(
        userId,
        addressId
      );

    return res.status(200).json({
      success: true,
      message: "Address deleted successfully.",
      address: deletedAddress,
    });
  } catch (error) {
    console.error("Delete address error:", error.message);

    return res.status(404).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// SET DEFAULT ADDRESS
// ==========================================

const setDefaultAddress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { addressId } = req.params;

    const address =
      await addressService.setDefaultAddress(
        userId,
        addressId
      );

    return res.status(200).json({
      success: true,
      message: "Default address updated successfully.",
      address,
    });
  } catch (error) {
    console.error(
      "Set default address error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getAddresses,
  getAddressById,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
};