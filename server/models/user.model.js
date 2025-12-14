import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema({
  productId: { type: String, required: true },
  quantity: { type: Number, required: true, default: 1 },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  image: { type: String, required: true },
});

const wishlistItemSchema = new mongoose.Schema({
  productId: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  image: { type: String, required: true },
});

const orderDataSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  products: { type: [cartItemSchema], required: true },
  totalAmount: { type: Number, required: true },
  orderDate: { type: Date, default: Date.now },
  status: { type: String, default: "Pending" },
  paymentStatus: { type: String, default: "unpaid" },
  paymentProvider: { type: String },
  paymentIntentId: { type: String },
  stripeSessionId: { type: String },
  // whether product quantities from this order were returned to stock (e.g. when order was cancelled)
  restocked: { type: Boolean, default: false },
  // timestamp when restock occurred (if any)
  restockedAt: { type: Date },
  // optional note with details if some items couldn't be restocked (e.g., deleted products)
  restockNote: { type: String },
});

const addressSchema = new mongoose.Schema({
  street: String,
  city: String,
  state: String,
  postalCode: String,
  country: String,
  phone: String,
});

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      // optional username used for uniqueness in some operations
      userName: { type: String, unique: true, sparse: true },
    password: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
      profileImage: { type: String },
    cartdata: { type: [cartItemSchema], default: [] },
    wishlistdata: { type: [wishlistItemSchema], default: [] },
    orderdata: { type: [orderDataSchema], default: [] },
    addressdata: { type: [addressSchema], default: [] },
  },
  { minimize: false }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;
