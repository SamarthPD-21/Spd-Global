import Stripe from 'stripe'
import User from '../models/user.model.js'
import Product from '../models/product.model.js'

const getStripe = () => {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret) return null
  // Use Stripe's default API version configured on the account to avoid version mismatch errors
  return new Stripe(secret)
}

const sanitizeCartItems = (items = []) => {
  return (Array.isArray(items) ? items : []).map((item) => ({
    productId: String(item.productId || item.id || ''),
    name: item.name || 'Product',
    price: Number(item.price || 0),
    quantity: Number(item.quantity || item.qty || 1),
    image: item.image || '/images/placeholder.png',
  })).filter((it) => it.productId && it.quantity > 0 && it.price >= 0)
}

// Build a compact snapshot for Stripe metadata (limit to < 500 chars)
const buildCompactSnapshot = (cartItems) => {
  // Keep essential fields, drop image to save space and truncate names
  const base = cartItems.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    price: item.price,
    name: (item.name || 'Product').slice(0, 60),
  }))

  // Try progressively smaller slices until JSON string fits comfortably
  for (let len = Math.min(base.length, 15); len >= 1; len -= 1) {
    const slice = base.slice(0, len)
    const json = JSON.stringify(slice)
    if (json.length <= 450) return json
  }

  return '[]'
}

export const createCheckoutSession = async (req, res) => {
  console.log('[payment] createCheckoutSession called, userId:', req.userId)
  const stripe = getStripe()
  if (!stripe) {
    console.error('[payment] STRIPE_SECRET_KEY is not set!')
    return res.status(500).json({ error: 'Stripe secret key missing' })
  }

  try {
    const userId = req.userId
    const user = await User.findById(userId)
    if (!user) {
      console.warn('[payment] User not found for id:', userId)
      return res.status(404).json({ error: 'User not found' })
    }
    console.log('[payment] User found:', user.email, '| raw cartdata length:', (user.cartdata || []).length)

    const cartItems = sanitizeCartItems(user.cartdata)
    console.log('[payment] Sanitized cart items:', cartItems.length, JSON.stringify(cartItems.map(i => ({ id: i.productId, name: i.name, price: i.price, qty: i.quantity }))))
    if (cartItems.length === 0) return res.status(400).json({ error: 'Cart is empty' })

    // Build line items — skip images entirely to avoid Stripe URL validation errors
    // (Stripe rejects relative paths and non-HTTPS URLs)
    const lineItems = cartItems.map((item) => {
      const unitAmount = Math.max(0, Math.round(Number(item.price || 0) * 100))
      if (unitAmount <= 0) {
        console.error('[payment] Item has invalid price:', item.name, 'price:', item.price, 'unitAmount:', unitAmount)
        throw new Error(`Invalid item price for "${item.name}" (price=${item.price})`)
      }

      // Only include image if it's an absolute HTTPS URL (Stripe requires this)
      const imageUrl = item.image && /^https:\/\//i.test(item.image) ? item.image : undefined

      return {
        price_data: {
          currency: 'inr',
          product_data: {
            name: item.name || 'Product',
            images: imageUrl ? [imageUrl] : undefined,
          },
          unit_amount: unitAmount,
        },
        quantity: Math.max(1, Number(item.quantity || 1)),
      }
    })
    console.log('[payment] Line items built:', lineItems.length, '| first unit_amount:', lineItems[0]?.price_data?.unit_amount)

    const totalAmount = cartItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0)
    const orderId = `STR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '')
    const successUrl = `${clientUrl}/cart?stripe=success&session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}`
    const cancelUrl = `${clientUrl}/cart?stripe=cancelled`
    console.log('[payment] successUrl:', successUrl)
    console.log('[payment] cancelUrl:', cancelUrl)

    const sessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: user.email || undefined,
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: String(userId),
        orderId,
        totalAmount: String(totalAmount),
        cartSnapshot: buildCompactSnapshot(cartItems),
      },
    }
    console.log('[payment] Creating Stripe session with params:', JSON.stringify({ ...sessionParams, line_items: `[${lineItems.length} items]` }))

    const session = await stripe.checkout.sessions.create(sessionParams)
    console.log('[payment] Stripe session created successfully:', session.id, '| url:', session.url)

    return res.status(200).json({ sessionId: session.id, url: session.url })
  } catch (err) {
    console.error('[payment] createCheckoutSession FAILED:', err?.type || '', err?.message || err)
    if (err?.raw) console.error('[payment] Stripe raw error:', JSON.stringify(err.raw))
    return res.status(500).json({ error: err?.message || 'Failed to create Stripe session' })
  }
}

export const verifyCheckoutSession = async (req, res) => {
  console.log('[payment] verifyCheckoutSession called, userId:', req.userId)
  const stripe = getStripe()
  if (!stripe) {
    console.error('[payment] STRIPE_SECRET_KEY is not set!')
    return res.status(500).json({ error: 'Stripe secret key missing' })
  }

  const { sessionId } = req.body || {}
  console.log('[payment] verify sessionId:', sessionId)
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (!session) {
      console.warn('[payment] Session not found for id:', sessionId)
      return res.status(404).json({ error: 'Session not found' })
    }
    console.log('[payment] Session retrieved:', {
      id: session.id,
      payment_status: session.payment_status,
      status: session.status,
      metadataUserId: session.metadata?.userId,
      amount_total: session.amount_total,
    })

    const sessionUserId = session.metadata?.userId
    if (!sessionUserId || String(sessionUserId) !== String(req.userId)) {
      console.warn('[payment] userId mismatch: session.metadata.userId=', sessionUserId, 'req.userId=', req.userId)
      return res.status(403).json({ error: 'Session does not belong to this user' })
    }

    if (session.payment_status !== 'paid') {
      console.warn('[payment] Payment not completed. payment_status:', session.payment_status, '| status:', session.status)
      // Return a retryable status so the client can poll
      return res.status(402).json({
        error: 'Payment not completed yet',
        payment_status: session.payment_status,
        retryable: true,
      })
    }

    const user = await User.findById(req.userId)
    if (!user) {
      console.warn('[payment] User not found for verify, id:', req.userId)
      return res.status(404).json({ error: 'User not found' })
    }

    const orderId = session.metadata?.orderId || `STR-${session.id}`
    const existing = (user.orderdata || []).find((o) => o.orderId === orderId || o.stripeSessionId === session.id)
    if (existing) {
      console.log('[payment] Order already exists, returning existing:', orderId)
      return res.status(200).json({ order: existing, user: await User.findById(req.userId).select('-password') })
    }

    let snapshot = []
    try {
      snapshot = sanitizeCartItems(JSON.parse(session.metadata?.cartSnapshot || '[]'))
    } catch (parseErr) {
      console.warn('[payment] Failed to parse cartSnapshot metadata', parseErr)
    }
    const products = snapshot.length > 0 ? snapshot : sanitizeCartItems(user.cartdata)
    console.log('[payment] Products for order:', products.length, '(from', snapshot.length > 0 ? 'snapshot' : 'user cart', ')')
    if (products.length === 0) return res.status(400).json({ error: 'No products to create order' })

    // Reserve stock just like createOrder does
    const updatedProducts = []
    try {
      for (const p of products) {
        const qty = Number(p.quantity || 0)
        if (qty > 5) {
          console.warn('[payment] Quantity cap exceeded for', p.name, 'qty:', qty)
          return res.status(400).json({ error: `Cannot order more than 5 units of ${p.name}` })
        }

        let query = null
        if (p.productId && String(p.productId).match(/^[0-9a-fA-F]{24}$/)) {
          query = { _id: p.productId }
        } else if (p.productId && !Number.isNaN(Number(p.productId))) {
          query = { productId: Number(p.productId) }
        } else {
          query = { _id: p.productId }
        }
        console.log('[payment] Reserving stock for:', p.name, 'qty:', qty, 'query:', JSON.stringify(query))

        const updated = await Product.findOneAndUpdate({ $and: [query, { quantity: { $gte: qty } }] }, { $inc: { quantity: -qty } }, { new: true }).lean()
        if (!updated) {
          console.warn('[payment] Insufficient stock for product:', p.name, 'productId:', p.productId)
          return res.status(400).json({ error: `Insufficient stock for product ${p.name}` })
        }
        // hydrate missing image/name from product doc to satisfy schema requirements
        p.image = p.image || updated.image || '/images/placeholder.png'
        p.name = p.name || updated.name || 'Product'
        p.price = typeof p.price === 'number' ? p.price : Number(updated.price || 0)
        updatedProducts.push({ _id: updated._id, qty })
      }
    } catch (stockErr) {
      try {
        for (const up of updatedProducts) {
          await Product.findByIdAndUpdate(up._id, { $inc: { quantity: up.qty } })
        }
      } catch (rbErr) {
        console.error('[payment] Rollback failed after stock error', rbErr)
      }
      console.error('[payment] Stock reservation failed', stockErr)
      return res.status(500).json({ error: 'Failed to reserve stock' })
    }

    const totalAmount = session.amount_total ? session.amount_total / 100 : products.reduce((s, p) => s + Number(p.price || 0) * Number(p.quantity || 1), 0)

    const orderRecord = {
      orderId,
      products,
      totalAmount,
      orderDate: new Date(),
      status: 'Paid',
      paymentStatus: 'paid',
      paymentProvider: 'stripe',
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
      stripeSessionId: session.id,
      restocked: false,
    }

    user.orderdata = user.orderdata || []
    user.orderdata.push(orderRecord)
    user.cartdata = []
    await user.save()
    console.log('[payment] Order saved successfully:', orderId, '| cart cleared')

    const safeUser = await User.findById(req.userId).select('-password')
    return res.status(201).json({ order: orderRecord, user: safeUser })
  } catch (err) {
    console.error('[payment] verifyCheckoutSession FAILED:', err?.type || '', err?.message || err)
    if (err?.raw) console.error('[payment] Stripe raw error:', JSON.stringify(err.raw))
    return res.status(500).json({ error: err?.message || 'Failed to verify session' })
  }
}
