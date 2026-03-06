import User from '../models/user.model.js'
import bcrypt from "bcryptjs";
import generateToken from "../config/jwt.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "samarthpd21@gmail.com";
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || ADMIN_EMAIL)
  .split(",")
  .map((s) => String(s || "").trim().toLowerCase())
  .filter(Boolean);

export const signup = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validate request body
    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Validate user email
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: "User already exists" });
    }

    // Password strength
    if (password.length < 6) {
      return res.status(400).json({ error: "Weak password. It must be at least 6 characters long." });
    }
    // Password hashing
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // create a safe userName to satisfy any existing unique index on userName
    const localPart = String(email).split("@")[0]
    const safeUserName = localPart || (String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now())

    // Create user and set isAdmin when email matches configured admin
    const newUser = await User.create({
      name,
      email,
      password: hashedPassword,
      // mark as admin when the signup email is listed in ADMIN_EMAILS
      isAdmin: ADMIN_EMAILS.includes(String(email).toLowerCase()),
      userName: safeUserName,
    });

    const token = await generateToken(newUser._id);

    // cookie options: allow same-site proxy use in dev, require secure in production
    const cookieOptions = {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production", // 'none' requires secure in modern browsers
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/', // ensure cookie is sent for ALL routes
    };
    console.log('[auth] signup: setting cookie for user:', newUser.email, 'options:', JSON.stringify(cookieOptions));
    res.cookie("token", token, cookieOptions);
    // hide password
  const out = newUser.toObject();
  delete out.password;
  // ensure isAdmin is included
  return res.status(201).json({ user: out, token });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error creating user" });
  }
};

export const signin = async (req, res) => {
  try {
    const { email, password } = req.query;

    // Validate request body
    if (!email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Successful login
    const token = await generateToken(user._id);

    // when setting cookie after signup/signin
    const cookieOptions = {
      httpOnly: true,
      // Allow cross-site XHR in prod only if using HTTPS and real domain.
      // In development use 'lax' (or 'none' if you confirm browser accepts it).
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production", // require HTTPS in production
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/', // ensure cookie is sent for ALL routes
    };
    console.log('[auth] signin: setting cookie for user:', user.email, 'options:', JSON.stringify(cookieOptions));

    res.cookie("token", token, cookieOptions);

  const out = user.toObject();
  delete out.password;
  // Also return the token in the response body to help debugging/deployed clients
  // (we still set the httpOnly cookie; returning the token is a convenience for
  //  troubleshooting cross-site cookie issues). Remove this in production if you
  //  prefer stricter httpOnly-only token handling.
  return res.status(200).json({ message: "Login successful", user: out, token });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error signing in" });
  }
};

export const signout = async (req, res) => {
  try {
    // Use the same cookie options as when the cookie was set so the browser
    // will remove it reliably (sameSite/secure/path must match in some cases).
    const cookieOptions = {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      path: '/',
    };

    res.clearCookie("token", cookieOptions);
    return res.status(200).json({ message: "Logout successful" });
  } catch (error) {
    return res.status(500).json({ error: "Error signing out" });
  }
};

/*
  GET /api/auth/me
  - returns current authenticated user (without password)
  - uses req.user if middleware populated it, otherwise verifies token cookie
*/
export const me = async (req, res) => {
  try {
    let userId = req.user?.id || req.user?._id;

    if (!userId) {
      const token = req.cookies?.token || (req.headers.authorization || "").split(" ")[1];
      if (!token) return res.status(401).json({ error: "Unauthenticated" });
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        userId = payload.id || payload._id;
      } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
      }
    }

  const user = await User.findById(userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    return res.status(200).json({ user });
  } catch (err) {
    console.error("me error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

/*
  PATCH /api/auth/me
  - updates allowed fields: name, email, addressdata, and other safe profile fields
  - returns updated user (without password)
*/
export const updateMe = async (req, res) => {
  try {
    let userId = req.user?.id || req.user?._id;

    if (!userId) {
      const token = req.cookies?.token || (req.headers.authorization || "").split(" ")[1];
      if (!token) return res.status(401).json({ error: "Unauthenticated" });
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        userId = payload.id || payload._id;
      } catch (err) {
        console.error("Token verify error:", err);
        return res.status(401).json({ error: "Invalid token" });
      }
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // DEBUG: log incoming body and current user
    console.log("updateMe called for userId:", userId);
    console.log("Incoming body:", JSON.stringify(req.body));
    console.log("Before update user.addressdata:", JSON.stringify(user.addressdata));

    const { name, email, addressdata } = req.body || {};

    // If email changed, ensure uniqueness
    if (email && email !== user.email) {
      const exists = await User.findOne({ email });
      if (exists) return res.status(409).json({ error: "Email already in use" });
      user.email = email;
    }

    if (name) user.name = name;
    if (addressdata && typeof addressdata === "object") {
      // merge existing addressdata with incoming (overwrite provided keys)
      user.addressdata = { ...(user.addressdata || {}), ...addressdata };
    }

    const saved = await user.save();

    // DEBUG: log after save
    console.log("After save user.addressdata:", JSON.stringify(saved.addressdata));

    const out = saved.toObject();
    delete out.password;
    return res.status(200).json({ user: out });
  } catch (err) {
    console.error("updateMe error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};