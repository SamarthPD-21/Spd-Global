"use client";

import { useSelector } from "react-redux";
import { RootState } from "@/redux/store";
import { useEffect, useMemo, useState } from "react";

type OrderProduct = { productId?: string; id?: string; name?: string; price?: number; quantity?: number; image?: string };
type OrderType = { orderId?: string; orderDate?: string; totalAmount?: number; status?: string; paymentStatus?: string; paymentProvider?: string; products?: OrderProduct[] };

export default function OrdersPage() {
  const user = useSelector((state: RootState) => state.user);
  const orders: OrderType[] = useMemo(() => Array.isArray(user.orderdata) ? (user.orderdata as OrderType[]) : [], [user.orderdata]);
  const [resolvedOrders, setResolvedOrders] = useState<OrderType[]>(orders);

  // Fetch product images for any order items missing image (or with placeholder)
  useEffect(() => {
    const isPlaceholder = (src?: string) => !src || src.includes('/images/placeholder');
    const missingIds = new Set<string>();
    orders.forEach(o => (o.products || []).forEach(p => {
      if ((p.productId || p.id) && isPlaceholder(p.image)) missingIds.add(String(p.productId || p.id));
    }));
    if (missingIds.size === 0) {
      setResolvedOrders(orders);
      return;
    }

    const loadImages = async () => {
      try {
        const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
        const res = await fetch(`${API}/api/products/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: Array.from(missingIds) }),
        });
        if (!res.ok) { setResolvedOrders(orders); return; }
        const json = await res.json();
        const prods: Array<{ _id?: string; productId?: string; image?: string; price?: number; name?: string }> = json.products || [];
        const map = new Map<string, typeof prods[number]>();
        prods.forEach(p => {
          if (p?._id) map.set(String(p._id), p);
          if (typeof p?.productId !== 'undefined') map.set(String(p.productId), p);
        });
        const patched = orders.map(o => ({
          ...o,
          products: (o.products || []).map(p => {
            const ref = map.get(String(p.productId || p.id || ''));
            if (!ref) return p;
            return {
              ...p,
              image: isPlaceholder(p.image) ? ref.image || p.image : p.image,
              name: p.name || ref.name,
              price: typeof p.price === 'number' ? p.price : ref.price,
            };
          })
        }));
        setResolvedOrders(patched);
      } catch (err) {
        console.error('order image hydrate failed', err);
        setResolvedOrders(orders);
      }
    };

    loadImages();
  }, [orders]);

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Past Orders</h2>
      {resolvedOrders.length === 0 ? (
        <p className="text-sm text-gray-600">You haven&apos;t placed any orders yet.</p>
      ) : (
        <div className="space-y-3">
          {resolvedOrders.map((o, idx) => (
            <div key={`${o.orderId}-${idx}`} className="bg-white p-4 rounded-lg shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">Order <span className="font-mono text-sm">{o.orderId}</span></div>
                  <div className="text-xs text-gray-500">{new Date(o.orderDate || Date.now()).toLocaleString()}</div>
                </div>
                <div className="text-right">
                    <div className="font-semibold">₹{Number(o.totalAmount || 0).toFixed(2)}</div>
                    <div className="flex flex-col items-end gap-1 mt-1">
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium
                        ${o.status === 'Pending' ? 'bg-yellow-100 text-yellow-800 animate-pulse' : ''}
                        ${o.status === 'packing' ? 'bg-indigo-100 text-indigo-800 animate-pulse' : ''}
                        ${o.status === 'shipping' ? 'bg-blue-100 text-blue-800 animate-pulse' : ''}
                        ${o.status === 'delivered' ? 'bg-green-100 text-green-800' : ''}
                        ${o.status === 'canceled' ? 'bg-red-100 text-red-800' : ''}
                      `}>{o.status}</span>
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium
                        ${String(o.paymentStatus || '').toLowerCase() === 'paid' ? 'bg-emerald-100 text-emerald-800' : 'bg-orange-100 text-orange-800'}
                      `}>
                        {String(o.paymentStatus || 'unpaid').toLowerCase() === 'paid' ? 'Paid' : 'Unpaid'}
                        {o.paymentProvider ? ` • ${o.paymentProvider}` : ''}
                      </span>
                    </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                {(o.products || []).map((p) => (
                  <div key={p.productId || p.id} className="flex items-center gap-3 bg-gray-50 p-2 rounded">
                    {p.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image} alt={p.name} className="w-12 h-12 object-cover rounded" />
                    ) : (
                      <div className="w-12 h-12 bg-gray-200 rounded" />
                    )}
                    <div className="flex-1">
                      <div className="text-sm font-medium">{p.name}</div>
                      <div className="text-xs text-gray-500">Qty: {p.quantity} • ₹{Number(p.price || 0).toFixed(2)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
