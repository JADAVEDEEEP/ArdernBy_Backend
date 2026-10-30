-- STAND-IN copies of the existing shop tables, rebuilt from the columns the code uses.
-- ONLY for a throwaway local MySQL used by tests/integration. Real column types may differ.
CREATE TABLE profiles (
  id CHAR(36) PRIMARY KEY, full_name VARCHAR(150), phone VARCHAR(30), email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(100), gender VARCHAR(20), role VARCHAR(20) NOT NULL DEFAULT 'customer',
  auth_provider VARCHAR(20) DEFAULT 'email', google_id VARCHAR(100), email_verified TINYINT DEFAULT 0,
  is_active TINYINT DEFAULT 1, created_at DATETIME(6), updated_at DATETIME(6)
);
CREATE TABLE products (
  id VARCHAR(64) PRIMARY KEY, slug VARCHAR(200) NOT NULL UNIQUE, name VARCHAR(200) NOT NULL,
  category_slug VARCHAR(100), category_label VARCHAR(100), fit VARCHAR(50), fabric VARCHAR(100), coverage VARCHAR(100),
  price DECIMAL(10,2), mrp DECIMAL(10,2), best_price DECIMAL(10,2), rating DECIMAL(3,1) DEFAULT 0, review_count INT DEFAULT 0,
  description TEXT, fabric_details TEXT, wash_care TEXT, tags TEXT, best_seller TINYINT DEFAULT 0, new_arrival TINYINT DEFAULT 0,
  trending TINYINT DEFAULT 0, limited_edition TINYINT DEFAULT 0, inventory INT DEFAULT 0, created_at DATETIME(6), updated_at DATETIME(6)
);
CREATE TABLE product_variants (
  id CHAR(36) PRIMARY KEY, product_id VARCHAR(64) NOT NULL, size VARCHAR(20), color VARCHAR(50), inventory INT NOT NULL DEFAULT 0,
  sku VARCHAR(100), created_at DATETIME(6), updated_at DATETIME(6)
);
CREATE TABLE product_images (
  id CHAR(36) PRIMARY KEY, product_id VARCHAR(64) NOT NULL, image_url VARCHAR(500), sort_order INT, is_primary TINYINT, created_at DATETIME(6)
);
CREATE TABLE product_reviews (
  id VARCHAR(64) PRIMARY KEY, product_id VARCHAR(64) NOT NULL, author_name VARCHAR(150), rating DECIMAL(2,1) NOT NULL,
  review_date DATE DEFAULT (CURRENT_DATE), title VARCHAR(100), comment TEXT, verified TINYINT DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE orders (
  id CHAR(36) PRIMARY KEY, user_id CHAR(36), order_number VARCHAR(40), status VARCHAR(30), payment_method VARCHAR(10),
  payment_status VARCHAR(30), payment_id VARCHAR(100), payment_order_id VARCHAR(100), subtotal DECIMAL(10,2), shipping_amount DECIMAL(10,2),
  discount_amount DECIMAL(10,2), tax_amount DECIMAL(10,2), total_amount DECIMAL(10,2), coupon_code VARCHAR(50),
  shipping_name VARCHAR(150), shipping_phone VARCHAR(30), shipping_pincode VARCHAR(12), shipping_address VARCHAR(300),
  shipping_city VARCHAR(100), shipping_state VARCHAR(100), shiprocket_order_id VARCHAR(64) NULL, shiprocket_shipment_id VARCHAR(64) NULL,
  created_at DATETIME(6), updated_at DATETIME(6)
);
CREATE TABLE order_items (
  id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, product_id VARCHAR(64), variant_id CHAR(36), product_name VARCHAR(200),
  product_image VARCHAR(500), size VARCHAR(20), color VARCHAR(50), quantity INT, unit_price DECIMAL(10,2), unit_mrp DECIMAL(10,2), created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
