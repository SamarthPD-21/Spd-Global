import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

// Middleware: verify token and attach full user document (without password)
const isAuth = async (req, res, next) => {
  // Accept token from cookie (preferred) or Authorization header (Bearer)
  const cookieToken = req.cookies?.token;
  const headerToken = (req.headers?.authorization || "").split(" ")[1];
  const token = cookieToken || headerToken;

  // Diagnostic logging — helps trace cookie / CORS issues
  const route = `${req.method} ${req.originalUrl}`;
  console.log(`[auth] ${route} | cookie: ${cookieToken ? 'present' : 'MISSING'} | header: ${headerToken ? 'present' : 'MISSING'}`);

  if (!token) {
    console.warn(`[auth] REJECT ${route} — no token found (cookie & header both empty)`);
    return res.status(401).json({ message: "Unauthorized", reason: "no_token" });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // support both id and _id in token payload
    const userId = decoded.id || decoded._id;
    console.log(`[auth] ${route} | token valid, userId=${userId}`);
    // attempt to load full user record so downstream handlers can check isAdmin easily
    try {
      const user = await User.findById(userId).select("-password");
      if (user) {
        req.user = user.toObject ? user.toObject() : user;
      } else {
        // fallback to token payload if user not found
        console.warn(`[auth] ${route} | user ${userId} not found in DB, using token payload`);
        req.user = decoded;
      }
    } catch (dbErr) {
      // if DB lookup fails, still attach token payload
      console.error(`[auth] ${route} | DB lookup error:`, dbErr.message);
      req.user = decoded;
    }
    req.userId = userId;
    next();
  } catch (error) {
    console.warn(`[auth] REJECT ${route} — token verification failed: ${error.message}`);
    return res.status(401).json({ message: "Unauthorized", reason: "invalid_token", detail: error.message });
  }
};

export default isAuth;