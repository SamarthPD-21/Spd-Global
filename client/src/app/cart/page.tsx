'use client'

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useSearchParams } from 'next/navigation'
import { useSelector, useDispatch } from 'react-redux'
import { RootState } from '@/redux/store'
import { getCurrentUser } from '@/lib/User'
import { setUser, updateCartQuantity, removeFromCart, restoreCartItem } from '@/redux/userSlice'
import { toast as rtToast } from 'react-toastify'
import { notify } from '@/lib/toast'
import { REMOVE_ANIM_MS, UNDO_WINDOW_MS, SLIDE_IN_MS, TOAST_DELAY_MS } from '@/lib/cartTiming'
import { loadStripe } from '@stripe/stripe-js'

// --- Type Definitions ---
interface CartItemMeta {
  productId?: string
  id?: string
  quantity?: number
  qty?: number
  name?: string
  price?: number
  image?: string
}

interface UserState {
  name: string | null
  email: string | null
  cartdata: CartItemMeta[] | null
}

// --- Component ---
type CartPageInnerProps = { searchParams: ReturnType<typeof useSearchParams> }

function CartPageInner({ searchParams }: CartPageInnerProps) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => { setHydrated(true) }, [])

  const user = useSelector((state: RootState) => state.user) as UserState
  const dispatch = useDispatch()

  const refreshUser = async () => {
    try {
      const me = await getCurrentUser()
      const u = me?.user ?? me
      if (u) {
        dispatch(
          setUser({
            name: u.name ?? null,
            email: u.email ?? null,
            cartdata: Array.isArray(u.cartdata) ? u.cartdata : [],
            wishlistdata: u.wishlistdata ?? null,
            orderdata: u.orderdata ?? null,
            addressdata: u.addressdata ?? null,
          })
        )
      }
    } catch (e) {
      console.error(e)
      notify.error('Failed to refresh session')
    }
  }
  // Animation / timing constants (ms) are imported from lib/cartTiming

  // pendingRemovals is already declared below; we use helper functions to manipulate it

  function addPendingRemoval(pid: string, item: CartItemMeta, finalizeTimer: ReturnType<typeof setTimeout>) {
    pendingRemovals.current[pid] = { item, finalizeTimer }
  }

  function cancelPendingRemoval(pid: string): CartItemMeta | undefined {
    const entry = pendingRemovals.current[pid]
    if (!entry) return undefined
    if (entry.finalizeTimer) clearTimeout(entry.finalizeTimer)
    if (entry.localRemovalTimer) clearTimeout(entry.localRemovalTimer)
    delete pendingRemovals.current[pid]
    return entry.item
  }

  // Centralized toast wrapper that accepts JSX content for the undo toast
  function showUndoToast(pid: string, removed: CartItemMeta, onUndo: () => void) {
    const content = (
      <div className="flex items-center gap-3">
        <div className="text-sm">Removed <strong>{removed.name}</strong></div>
        <button className="ml-2 text-xs underline" onClick={onUndo}>Undo</button>
      </div>
    )
    type ToastApi = { info: (content: React.ReactNode, opts?: Record<string, unknown>) => number; update?: (id: number, opts: { render?: string; type?: 'success'|'error'|'info'|'warning'; autoClose?: number }) => void }
    const toastApi = rtToast as unknown as ToastApi
    const id = toastApi.info(content, { autoClose: UNDO_WINDOW_MS })
    return id as number
  }

  // Remove item: show undo toast, then slide out after a short delay; schedule server finalize after undo window
  function removeItem(pid: string) {
    // find the item immediately so we can show toast right away
    const removed = cartItems.find((c) => (c.productId || c.id) === pid)
    if (!removed) return

    // show undo toast immediately with the removed product info
    const toastId = showUndoToast(pid, removed, async () => {
      // cancel pending timers (local removal + server finalize)
      const item = cancelPendingRemoval(pid)
      if (!item) return

      // Attempt to restore on server in an idempotent way: try PATCH (set exact quantity)
      // If PATCH doesn't apply (item missing), fall back to POST (add new).
      let restoredOnServer = false
      try {
        const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '')
        const desiredQty = Number(item.quantity || item.qty || 1)

        // PATCH will set quantity exactly if item exists; avoids doubling when server still has the item.
        let resp = await fetch(`${API}/api/cart`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: String(item.productId || item.id), quantity: desiredQty }),
        })

        if (!resp.ok) {
          // fallback: try POST to add item (server may have deleted it already)
          resp = await fetch(`${API}/api/cart`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: String(item.productId || item.id), name: item.name, price: Number(item.price || 0), image: item.image || '/images/placeholder.png', quantity: desiredQty }),
          })
        }

        restoredOnServer = !!resp && resp.ok
        if (!restoredOnServer) {
          let json: unknown = null
          try { json = await resp.json() } catch {}
          const reason = json && typeof json === 'object' && 'message' in json ? String((json as Record<string, unknown>)['message']) : 'Could not restore item on server'
          notify.error(String(reason))
        }
      } catch (err) {
        console.error('undo: failed to restore on server', err)
        notify.error('Failed to restore item on server — will restore locally')
      }

  // restore locally so UI updates immediately (set exact quantity to avoid double-increment bugs)
  dispatch(restoreCartItem({ id: String(item.productId || item.id), name: item.name || '', price: Number(item.price || 0), quantity: Number(item.quantity || item.qty || 1), image: item.image }))
      setLocalQuantities((s) => ({ ...s, [pid]: Number(item.quantity || item.qty || 1) }))

      // clear removing state so the restored row animates back in correctly
      setRemovingRows((s) => {
        const copy = { ...s }
        delete copy[pid]
        return copy
      })

      // animate slide-in from right
      setRestoringRows((s) => ({ ...s, [pid]: true }))
      setTimeout(() => setRestoringRows((s) => {
        const copy = { ...s }
        delete copy[pid]
        return copy
      }), SLIDE_IN_MS)

      // finally, refresh canonical server state
      refreshUser()

      // update the undo toast to reflect server restore outcome
      try {
        const toastApi = rtToast as unknown as { update?: (id: number, opts: { render?: string; type?: 'success'|'error'|'info'|'warning'; autoClose?: number }) => void }
        const updater = toastApi.update
        if (typeof updater === 'function') {
          if (restoredOnServer) {
            updater(toastId, { render: `${item.name ?? 'Item'} restored`, type: 'success', autoClose: 3000 })
          } else {
            updater(toastId, { render: `${item.name ?? 'Item'} restored locally (server restore failed)`, type: 'error', autoClose: 5000 })
          }
        }
      } catch {
        // ignore update failures
      }
    })

    // schedule server finalize after undo window (start timer immediately)
    const finalizeTimer = setTimeout(async () => {
      try {
        const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '')
        await fetch(`${API}/api/cart/${pid}`, { method: 'DELETE', credentials: 'include' })
      } catch (err) {
        console.error(err)
        notify.error('Failed to remove item on server')
      } finally {
        refreshUser()
      }
    }, UNDO_WINDOW_MS)

    // start slide-out animation after a brief toast-visible delay (from lib/cartTiming), then remove the row after animation
    window.setTimeout(() => {
      setRemovingRows((s) => ({ ...s, [pid]: true }))
    }, TOAST_DELAY_MS)

    const localRemovalTimer = window.setTimeout(() => {
      dispatch(removeFromCart(pid))
      setLocalQuantities((s) => {
        const next = { ...s }
        delete next[pid]
        return next
      })

      // clear removingRows state for cleanliness (row is removed from DOM via redux)
      setRemovingRows((s) => {
        const copy = { ...s }
        delete copy[pid]
        return copy
      })
  }, TOAST_DELAY_MS + REMOVE_ANIM_MS)

    addPendingRemoval(pid, removed, finalizeTimer)
    // attach the local removal timer so undo can cancel it
    pendingRemovals.current[pid].localRemovalTimer = localRemovalTimer as unknown as ReturnType<typeof setTimeout>
  }

  // Normalize cart items
  const cartItems: CartItemMeta[] = useMemo(() => {
    return Array.isArray(user?.cartdata) ? user.cartdata : []
  }, [user])

  const itemCount = cartItems.length
  const totalQuantity = cartItems.reduce((sum, item) => sum + Number(item.quantity || item.qty || 1), 0)

  // Local state for quantities
  const [localQuantities, setLocalQuantities] = useState<Record<string, number>>({})
  const [availableMap, setAvailableMap] = useState<Record<string, number>>({})
  const handledStripeReturn = useRef(false)

  // ✅ Sync localQuantities whenever cartdata changes
  useEffect(() => {
    if (Array.isArray(user?.cartdata)) {
      const synced = user.cartdata.reduce((acc, item) => {
        const pid = item.productId || item.id!
        acc[pid] = Number(item.quantity || item.qty || 1)
        return acc
      }, {} as Record<string, number>)
      setLocalQuantities(synced)
    }
  }, [user?.cartdata])

  // fetch product stock for items (map of pid -> quantity)
  useEffect(() => {
    let mounted = true
    const loadStocks = async () => {
      try {
        const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '')
        const ids = cartItems.map(it => it.productId || it.id!).filter(Boolean)
        if (ids.length === 0) {
          if (mounted) setAvailableMap({})
          return
        }

        const res = await fetch(`${API}/api/products/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok) return
  const json = await res.json()
  const prods: Array<{ _id?: string; productId?: string; quantity?: number }> = json.products || []
        const map: Record<string, number> = {}
        prods.forEach(p => {
          if (!p) return
          const keyById = String(p._id)
          map[keyById] = Number(p.quantity || 0)
          if (typeof p.productId !== 'undefined') map[String(p.productId)] = Number(p.quantity || 0)
        })
        if (mounted) setAvailableMap(map)
        } catch (e) {
        console.error('loadStocks error', e)
        notify.error('Could not load stock information')
      }
    }
    loadStocks()
    return () => { mounted = false }
  }, [cartItems])

  // per-item debounce timers
  const timers = useRef<Record<string, number | null>>({})
  // visual bump timers for quantity change animations
  const bumpTimers = useRef<Record<string, number | null>>({})
  const [bumped, setBumped] = useState<Record<string, boolean>>({})
  // last change direction per item: 1 => increment, -1 => decrement
  const [lastDelta, setLastDelta] = useState<Record<string, number>>({})
  // pending removals waiting for undo (pid -> { item, finalizeTimer, localRemovalTimer })
  const pendingRemovals = useRef<Record<string, { item: CartItemMeta; finalizeTimer: ReturnType<typeof setTimeout> | null; localRemovalTimer?: ReturnType<typeof setTimeout> | null }>>({})
  // rows currently animating out
  const [removingRows, setRemovingRows] = useState<Record<string, boolean>>({})
    // rows that were just restored (slide-in animation)
    const [restoringRows, setRestoringRows] = useState<Record<string, boolean>>({})
  // restoringTimers was unused; removed to silence lint warnings

  // Thanks popup visibility
  const [thanksVisible, setThanksVisible] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [verifyingPayment, setVerifyingPayment] = useState(false)

  const updateQuantity = (pid: string, change: number) => {
    const currentQty = localQuantities[pid] || 1
    const desired = Math.max(currentQty + change, 1)

    // enforce client-side cap if we know available stock
    const available = availableMap[pid]
    const newQty = typeof available === 'number' && available >= 0 ? Math.min(desired, available) : desired

    // optimistic UI update
    setLocalQuantities((prev) => ({ ...prev, [pid]: newQty }))
    dispatch(updateCartQuantity({ id: pid, quantity: newQty }))

    // visual bump animation for the qty number + remember direction for coloring
    setBumped((prev) => ({ ...prev, [pid]: true }))
    setLastDelta((prev) => ({ ...prev, [pid]: Math.sign(change) || 0 }))
    if (bumpTimers.current[pid]) window.clearTimeout(bumpTimers.current[pid]!)
    bumpTimers.current[pid] = window.setTimeout(() => {
      setBumped((prev) => ({ ...prev, [pid]: false }))
      setLastDelta((prev) => ({ ...prev, [pid]: 0 }))
      bumpTimers.current[pid] = null
    }, 420)

    // debounce server patch to coalesce rapid clicks
    if (timers.current[pid]) window.clearTimeout(timers.current[pid]!)
    timers.current[pid] = window.setTimeout(async () => {
        try {
        const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '')
        const res = await fetch(`${API}/api/cart`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: pid, quantity: newQty }),
        })
        if (!res.ok) throw new Error('Failed to update quantity')
        await refreshUser()
      } catch (e) {
        console.error(e)
        notify.error('Failed to update quantity')
      }
    }, 220)
  }

  const startStripeCheckout = async () => {
    if (checkoutLoading) return
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
    if (!publishableKey) {
      console.error('[checkout] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set!')
      notify.error('Stripe publishable key missing')
      return
    }

    setCheckoutLoading(true)
    try {
      const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '')
      console.log('[checkout] Starting checkout, API:', API)
      const res = await fetch(`${API}/api/payments/checkout-session`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      console.log('[checkout] checkout-session response status:', res.status)
      const json = await res.json().catch(() => ({})) as { sessionId?: string; url?: string; error?: string; message?: string; reason?: string }
      console.log('[checkout] checkout-session response body:', JSON.stringify(json))
      if (!res.ok) {
        // If we got a 401, it's an auth issue — tell the user clearly
        if (res.status === 401) {
          console.error('[checkout] Auth failed — cookie may be missing or expired. reason:', json?.reason)
          notify.error('Session expired. Please log in again.')
        } else {
          const msg = json?.error || json?.message || 'Failed to start checkout'
          notify.error(String(msg))
        }
        return
      }

      const stripe = await loadStripe(publishableKey)
      if (stripe && json.sessionId) {
        console.log('[checkout] Redirecting to Stripe checkout, sessionId:', json.sessionId)
        const result = await stripe.redirectToCheckout({ sessionId: json.sessionId })
        if (result.error) {
          console.error('[checkout] Stripe redirect error:', result.error)
          notify.error(result.error.message || 'Stripe redirect failed')
        }
      } else if (json.url) {
        console.log('[checkout] Redirecting to Stripe URL:', json.url)
        window.location.href = json.url
      } else {
        console.error('[checkout] No sessionId or url in response:', json)
        notify.error('Unable to start Stripe checkout')
      }
    } catch (err) {
      console.error('[checkout] stripe checkout error:', err)
      notify.error('Checkout failed')
    } finally {
      setCheckoutLoading(false)
    }
  }

  

  // Calculate total price
  const totalPrice = useMemo(() => {
    return cartItems.reduce((sum, item) => {
      const pid = item.productId || item.id!
      const qty = localQuantities[pid] || Number(item.quantity || item.qty || 1)
      const price = Number(item.price || 0)
      return sum + price * qty
    }, 0)
  }, [cartItems, localQuantities])

  // small animation when total changes (accessibility + visual feedback)
  const [totalBumped, setTotalBumped] = useState(false)
  const [totalDirection, setTotalDirection] = useState<number>(0) // 1 => up, -1 => down
  const prevTotalRef = useRef<number>(totalPrice)
  useEffect(() => {
    // animate briefly when total updates and remember direction
    const prev = prevTotalRef.current ?? 0
    const delta = totalPrice - prev
    const dir = Math.sign(delta) || 0
    setTotalDirection(dir)
    setTotalBumped(true)
    const t = window.setTimeout(() => setTotalBumped(false), 350)
    prevTotalRef.current = totalPrice
    return () => clearTimeout(t)
  }, [totalPrice])

  useEffect(() => {
    if (!searchParams || handledStripeReturn.current) return
    const status = searchParams.get('stripe')
    const sessionId = searchParams.get('session_id')
    const cleanupUrl = () => {
      if (typeof window === 'undefined') return
      const url = new URL(window.location.href)
      url.searchParams.delete('stripe')
      url.searchParams.delete('session_id')
      url.searchParams.delete('order_id')
      window.history.replaceState({}, '', url.pathname + (url.search ? `?${url.searchParams.toString()}` : '') + url.hash)
    }

    if (status === 'cancelled') {
      handledStripeReturn.current = true
      console.log('[checkout] Payment cancelled by user')
      notify.info('Payment was cancelled')
      cleanupUrl()
      return
    }

    if (status === 'success' && sessionId) {
      handledStripeReturn.current = true
      console.log('[checkout] Stripe returned success, sessionId:', sessionId)

      const verifyPayment = async (retries = 3) => {
        setVerifyingPayment(true)
        try {
          const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '')
          console.log('[checkout] Verifying payment, sessionId:', sessionId, '| attempt:', 4 - retries)
          const res = await fetch(`${API}/api/payments/verify-session`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          console.log('[checkout] verify-session response status:', res.status)
          const json = await res.json().catch(() => ({})) as { error?: string; retryable?: boolean; reason?: string; message?: string; payment_status?: string }
          console.log('[checkout] verify-session response body:', JSON.stringify(json))

          if (!res.ok) {
            // If payment status is pending and we have retries left, wait and retry
            if (json?.retryable && retries > 1) {
              console.log('[checkout] Payment not confirmed yet (status:', json.payment_status, '), retrying in 2s... retries left:', retries - 1)
              notify.info('Waiting for payment confirmation...')
              await new Promise(resolve => setTimeout(resolve, 2000))
              return verifyPayment(retries - 1)
            }

            if (res.status === 401) {
              console.error('[checkout] Auth failed during verify — cookie may be missing. reason:', json?.reason)
              notify.error('Session expired. Please log in and check your orders — your payment may have succeeded.')
            } else {
              const msg = json?.error || json?.message || 'Could not verify payment'
              console.error('[checkout] Verify failed:', msg)
              notify.error(String(msg))
            }
            return
          }

          console.log('[checkout] Payment verified successfully!')
          notify.success('Payment successful')
          await refreshUser()
          setThanksVisible(true)
          window.setTimeout(() => setThanksVisible(false), 2400)
        } catch (err) {
          console.error('[checkout] verify payment exception:', err)
          notify.error('Failed to verify payment — check your orders page')
        } finally {
          setVerifyingPayment(false)
          cleanupUrl()
        }
      }
      verifyPayment()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  if (!hydrated) {
    return (
      <div className="bg-veblyssBackground min-h-screen flex items-center justify-center text-veblyssText">
        Loading cart…
      </div>
    )
  }

  if (!user?.email)
    return (
      <div className="bg-veblyssBackground min-h-screen flex items-center justify-center">
        <p className="text-veblyssText">Please login to view your cart</p>
      </div>
    )

  return (
    <div className="bg-veblyssBackground min-h-screen pb-16">
      <section className="py-20 text-center">
        <h1 className="font-playfair text-4xl md:text-6xl text-[#FFECE0] mb-4">
          Your Cart ({itemCount})
        </h1>
        <p className="font-opensans text-veblyssTextLight max-w-2xl mx-auto">
          Items in your cart. Proceed to checkout when ready.
        </p>
      </section>

      <section className="container mx-auto px-4">
        {cartItems.length > 0 && (
          <div className="grid gap-3 md:grid-cols-3 mb-6">
            <div className="md:col-span-2 bg-white/70 backdrop-blur rounded-xl border border-emerald-50 shadow-sm p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-semibold">₹</div>
              <div className="flex-1">
                <p className="font-semibold text-veblyssText">Secure payments with Stripe (INR)</p>
                <p className="text-sm text-gray-600">Cards and wallets supported. We never store your card details.</p>
              </div>
              {(checkoutLoading || verifyingPayment) && (
                <span className="text-sm text-emerald-700 animate-pulse">{verifyingPayment ? 'Verifying payment…' : 'Starting checkout…'}</span>
              )}
            </div>
            <div className="bg-[#0f766e] text-white rounded-xl p-4 shadow-md flex flex-col gap-1">
              <span className="text-sm uppercase tracking-wide opacity-80">Cart snapshot</span>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold">{itemCount}</span>
                <span className="text-sm opacity-90">items</span>
              </div>
              <p className="text-sm opacity-90">{totalQuantity} total pieces · ₹{totalPrice.toFixed(2)}</p>
            </div>
          </div>
        )}
        {cartItems.length === 0 ? (
          <div className="bg-white rounded-xl p-12 text-center shadow-lg">
            <h2 className="font-playfair text-2xl mb-4">Your cart is empty</h2>
            <p className="text-veblyssText mb-6">Browse products and add items to your cart.</p>
            <Link
              href="/products"
              className="inline-block px-6 py-3 rounded-xl font-bold bg-[#368581] text-[#FAF9F6]"
            >
              Browse Products
            </Link>
          </div>
        ) : (
          <>
            <div className="max-h-[600px] overflow-y-auto space-y-4">
              {cartItems.map((item) => {
                const pid = item.productId || item.id!
                const qty = localQuantities[pid] || Number(item.quantity || item.qty || 1)
                const price = Number(item.price || 0)
                const subtotal = price * qty

                return (
                  <div
                    key={pid}
                    className={`bg-white rounded-xl shadow-lg overflow-hidden flex items-center p-2 gap-4 transform transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${removingRows[pid] ? 'animate-slide-out opacity-0 pointer-events-none' : ''} ${restoringRows[pid] ? 'animate-slide-in' : ''}`}
                    aria-label={`${item.name} in cart`}
                  >
                    <div className="w-32 h-32 bg-gray-100 relative flex-shrink-0">
                      {item.image ? (
                        <Image
                          src={item.image}
                          alt={item.name || 'Product'}
                          fill
                          className="object-cover rounded-md"
                        />
                      ) : (
                        <div className="w-full h-full bg-gray-200 flex items-center justify-center text-sm text-gray-500">
                          No Image
                        </div>
                      )}
                    </div>

                    <div className="p-6 flex-1">
                      <h3 className="font-playfair text-xl font-semibold text-veblyssText mb-2">
                        <Link href={`/products/${item.productId || item.id}`} className="hover:underline">
                          {item.name}
                        </Link>
                      </h3>
                      <div className="flex items-center gap-4 mb-2">
                        <span className={`text-2xl font-bold transition-colors duration-200 ${lastDelta[pid] === 1 ? 'text-emerald-600' : lastDelta[pid] === -1 ? 'text-red-500' : ''}`}>₹{price.toFixed(2)}</span>
                        <span className={`text-sm ml-2 transition-transform duration-200 ${lastDelta[pid] === 1 ? 'text-emerald-600 scale-105' : lastDelta[pid] === -1 ? 'text-red-500 scale-105' : 'text-gray-500'}`}>Subtotal: ₹{subtotal.toFixed(2)}</span>
                      </div>

                      {/* Quantity Controls - unified, animated */}
                      <div className="flex items-center gap-3">
                        {/** derive last change direction for this item to color buttons briefly */}
                        {(() => {
                          const delta = lastDelta[pid] ?? 0
                          const minusActive = delta === -1
                          const plusActive = delta === 1
                          const atMin = qty <= 1
                          const atMax = typeof availableMap[pid] === 'number' && qty >= availableMap[pid]
                          return (
                            <>
                              <button
                                onClick={() => updateQuantity(pid, -1)}
                                aria-label={`Decrease quantity for ${item.name}`}
                                disabled={atMin}
                                aria-disabled={atMin}
                                className={`w-10 h-10 flex items-center justify-center rounded-full border transition-transform duration-150 ${minusActive ? 'scale-105' : 'hover:scale-105'} ${atMin ? 'opacity-50 cursor-not-allowed bg-white' : 'bg-white hover:bg-red-50'}`}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 ${minusActive ? 'text-red-600' : 'text-red-500'}`} viewBox="0 0 20 20" fill="currentColor">
                                  <path fillRule="evenodd" d="M4 10a1 1 0 011-1h10a1 1 0 110 2H5a1 1 0 01-1-1z" clipRule="evenodd" />
                                </svg>
                              </button>

                              <div className={`px-4 py-2 border rounded-lg font-mono text-lg transition-transform transition-colors duration-200 ${bumped[pid] ? 'scale-110' : ''} ${lastDelta[pid] === 1 ? 'text-emerald-600' : lastDelta[pid] === -1 ? 'text-red-500' : ''}`}>
                                {qty}
                              </div>

                              <button
                                onClick={() => updateQuantity(pid, 1)}
                                disabled={atMax}
                                aria-disabled={atMax}
                                title={atMax ? 'Reached available stock' : 'Increase quantity'}
                                className={`w-10 h-10 flex items-center justify-center rounded-full border transition-transform duration-150 ${plusActive ? 'scale-105' : 'hover:scale-105'} ${atMax ? 'opacity-50 cursor-not-allowed bg-white' : 'bg-white hover:bg-emerald-50'}`}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 ${plusActive ? 'text-emerald-600' : 'text-emerald-500'}`} viewBox="0 0 20 20" fill="currentColor">
                                  <path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd" />
                                </svg>
                              </button>
                            </>
                          )
                        })()}

                        <button
                          onClick={() => removeItem(pid)}
                          className="ml-auto px-4 py-2 rounded-lg font-semibold text-red-600 hover:bg-red-50 transition-colors duration-150 flex items-center gap-2"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H3a1 1 0 000 2h14a1 1 0 100-2h-2V3a1 1 0 00-1-1H6zm2 7a1 1 0 012 0v6a1 1 0 11-2 0V9zm4 0a1 1 0 112 0v6a1 1 0 11-2 0V9z" clipRule="evenodd" />
                          </svg>
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Total Price & Checkout */}
            <div className="bg-white rounded-xl shadow-lg p-6 text-right flex flex-col md:flex-row justify-between items-center mt-6 sticky bottom-0 z-10">
              <span className={`text-xl md:text-2xl font-bold text-veblyssText transition-transform duration-250 ${totalBumped ? 'scale-105' : ''} ${totalDirection === 1 ? 'text-emerald-600' : totalDirection === -1 ? 'text-red-500' : ''}`}>
                Total: ₹{totalPrice.toFixed(2)}
              </span>
              {/* Announce changes to assistive tech */}
              <div aria-live="polite" className="sr-only">
                Total updated to ₹{totalPrice.toFixed(2)}
              </div>
              <button
                onClick={startStripeCheckout}
                disabled={checkoutLoading || verifyingPayment || totalPrice <= 0}
                className={`mt-4 md:mt-0 px-6 py-3 rounded-xl font-bold bg-[#368581] text-[#FAF9F6] transition-transform hover:scale-105 duration-300 ${checkoutLoading || verifyingPayment || totalPrice <= 0 ? 'opacity-70 pointer-events-none' : ''}`}
              >
                {checkoutLoading || verifyingPayment ? 'Processing...' : 'Pay with Stripe'}
              </button>
            </div>
          </>
        )}
      </section>

      {/* Thanks popup (client-side only) */}
      {typeof window !== 'undefined' && (
        <div aria-hidden={!thanksVisible}>
          <div className={`${thanksVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'} fixed inset-0 flex items-center justify-center z-50 transition-opacity duration-300`}> 
            <div onClick={() => setThanksVisible(false)} className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
            <div className={`relative bg-white rounded-2xl p-6 max-w-sm w-[90%] text-center transform transition-all duration-300 ${thanksVisible ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 translate-y-4'}`}>
              <h3 className="text-2xl font-semibold text-emerald-700 mb-2">Thanks for purchasing</h3>
              <p className="text-sm text-gray-600 mb-4">Your order has been placed. We appreciate your purchase!</p>
              <button onClick={() => setThanksVisible(false)} className="px-4 py-2 rounded bg-emerald-600 text-white">Close</button>
            </div>
          </div>
        </div>
      )}
      <style jsx>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes slideOut {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(-12px); }
        }
  .animate-slide-in { animation: slideIn 280ms ease-out both; }
  .animate-slide-out { animation: slideOut 220ms ease-in both; }
      `}</style>
    </div>
  )
}

// Wrapper that isolates useSearchParams inside Suspense to avoid hook order changes
function CartPageWithSearchParams() {
  const searchParams = useSearchParams()
  return <CartPageInner searchParams={searchParams} />
}

// Wrap in Suspense to satisfy Next.js requirement for useSearchParams
export default function CartPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-veblyssText">Loading cart…</div>}>
      <CartPageWithSearchParams />
    </Suspense>
  )
}
