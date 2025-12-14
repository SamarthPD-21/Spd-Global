import User from "../models/user.model.js";
import cloudinary from "../config/cloudinary.js";

// Helper to upload buffer to cloudinary using upload_stream
const uploadToCloudinary = (buffer, folder = "profiles") =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder }, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    stream.end(buffer);
  });

export const getCurrentUser = async (req, res) => {
  const {userId} = req;
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Ensure cart and wishlist don't reference deleted or out-of-stock products.
    // Collect all product identifiers referenced by the user so we can check them in bulk.
    const referenced = new Set();
    (user.cartdata || []).forEach((c) => { if (c && c.productId) referenced.add(String(c.productId)); });
    (user.wishlistdata || []).forEach((w) => { if (w && w.productId) referenced.add(String(w.productId)); });

    if (referenced.size > 0) {
      // Load Product model dynamically to avoid any possible circular import issues.
      const Product = await import("../models/product.model.js").then(m => m.default).catch(() => null);
      if (Product) {
        const refs = Array.from(referenced);

        // Query for products that match either an ObjectId string or numeric productId
        const orQueries = refs.map(r => {
          if (/^[0-9a-fA-F]{24}$/.test(r)) return { _id: r };
          if (!Number.isNaN(Number(r))) return { productId: Number(r) };
          return { _id: r };
        });

        const products = await Product.find({ $or: orQueries }).lean();
        const foundByKey = new Map();
        for (const p of products) {
          // map by both _id and productId (if present)
          if (p._id) foundByKey.set(String(p._id), p);
          if (typeof p.productId !== 'undefined' && p.productId !== null) foundByKey.set(String(p.productId), p);
        }

        const removedFromCart = [];
        const removedFromWishlist = [];

        // Filter cart: remove items whose product is missing or quantity is 0
        user.cartdata = (user.cartdata || []).filter((item) => {
          const key = String(item.productId);
          const prod = foundByKey.get(key);
          if (!prod) {
            removedFromCart.push({ item, reason: 'deleted' });
            return false; // remove
          }
          if (typeof prod.quantity === 'number' && prod.quantity <= 0) {
            removedFromCart.push({ item, reason: 'out_of_stock' });
            return false;
          }
          return true;
        });

        // Filter wishlist similarly
        user.wishlistdata = (user.wishlistdata || []).filter((item) => {
          const key = String(item.productId);
          const prod = foundByKey.get(key);
          if (!prod) {
            removedFromWishlist.push({ item, reason: 'deleted' });
            return false;
          }
          if (typeof prod.quantity === 'number' && prod.quantity <= 0) {
            removedFromWishlist.push({ item, reason: 'out_of_stock' });
            return false;
          }
          return true;
        });

        // Persist changes if we removed anything
        if (removedFromCart.length > 0 || removedFromWishlist.length > 0) {
          await user.save();
          const safe = await User.findById(userId).select('-password');
          return res.status(200).json({ user: safe, removed: { cart: removedFromCart, wishlist: removedFromWishlist } });
        }
      }
    }

    // Nothing removed — return safe user doc
    const safeUser = await User.findById(userId).select("-password");
    return res.status(200).json(safeUser);
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const uploadProfileImage = async (req, res) => {
  const { userId } = req;
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Log some useful debug info about the incoming file
    console.log("Uploading profile image for user:", userId);
    console.log("file originalname:", req.file.originalname, "mimetype:", req.file.mimetype, "size:", req.file.size);

    const uploadResult = await uploadToCloudinary(req.file.buffer, "profiles");
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.profileImage = uploadResult.secure_url;
    await user.save();
  // Return updated user (exclude password)
  const safeUser = await User.findById(userId).select("-password");
    return res.status(200).json({ message: "Profile image uploaded", image: uploadResult.secure_url, user: safeUser });
  } catch (error) {
    console.error("Upload error:", error);
    // Return the error message to the client for easier debugging in dev
    const message = error?.message || "Failed to upload image";
    return res.status(500).json({ error: message, details: error });
  }
};

export const editCurrentUser = async (req, res) => {
  const { userId } = req;
  const { name, email } = req.body;
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    user.name = name;
    user.email = email;
    await user.save();
    return res.status(200).json(user);
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const addUserAddress = async (req, res) => {
  const { userId } = req;
  const { street, city, state, postalCode, country, phone } = req.body;
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    user.addressdata.push({ street, city, state, postalCode, country, phone });
    await user.save();
    return res.status(200).json(user);
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteUserAddress = async (req, res) => {
  const { userId } = req;
  const { addressId } = req.params;
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    user.addressdata.pull(addressId);
    await user.save();
    return res.status(200).json(user);
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const addWishlistItem = async (req, res) => {
  const { userId } = req;
  const { productId, name, price, image } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId required' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.wishlistdata = user.wishlistdata || [];
    const exists = user.wishlistdata.some(w => String(w.productId) === String(productId));
    if (!exists) {
      user.wishlistdata.push({ productId: String(productId), name: name || '', price: Number(price) || 0, image: image || '' });
      await user.save();
    }
    const safe = await User.findById(userId).select('-password');
    return res.status(200).json({ user: safe });
  } catch (err) {
    console.error('addWishlistItem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

export const removeWishlistItem = async (req, res) => {
  const { userId } = req;
  const { productId } = req.params || {};
  if (!productId) return res.status(400).json({ error: 'productId required' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.wishlistdata = (user.wishlistdata || []).filter(w => String(w.productId) !== String(productId));
    await user.save();
    const safe = await User.findById(userId).select('-password');
    return res.status(200).json({ user: safe });
  } catch (err) {
    console.error('removeWishlistItem error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// Create an order for the current user using either provided products or the user's cart
export const createOrder = async (req, res) => {
  const { userId } = req;
  try {
    const { products: incomingProducts, totalAmount: incomingTotal } = req.body || {};

    const User = await import("../models/user.model.js").then((m) => m.default).catch(() => null);
    if (!User) return res.status(500).json({ error: "User model not available" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Use provided products if present, otherwise fall back to cartdata
    const products = Array.isArray(incomingProducts) && incomingProducts.length > 0 ? incomingProducts : (user.cartdata || []);
    if (!Array.isArray(products) || products.length === 0) return res.status(400).json({ error: "No products to create order" });

    // Determine total amount
    const totalAmount = typeof incomingTotal === 'number' ? incomingTotal : products.reduce((s, p) => s + (Number(p.price || 0) * Number(p.quantity || p.qty || 1)), 0);

    // Generate a simple order id
    const orderId = `ORD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

    // Build order record
    const orderRecord = {
      orderId: String(orderId),
      products: products.map((p) => ({ productId: String(p.productId || p.id || ''), quantity: Number(p.quantity || p.qty || 1), name: p.name || '', price: Number(p.price || 0), image: p.image || '' })),
      totalAmount: Number(totalAmount || 0),
      orderDate: new Date(),
      status: 'Pending',
      // mark whether this order's product quantities have been returned to inventory (used on cancel)
      restocked: false,
    };

    // Hydrate missing product fields (image/name/price) from DB to avoid placeholders in history
    try {
      const ids = orderRecord.products.map(p => p.productId).filter(Boolean)
      if (ids.length > 0) {
        const Product = await import("../models/product.model.js").then((m) => m.default).catch(() => null);
        if (Product) {
          const orQueries = ids.map(id => (/^[0-9a-fA-F]{24}$/.test(id) ? { _id: id } : { productId: Number(id) }));
          const docs = await Product.find({ $or: orQueries }).lean()
          const byKey = new Map()
          docs.forEach(d => {
            if (d?._id) byKey.set(String(d._id), d)
            if (typeof d.productId !== 'undefined') byKey.set(String(d.productId), d)
          })
          orderRecord.products = orderRecord.products.map(p => {
            const ref = byKey.get(String(p.productId))
            return {
              ...p,
              name: p.name || ref?.name || '',
              price: typeof p.price === 'number' ? p.price : Number(ref?.price || 0),
              image: p.image || ref?.image || '/images/placeholder.png',
            }
          })
        }
      }
    } catch (hydrateErr) {
      console.error('order hydrate warning:', hydrateErr)
      orderRecord.products = orderRecord.products.map(p => ({ ...p, image: p.image || '/images/placeholder.png' }))
    }

    // Validate per-product caps and decrement stock atomically
    const Product = await import("../models/product.model.js").then((m) => m.default).catch(() => null);
    if (!Product) return res.status(500).json({ error: "Product model not available" });

    const updatedProducts = [];
    try {
      for (const p of orderRecord.products) {
        const qty = Number(p.quantity || 0);
        // enforce per-order max 5 per product
        if (qty > 5) {
          return res.status(400).json({ error: `Cannot order more than 5 units of a single product in one order (product ${p.name})` });
        }

        // build query to locate product by _id or productId
        const prodIdCandidate = p.productId || '';
        let query = null;
        // attempt ObjectId-like string first
        if (prodIdCandidate && String(prodIdCandidate).match(/^[0-9a-fA-F]{24}$/)) {
          query = { _id: prodIdCandidate };
        } else if (prodIdCandidate && !Number.isNaN(Number(prodIdCandidate))) {
          query = { productId: Number(prodIdCandidate) };
        } else if (p.productId) {
          query = { _id: prodIdCandidate };
        } else {
          return res.status(400).json({ error: `Invalid product reference for ${p.name}` });
        }

        // attempt atomic decrement only if enough stock
        const updated = await Product.findOneAndUpdate(
          { $and: [ query, { quantity: { $gte: qty } } ] },
          { $inc: { quantity: -qty } },
          { new: true }
        ).lean();

        if (!updated) {
          // not enough stock or not found
          return res.status(400).json({ error: `Insufficient stock for product ${p.name}` });
        }

        updatedProducts.push({ _id: updated._id, qty });
      }
    } catch (stockErr) {
      // rollback any successful decrements
      try {
        if (updatedProducts.length > 0) {
          const ProductFallback = Product;
          for (const up of updatedProducts) {
            await ProductFallback.findByIdAndUpdate(up._id, { $inc: { quantity: up.qty } });
          }
        }
      } catch (rbErr) {
        console.error('rollback failed', rbErr);
      }
      console.error('stock update error', stockErr);
      return res.status(500).json({ error: 'Failed to reserve stock' });
    }

    // All stock decremented successfully -> finalize order on user record
    user.orderdata = user.orderdata || [];
    user.orderdata.push(orderRecord);
    user.cartdata = [];
    await user.save();

    const safeUser = await User.findById(userId).select('-password');
    return res.status(201).json({ message: 'Order created', order: orderRecord, user: safeUser });
  } catch (err) {
    console.error('createOrder error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};