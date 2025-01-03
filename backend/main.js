require("dotenv").config(); // Load environment variables

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const bodyParser = require("body-parser");
const { body, validationResult } = require("express-validator");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

// Security Middlewares
app.use(helmet()); // Set various HTTP headers for security
app.use(bodyParser.json());

// CORS Configuration
app.use(
  cors({
    origin: "*",
    optionsSuccessStatus: 200,
  })
);

// Logging Middleware
app.use(morgan("combined"));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again after 15 minutes.",
});
app.use(limiter);

// Environment Variables
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret"; // Use a strong secret in production
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/shopDB";

// Connect to MongoDB
mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("Connection error", err));

// Schemas and Models

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  savedPaymentInfo: {
    cardNumber: { type: String, required: true },
    cardHolderName: { type: String, required: true },
    expiryDate: { type: String, required: true }, // Format: MM/YY
    cvv: { type: String, required: true },
  },
  shippingInfo: {
    address: { type: String, required: true },
    state: { type: String, required: true },
    zipcode: { type: String, required: true },
    city: { type: String, required: true },
  },
  isAdmin: { type: Boolean, default: false }, // Admin flag
});
const User = mongoose.model("User", userSchema);

// Product Schema
const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true },
  category: String,
  rating: Number,
  tags: { type: [String], required: true }, // Required
  imageUrl: { type: String, required: true }, // Required
  sizes: {
    type: [String],
    enum: ["XS", "S", "M", "L", "XL", "XXL"],
    required: true,
  }, // Array of clothing sizes with predefined options
  creationDate: { type: Date, default: Date.now }, // Automatically set creation date
});
const Product = mongoose.model("Product", productSchema);
// In your Product Schema definition
// Create a compound text index including name, description, and tags (Optional)
productSchema.index({ name: "text", description: "text", tags: "text" });

// Cart Schema
const cartSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  products: [
    {
      productId: mongoose.Schema.Types.ObjectId,
      quantity: Number,
      size: String,
    },
  ],
});
const Cart = mongoose.model("Cart", cartSchema);

// Entitlement Schema
const entitlementSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  size: {
    type: String,
    enum: ["XS", "S", "M", "L", "XL", "XXL"],
    required: true,
  }, // Added size field
});
const Entitlement = mongoose.model("Entitlement", entitlementSchema);

// Review Schema
const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true },
  rating: { type: Number, required: true },
  comment: { type: String },
  createdAt: { type: Date, default: Date.now }, // Add this field
});
const Review = mongoose.model("Review", reviewSchema);

// Order Schema
const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // Optional for guests
  products: [{ productId: mongoose.Schema.Types.ObjectId, quantity: Number }],
  total: Number,
  shippingInfo: {
    address: String,
    state: String,
    zipcode: String,
    city: String,
  },
  size: {
    type: String,
    enum: ["XS", "S", "M", "L", "XL", "XXL"],
    required: true,
  }, // Array of clothing sizes with predefined options
});

const Order = mongoose.model("Order", orderSchema);

// Middleware for authentication
const authenticateToken = (req, res, next) => {
  if (req.path === "/purchase/guest") return next();
  const authHeader = req.header("Authorization");
  const token =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).send("Access denied. No token provided.");

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).send("Invalid token.");
    req.user = user;
    next();
  });
};

// Middleware for admin authorization
const authorizeAdmin = (req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).send("Access denied. Admins only.");
  }
  next();
};

// Custom Luhn Validation Function
/**
 * Validates a credit card number using the Luhn Algorithm.
 * @param {string} cardNumber - The credit card number as a string.
 * @returns {boolean} - Returns true if valid, false otherwise.
 */
function validateLuhn(cardNumber) {
  // Remove all non-digit characters
  const sanitized = cardNumber.replace(/\D/g, "");

  let sum = 0;
  let shouldDouble = false;

  // Iterate over the card number digits from right to left
  for (let i = sanitized.length - 1; i >= 0; i--) {
    let digit = parseInt(sanitized.charAt(i), 10);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  // If the total modulo 10 is 0, the number is valid
  return sum % 10 === 0;
}

// Routes

// Entitlement System

// Endpoint to simulate product purchase (for authenticated users)
app.post(
  "/purchase/:productId",
  authenticateToken,
  [
    body("size")
      .isIn(["XS", "S", "M", "L", "XL", "XXL"])
      .withMessage("Invalid size. Available sizes: XS, S, M, L, XL, XXL."),
    body("quantity")
      .isInt({ gt: 0 })
      .withMessage("Quantity must be a positive integer."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { productId } = req.params;
    const { size, quantity } = req.body;

    try {
      // Check if product exists
      const product = await Product.findById(productId);
      if (!product) return res.status(404).send("Product not found.");

      const user = await User.findById(req.user.id);
      // Check if the requested size is available for the product
      if (!product.sizes.includes(size)) {
        return res
          .status(400)
          .send(`Size ${size} is not available for this product.`);
      }

      // Calculate total
      const total = product.price * quantity;

      // Create entitlement if user purchases the product
      const entitlement = new Entitlement({
        userId: req.user.id,
        productId,
        size,
      });
      await entitlement.save();

      // Create a new order
      const order = new Order({
        userId: user.id, // Indicates a guest purchase
        products: [{ productId, quantity, size }],
        total,
        shippingInfo: user.shippingInfo,
        size,
      });
      await order.save();

      res.status(200).send({
        message: "Product purchased and entitlement created",
        entitlement,
      });
    } catch (error) {
      console.error("Error purchasing product:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// View Products with Recommendations
app.get("/products", async (req, res) => {
  try {
    // Retrieve all products
    const products = await Product.find({});

    // Initialize an empty array for recommended products
    let recommendedProducts = [];

    // Check if Authorization header is present
    const authHeader = req.header("Authorization");
    let user = null;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        user = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        // Invalid token; proceed as guest
      }
    }

    // If user is authenticated, get their entitlements
    if (user) {
      // Fetch entitlements for the authenticated user
      const entitlements = await Entitlement.find({ userId: user.id }).populate(
        "productId"
      );

      // Collect tags from entitled products
      const entitledTags = new Set();
      entitlements.forEach((entitlement) => {
        if (entitlement.productId && entitlement.productId.tags) {
          entitlement.productId.tags.forEach((tag) => entitledTags.add(tag));
        }
      });

      // If we have tags from entitled products, find recommended products
      if (entitledTags.size > 0) {
        recommendedProducts = await Product.find({
          tags: { $in: Array.from(entitledTags) },
        });
      }
    }

    // If there are recommended products, sort them on top
    let sortedProducts = products;
    if (recommendedProducts.length > 0) {
      // Create a map for quick lookup of recommended product IDs
      const recommendedIds = new Set(
        recommendedProducts.map((prod) => prod._id.toString())
      );

      // Separate recommended and non-recommended products
      const recommended = [];
      const nonRecommended = [];

      products.forEach((product) => {
        if (recommendedIds.has(product._id.toString())) {
          recommended.push(product);
        } else {
          nonRecommended.push(product);
        }
      });

      // Combine recommended and non-recommended products
      sortedProducts = [...recommended, ...nonRecommended];
    }

    // Respond with the sorted products
    return res.status(200).send({
      products: sortedProducts,
    });
  } catch (error) {
    console.error("Error retrieving products:", error);
    res.status(500).send({ error: "Error retrieving products" });
  }
});

// View Specific Product ID information.
app.get("/products/:productId", async (req, res) => {
  const { productId } = req.params;

  try {
    // Find the product by ID
    const product = await Product.findById(productId);

    if (!product) {
      return res.status(404).send("Product not found.");
    }

    // Respond with product information
    res.status(200).send(product);
  } catch (error) {
    console.error("Error retrieving product:", error);
    res.status(500).send("Internal server error.");
  }
});

// Product Management (Admin)

// Create a new product (Admin only)
app.post(
  "/admin/products",
  authenticateToken,
  authorizeAdmin,
  [
    body("name").notEmpty().withMessage("Product name is required."),
    body("price")
      .isFloat({ gt: 0 })
      .withMessage("Price must be a positive number."),
    body("tags")
      .isArray({ min: 1 })
      .withMessage("At least one tag is required."),
    body("tags.*").isString().withMessage("Each tag must be a string."),
    body("description")
      .notEmpty()
      .withMessage("Product must contain a description."),
    body("imageUrl").isURL().withMessage("A valid image URL is required."),
    body("sizes")
      .isArray({ min: 1 })
      .withMessage("At least one size is required.")
      .custom((sizes) => {
        // Ensure each size is a valid option
        const validSizes = ["XS", "S", "M", "L", "XL", "XXL"];
        return sizes.every((size) => validSizes.includes(size));
      })
      .withMessage("Sizes must be one of XS, S, M, L, XL, XXL"),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const productData = {
        ...req.body,
        rating: 0, // Set initial rating to 0
        creationDate: new Date(), // Explicitly set creationDate (optional)
      };
      const product = new Product(productData);
      await product.save();
      res.status(201).send(product);
    } catch (error) {
      console.error("Error creating product:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

app.put(
  "/admin/products/:id",
  authenticateToken,
  authorizeAdmin,
  [
    body("price")
      .optional()
      .isFloat({ gt: 0 })
      .withMessage("Price must be a positive number."),
    body("tags")
      .optional()
      .isArray({ min: 1 })
      .withMessage("At least one tag is required."),
    body("tags.*")
      .optional()
      .isString()
      .withMessage("Each tag must be a string."),
    body("sizes")
      .optional()
      .isArray({ min: 1 })
      .withMessage("At least one size is required."),
    body("sizes.*")
      .optional()
      .isString()
      .withMessage("Each size must be a string."),
    body("imageUrl")
      .optional()
      .isURL()
      .withMessage("A valid image URL is required."),
    body("description")
      .optional()
      .isString()
      .withMessage("A valid product description is required."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
      });
      if (!product) return res.status(404).send("Product not found.");
      res.send(product);
    } catch (error) {
      console.error("Error updating product:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Delete a product (Admin only)
app.delete(
  "/admin/products/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const product = await Product.findByIdAndDelete(req.params.id);
      if (!product) return res.status(404).send("Product not found.");
      res.send({ message: "Product deleted" });
    } catch (error) {
      console.error("Error deleting product:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Cart System

//Get items from cart
app.get("/cart", authenticateToken, async (req, res) => {
  try {
    let cart = await Cart.findOne({ userId: req.user.id }).populate(
      "products.productId"
    );

    if (!cart) {
      return res.status(404).send("Cart not found.");
    }

    res.status(200).json(cart.products);
  } catch (error) {
    console.error("Error fetching cart items:", error);
    res.status(500).send("Internal server error.");
  }
});

// Add product to cart
app.post(
  "/cart",
  authenticateToken,
  [
    body("productId").notEmpty().withMessage("Product ID is required."),
    body("quantity")
      .isInt({ gt: 0 })
      .withMessage("Quantity must be a positive integer."),
    body("size")
      .isIn(["XS", "S", "M", "L", "XL", "XXL"])
      .withMessage("Invalid size. Available sizes: XS, S, M, L, XL, XXL."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { productId, quantity, size } = req.body;
    try {
      // Check if product exists
      const product = await Product.findById(productId);
      if (!product) return res.status(404).send("Product not found.");

      let cart = await Cart.findOne({ userId: req.user.id });

      if (cart) {
        const item = cart.products.find(
          (p) => p.productId.toString() === productId
        );
        if (item) {
          item.quantity += quantity;
        } else {
          cart.products.push({ productId, quantity, size });
        }
      } else {
        cart = new Cart({
          userId: req.user.id,
          products: [{ productId, quantity, size }],
        });
      }
      await cart.save();
      res.status(200).send(cart);
    } catch (error) {
      console.error("Error adding to cart:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Get Cart Total
app.get("/cart/total", authenticateToken, async (req, res) => {
  try {
    // Dynamically populate productId when calculating total
    const cart = await Cart.findOne({ userId: req.user.id }).populate({
      path: "products.productId", // Dynamically populate here
      model: "Product", // Explicitly set the model
      select: "price name", // Select only the fields you need
    });

    if (!cart) return res.status(404).send("Cart not found.");

    const total = cart.products.reduce((sum, item) => {
      if (item.productId && item.productId.price) {
        return sum + item.productId.price * item.quantity;
      }
      return sum;
    }, 0);

    res.send({ total });
  } catch (error) {
    console.error("Error calculating cart total:", error);
    res.status(500).send("Internal server error.");
  }
});

// Update product quantity in cart
app.put(
  "/cart/:productId",
  authenticateToken,
  [
    body("quantity")
      .isInt({ gt: 0 })
      .withMessage("Quantity must be a positive integer."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { productId } = req.params;
    const { quantity } = req.body;
    try {
      const cart = await Cart.findOne({ userId: req.user.id });

      if (cart) {
        const item = cart.products.find(
          (p) => p.productId.toString() === productId
        );
        if (item) {
          item.quantity = quantity;
          await cart.save();
          return res.send(cart);
        }
      }
      res.status(404).send("Product not found in cart.");
    } catch (error) {
      console.error("Error updating cart:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Remove product from cart
app.delete("/cart/:productId", authenticateToken, async (req, res) => {
  const { productId } = req.params;
  try {
    const cart = await Cart.findOne({ userId: req.user.id });

    if (cart) {
      const initialLength = cart.products.length;
      cart.products = cart.products.filter(
        (p) => p.productId.toString() !== productId
      );
      if (cart.products.length === initialLength) {
        return res.status(404).send("Product not found in cart.");
      }
      await cart.save();
      return res.send(cart);
    }
    res.status(404).send("Cart not found.");
  } catch (error) {
    console.error("Error removing from cart:", error);
    res.status(500).send("Internal server error.");
  }
});

// Utility function to escape special RegEx characters in the keyword
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

// Utility function to escape special RegEx characters in the keyword
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

// Updated Product Search by Name using Full-Text Search with Fallback
app.get("/product/search", async (req, res) => {
  const { query } = req.query;

  // Validate that the query is provided and is a string
  if (!query || typeof query !== "string") {
    return res
      .status(400)
      .send({ error: "Query parameter is required and must be a string." });
  }

  try {
    // First, attempt a full-text search
    let products = await Product.find(
      { $text: { $search: query } },
      { score: { $meta: "textScore" } }
    ).sort({ score: { $meta: "textScore" } });

    // If no products found, perform a partial, case-insensitive match using regex
    if (products.length === 0) {
      const regex = new RegExp(escapeRegExp(query), "i"); // 'i' for case-insensitive
      products = await Product.find({ name: regex });
    }

    res.status(200).send(products);
  } catch (error) {
    console.error("Error searching products:", error);
    res.status(500).send({ error: "Internal server error." });
  }
});

// Clear all items in the cart
app.delete("/cart_all/delete", authenticateToken, async (req, res) => {
  try {
    // Find the user's cart
    const cart = await Cart.findOne({ userId: req.user.id });

    if (!cart) {
      return res.status(404).send("Cart not found.");
    }

    // Clear all products from the cart
    cart.products = [];
    await cart.save();

    res.status(200).send("Cart has been cleared.");
  } catch (error) {
    console.error("Error clearing cart:", error);
    res.status(500).send("Internal server error.");
  }
});

// Account System

// Register a new user
app.post(
  "/account/register",
  [
    body("username")
      .isLength({ min: 3 })
      .withMessage("Username must be at least 3 characters long."),
    body("email").isEmail().withMessage("Invalid email address."),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters long."),
    body("savedPaymentInfo.cardNumber")
      .matches(/^\d{13,19}$/)
      .withMessage("Invalid card number format.")
      .custom((value) => validateLuhn(value))
      .withMessage("Invalid credit card number."),
    body("savedPaymentInfo.cardHolderName")
      .notEmpty()
      .withMessage("Card holder name is required."),
    body("savedPaymentInfo.expiryDate")
      .matches(/^(0[1-9]|1[0-2])\/?([0-9]{2})$/)
      .withMessage("Invalid expiry date. Format: MM/YY"),
    body("savedPaymentInfo.cvv")
      .matches(/^\d{3,4}$/)
      .withMessage("Invalid CVV."),
    body("shippingInfo.address").notEmpty().withMessage("Address is required."),
    body("shippingInfo.state").notEmpty().withMessage("State is required."),
    body("shippingInfo.zipcode")
      .matches(/^\d{5}(-\d{4})?$/)
      .withMessage("Invalid zipcode."),
    body("shippingInfo.city").notEmpty().withMessage("City is required."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, email, password, savedPaymentInfo, shippingInfo } =
      req.body;
    try {
      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).send("User with this email already exists.");
      }

      // Hash the password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create new user
      const user = new User({
        username,
        email,
        password: hashedPassword,
        savedPaymentInfo,
        shippingInfo,
      });
      await user.save();
      res.status(201).send({
        message: "User registered successfully.",
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          shippingInfo: user.shippingInfo,
        },
      });
    } catch (error) {
      console.error("Error registering user:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Login
app.post(
  "/account/login",
  [
    body("email").isEmail().withMessage("Invalid email address."),
    body("password").notEmpty().withMessage("Password is required."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    try {
      const user = await User.findOne({ email });
      if (user && (await bcrypt.compare(password, user.password))) {
        const token = jwt.sign(
          { id: user._id, isAdmin: user.isAdmin },
          JWT_SECRET,
          { expiresIn: "1h" }
        );
        res.send({ token });
      } else {
        res.status(400).send("Invalid credentials.");
      }
    } catch (error) {
      console.error("Error during login:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Logout (Client-side should handle token removal)
app.post("/account/logout", authenticateToken, (req, res) => {
  // Since JWTs are stateless, logout can be handled client-side by deleting the token
  res.send("Logged out successfully.");
});

// Endpoint to get the currently authenticated user's data
app.get("/account/me", authenticateToken, async (req, res) => {
  try {
    // Assuming `req.user` is set by the `authenticateToken` middleware
    const user = await User.findById(req.user.id).select("-password"); // Exclude password from the response
    if (!user) return res.status(404).send("User not found.");

    res.status(200).send(user);
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).send("Internal server error.");
  }
});

// Update Account Information
app.put(
  "/account/update",
  authenticateToken,
  [
    body("username")
      .optional()
      .isLength({ min: 3 })
      .withMessage("Username must be at least 3 characters long."),
    body("email").optional().isEmail().withMessage("Invalid email address."),
    body("password")
      .optional()
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters long."),
    body("savedPaymentInfo.cardNumber")
      .optional()
      .matches(/^\d{13,19}$/)
      .withMessage("Invalid card number format.")
      .custom((value) => validateLuhn(value))
      .withMessage("Invalid credit card number."),
    body("savedPaymentInfo.cardHolderName")
      .optional()
      .notEmpty()
      .withMessage("Card holder name is required."),
    body("savedPaymentInfo.expiryDate")
      .optional()
      .matches(/^(0[1-9]|1[0-2])\/?([0-9]{2})$/)
      .withMessage("Invalid expiry date. Format: MM/YY"),
    body("savedPaymentInfo.cvv")
      .optional()
      .matches(/^\d{3,4}$/)
      .withMessage("Invalid CVV."),
    body("shippingInfo.address")
      .optional()
      .notEmpty()
      .withMessage("Address is required."),
    body("shippingInfo.state")
      .optional()
      .notEmpty()
      .withMessage("State is required."),
    body("shippingInfo.zipcode")
      .optional()
      .matches(/^\d{5}(-\d{4})?$/)
      .withMessage("Invalid zipcode."),
    body("shippingInfo.city")
      .optional()
      .notEmpty()
      .withMessage("City is required."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const updates = { ...req.body };
      if (updates.password) {
        updates.password = await bcrypt.hash(updates.password, 10);
      }

      const user = await User.findByIdAndUpdate(req.user.id, updates, {
        new: true,
      });
      if (!user) return res.status(404).send("User not found.");
      res.send({
        message: "Account updated successfully.",
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          shippingInfo: user.shippingInfo,
        },
      });
    } catch (error) {
      console.error("Error updating account:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Save Payment Information
app.post(
  "/account/payment",
  authenticateToken,
  [
    body("savedPaymentInfo.cardNumber")
      .matches(/^\d{13,19}$/)
      .withMessage("Invalid card number format.")
      .custom((value) => validateLuhn(value))
      .withMessage("Invalid credit card number."),
    body("savedPaymentInfo.cardHolderName")
      .notEmpty()
      .withMessage("Card holder name is required."),
    body("savedPaymentInfo.expiryDate")
      .matches(/^(0[1-9]|1[0-2])\/?([0-9]{2})$/)
      .withMessage("Invalid expiry date. Format: MM/YY"),
    body("savedPaymentInfo.cvv")
      .matches(/^\d{3,4}$/)
      .withMessage("Invalid CVV."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { savedPaymentInfo } = req.body;
    try {
      const user = await User.findByIdAndUpdate(
        req.user.id,
        { savedPaymentInfo },
        { new: true }
      );
      if (!user) return res.status(404).send("User not found.");
      res.send({
        message: "Payment information saved successfully.",
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
        },
      });
    } catch (error) {
      console.error("Error saving payment info:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Review System

// Add a review to a product
app.post(
  "/products/:id/review",
  authenticateToken,
  [
    body("rating")
      .isInt({ min: 1, max: 5 })
      .withMessage("Rating must be between 1 and 5."),
    body("comment").optional().isString(),
    body("createdAt").optional().isISO8601().toDate(), // Validate if sent
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { rating, comment, createdAt } = req.body;
    const userId = req.user.id;
    const productId = req.params.id;

    try {
      // Check if the product exists
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).send("Product not found.");
      }

      // Check if the user has purchased the product
      const order = await Order.findOne({
        userId,
        "products.productId": productId,
      });

      const entitlement = await Entitlement.findOne({
        userId,
        productId,
      });

      if (!order && !entitlement) {
        return res
          .status(403)
          .send("You can only review a product that you have purchased.");
      }

      // Check if the user has already reviewed the product
      const existingReview = await Review.findOne({ userId, productId });
      if (existingReview) {
        return res.status(400).send("You have already reviewed this product.");
      }

      // Save the review
      const review = new Review({
        userId,
        productId,
        rating,
        comment,
        createdAt, // Use the provided date if present
      });

      await review.save();
      res.status(201).send(review);
    } catch (error) {
      console.error("Error adding review:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Get all reviews for a product along with the average rating
app.get("/products/:id/reviews", async (req, res) => {
  try {
    const reviews = await Review.find({ productId: req.params.id }).populate(
      "userId",
      "username"
    );

    const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
    const averageRating = reviews.length > 0 ? totalRating / reviews.length : 0;

    res.send({ reviews, averageRating });
  } catch (error) {
    console.error("Error fetching reviews:", error);
    res.status(500).send("Internal server error.");
  }
});

// Admin Routes for Managing Admin Accounts

// Create a new admin account (Admin only)
app.post(
  "/admin/create",
  authenticateToken,
  authorizeAdmin,
  [
    body("username")
      .isLength({ min: 3 })
      .withMessage("Username must be at least 3 characters long."),
    body("email").isEmail().withMessage("Invalid email address."),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters long."),
  ],
  async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { username, email, password } = req.body;

      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).send("User with this email already exists.");
      }

      // Hash the password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create new admin user
      const adminUser = new User({
        username,
        email,
        password: hashedPassword,
        isAdmin: true, // Set admin flag to true
        savedPaymentInfo: {
          cardNumber: "0000000000000000",
          cardHolderName: "Admin",
          expiryDate: "01/30",
          cvv: "000",
        },
        shippingInfo: {
          address: "Admin Address",
          state: "Admin State",
          zipcode: "00000",
          city: "Admin City",
        },
      });

      await adminUser.save();

      res.status(201).send({
        message: "Admin account created successfully.",
        user: {
          id: adminUser._id,
          username: adminUser.username,
          email: adminUser.email,
          isAdmin: adminUser.isAdmin,
        },
      });
    } catch (error) {
      console.error("Error creating admin:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Promote an existing user to admin (Admin only)
app.put(
  "/admin/promote/:userId",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;

      const user = await User.findById(userId);
      if (!user) return res.status(404).send("User not found.");

      if (user.isAdmin) {
        return res.status(400).send("User is already an admin.");
      }

      user.isAdmin = true;
      await user.save();

      res.send({
        message: "User has been promoted to admin.",
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          isAdmin: user.isAdmin,
        },
      });
    } catch (error) {
      console.error("Error promoting user:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Guest Purchase Route (No Authorization Required)
app.post(
  "/purchase/:productId/guest",
  [
    body("quantity")
      .isInt({ gt: 0 })
      .withMessage("Quantity must be a positive integer."),
    body("size")
      .isIn(["XS", "S", "M", "L", "XL", "XXL"])
      .withMessage("Invalid size. Available sizes: XS, S, M, L, XL, XXL."),
    body("shippingInfo.address").notEmpty().withMessage("Address is required."),
    body("shippingInfo.state").notEmpty().withMessage("State is required."),
    body("shippingInfo.zipcode")
      .matches(/^\d{5}(-\d{4})?$/)
      .withMessage("Invalid zipcode."),
    body("shippingInfo.city").notEmpty().withMessage("City is required."),
    body("paymentInfo.cardNumber")
      .matches(/^\d{13,19}$/)
      .withMessage("Invalid card number format.")
      .custom((value) => validateLuhn(value))
      .withMessage("Invalid credit card number."),
    body("paymentInfo.cardHolderName")
      .notEmpty()
      .withMessage("Card holder name is required."),
    body("paymentInfo.expiryDate")
      .matches(/^(0[1-9]|1[0-2])\/?([0-9]{2})$/)
      .withMessage("Invalid expiry date. Format: MM/YY"),
    body("paymentInfo.cvv")
      .matches(/^\d{3,4}$/)
      .withMessage("Invalid CVV."),
  ],
  async (req, res) => {
    // Validate input
    const { productId } = req.params;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { quantity, shippingInfo, paymentInfo, size } = req.body;
    try {
      //First of all, we need to actually use paymentInfo and verify the paymentInfo is valid, just like in the register endpoint.

      // Check if product exists
      const product = await Product.findById(productId);
      if (!product) return res.status(404).send("Product not found.");

      // Calculate total
      const total = product.price * quantity;

      // Here, integrate with a payment gateway to process the payment.
      // Since this is a demonstration, we'll assume the payment is successful.

      // Create a new order
      const order = new Order({
        userId: null, // Indicates a guest purchase
        products: [{ productId, quantity }],
        total,
        shippingInfo,
        size,
      });
      await order.save();

      res.status(201).send({
        message: "Purchase successful.",
        order: {
          id: order._id,
          products: order.products,
          total: order.total,
          shippingInfo: order.shippingInfo,
          size: order.size,
        },
      });
    } catch (error) {
      console.error("Error processing guest purchase:", error);
      res.status(500).send("Internal server error.");
    }
  }
);

// Start the Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
