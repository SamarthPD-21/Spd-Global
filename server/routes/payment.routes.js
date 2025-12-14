import express from 'express'
import isAuth from '../middleware/auth.middleware.js'
import { createCheckoutSession, verifyCheckoutSession } from '../controllers/payment.controller.js'

const router = express.Router()

router.post('/checkout-session', isAuth, createCheckoutSession)
router.post('/verify-session', isAuth, verifyCheckoutSession)

export default router
