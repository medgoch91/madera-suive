import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://tpjrzgubttpqtxieioxe.supabase.co',
  'sb_publishable_3gAq_lEpojE5_hT4yg4WtQ_oFqaFFfX'
)

// ── hooks ─────────────────────────────────────────────────────────
function usePurchaseEntry() {
  const [suppliers, setSuppliers]           = useState([])
  const [linkedProducts, setLinkedProducts] = useState([])
  const [allProducts, setAllProducts]       = useState([])
  const [showAll, setShowAll]               = useState(false)
  const [supplierId, setSupplierId]         = useState('')
  const [productId, setProductId]           = useState('')
  const [price, setPrice]                   = useState('')
  const [qty, setQty]                       = useState(1)
  const [note, setNote]                     = useState('')
  const [lines, setLines]                   = useState([])
  const [loading, setLoading]               = useState(false)
  const [saving, setSaving]                 = useState(false)
  const [toast, setToast]                   = useState(null)

  const notify = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // Load suppliers once
  useEffect(() => {
    supabase.from('fournisseurs').select('id, nom').order('nom')
      .then(({ data }) => setSuppliers(data || []))
  }, [])

  // Load all products once (for "show all" mode)
  useEffect(() => {
    supabase.from('articles').select('id, nom, unite, cat').order('nom')
      .then(({ data }) => setAllProducts(data || []))
  }, [])

  const handleSupplierChange = useCallback(async (id) => {
    setSupplierId(id)
    setProductId('')
    setPrice('')
    setShowAll(false)

    if (!id) { setLinkedProducts([]); return }

    setLoading(true)
    const { data } = await supabase
      .from('supplier_products')
      .select('product_id, last_purchase_price_ttc, articles(id, nom, unite, cat)')
      .eq('supplier_id', id)

    const linked = (data || []).map(r => ({
      id:         r.articles.id,
      nom:        r.articles.nom,
      unite:      r.articles.unite,
      cat:        r.articles.cat,
      last_price: Number(r.last_purchase_price_ttc),
    }))
    setLinkedProducts(linked)
    setLoading(false)
  }, [])

  const handleToggleShowAll = useCallback((checked) => {
    setShowAll(checked)
    setProductId('')
    setPrice('')
  }, [])

  const handleProductChange = useCallback((id) => {
    setProductId(id)
    const linked = linkedProducts.find(p => String(p.id) === id)
    setPrice(linked ? String(linked.last_price) : '')
  }, [linkedProducts])

  const displayedProducts = showAll ? allProducts : linkedProducts

  const addLine = useCallback(() => {
    if (!productId || !price || Number(qty) <= 0) return
    const product = displayedProducts.find(p => String(p.id) === productId)
    if (!product) return

    setLines(prev => {
      const idx = prev.findIndex(l => l.product_id === productId)
      const line = {
        product_id: productId,
        nom:        product.nom,
        unite:      product.unite || '',
        qty:        Number(qty),
        price_ttc:  Number(price),
      }
      if (idx >= 0) {
        const updated = [...prev]
        updated[idx] = line
        return updated
      }
      return [...prev, line]
    })

    setProductId('')
    setPrice('')
    setQty(1)
  }, [productId, price, qty, displayedProducts])

  const removeLine = useCallback((idx) => {
    setLines(prev => prev.filter((_, i) => i !== idx))
  }, [])

  const total = lines.reduce((s, l) => s + l.qty * l.price_ttc, 0)

  const saveBon = useCallback(async () => {
    if (!supplierId || lines.length === 0) return
    setSaving(true)

    const supplier = suppliers.find(s => String(s.id) === supplierId)
    const today    = new Date().toISOString().split('T')[0]

    // Next bon number
    const { data: lastBon } = await supabase
      .from('bons').select('num').order('num', { ascending: false }).limit(1)
    const num = lastBon?.[0]?.num ? Number(lastBon[0].num) + 1 : 1

    const lignes_json = lines.map(l => ({
      designation: l.nom,
      qte:         l.qty,
      pu:          l.price_ttc,
      total:       Math.round(l.qty * l.price_ttc * 100) / 100,
    }))

    const { error } = await supabase.from('bons').insert({
      num,
      fournisseur: supplier.nom,
      date:        today,
      statut:      'Brouillon',
      remise_type: '%',
      remise_val:  0,
      total:       Math.round(total * 100) / 100,
      total_net:   Math.round(total * 100) / 100,
      lignes:      lignes_json,
      note,
    })

    if (error) {
      notify('Erreur lors de la sauvegarde', 'error')
      setSaving(false)
      return
    }

    // Auto-link: upsert supplier_products for every line
    await Promise.all(lines.map(l =>
      supabase.from('supplier_products').upsert({
        supplier_id:             Number(supplierId),
        product_id:              Number(l.product_id),
        last_purchase_price_ttc: l.price_ttc,
        updated_at:              new Date().toISOString(),
      }, { onConflict: 'supplier_id,product_id' })
    ))

    notify(`BON-${String(num).padStart(4, '0')} sauvegardé — ${total.toFixed(2)} DH TTC`)
    setLines([])
    setNote('')
    setProductId('')
    setPrice('')
    setQty(1)
    setSaving(false)
  }, [supplierId, lines, suppliers, total, note])

  return {
    suppliers, linkedProducts, displayedProducts, showAll,
    supplierId, productId, price, qty, note, lines, loading, saving, toast, total,
    handleSupplierChange, handleToggleShowAll, handleProductChange,
    setPrice, setQty, setNote, addLine, removeLine, saveBon,
  }
}

// ── UI components ─────────────────────────────────────────────────
function Label({ children }) {
  return <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{children}</label>
}

function Select({ value, onChange, disabled, placeholder, children }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className="w-full bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <option value="">{placeholder}</option>
      {children}
    </select>
  )
}

function Input({ value, onChange, type = 'text', placeholder, min }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      min={min}
      className="w-full bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )
}

function Toast({ toast }) {
  if (!toast) return null
  const colors = {
    success: 'bg-green-900 border-green-600 text-green-200',
    error:   'bg-red-900 border-red-600 text-red-200',
  }
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg border text-sm font-medium shadow-xl ${colors[toast.type]}`}>
      {toast.msg}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────
export default function SmartPurchaseEntry() {
  const {
    suppliers, displayedProducts, showAll,
    supplierId, productId, price, qty, note, lines, loading, saving, toast, total,
    handleSupplierChange, handleToggleShowAll, handleProductChange,
    setPrice, setQty, setNote, addLine, removeLine, saveBon,
  } = usePurchaseEntry()

  const selectedSupplier = suppliers.find(s => String(s.id) === supplierId)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <Toast toast={toast} />

      <div className="max-w-4xl mx-auto">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">Bon de Réception</h1>
          <p className="text-gray-400 text-sm mt-1">Saisie intelligente des achats — prix TTC</p>
        </div>

        {/* Card: Supplier + Product Selection */}
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 mb-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-4">Sélection</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {/* Supplier */}
            <div>
              <Label>Fournisseur *</Label>
              <Select
                value={supplierId}
                onChange={handleSupplierChange}
                placeholder="— Choisir un fournisseur —"
              >
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.nom}</option>
                ))}
              </Select>
            </div>

            {/* Product */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>Produit *</Label>
                {supplierId && (
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <div
                      onClick={() => handleToggleShowAll(!showAll)}
                      className={`relative w-8 h-4 rounded-full transition-colors ${showAll ? 'bg-blue-600' : 'bg-gray-700'}`}
                    >
                      <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${showAll ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <span className="text-xs text-gray-400">Tous les produits</span>
                  </label>
                )}
              </div>
              <Select
                value={productId}
                onChange={handleProductChange}
                disabled={!supplierId || loading}
                placeholder={loading ? 'Chargement…' : showAll ? '— Tous les produits —' : `— Produits de ${selectedSupplier?.nom || '…'} —`}
              >
                {displayedProducts.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.nom}{p.unite ? ` (${p.unite})` : ''}
                  </option>
                ))}
              </Select>
              {!showAll && supplierId && displayedProducts.length === 0 && !loading && (
                <p className="text-xs text-amber-400 mt-1">Aucun produit lié — activez "Tous les produits"</p>
              )}
            </div>
          </div>

          {/* Price + Qty + Add */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
            <div>
              <Label>Prix TTC (DH)</Label>
              <Input
                type="number"
                value={price}
                onChange={setPrice}
                placeholder="0.00"
                min="0"
              />
            </div>
            <div>
              <Label>Quantité</Label>
              <Input
                type="number"
                value={qty}
                onChange={setQty}
                placeholder="1"
                min="0.01"
              />
            </div>
            <div className="md:col-span-2">
              {price && qty && productId && (
                <p className="text-xs text-gray-500 mb-1">
                  Sous-total: <span className="text-blue-400 font-semibold">{(Number(price) * Number(qty)).toFixed(2)} DH TTC</span>
                </p>
              )}
              <button
                onClick={addLine}
                disabled={!productId || !price || Number(qty) <= 0}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
              >
                + Ajouter la ligne
              </button>
            </div>
          </div>
        </div>

        {/* Lines Table */}
        {lines.length > 0 && (
          <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden mb-4">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest">
                Lignes du bon ({lines.length})
              </h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase">
                  <th className="text-left px-6 py-3">Désignation</th>
                  <th className="text-right px-4 py-3">Qté</th>
                  <th className="text-right px-4 py-3">P.U. TTC</th>
                  <th className="text-right px-4 py-3">Total TTC</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {lines.map((l, i) => (
                  <tr key={i} className="hover:bg-gray-800/50 transition-colors">
                    <td className="px-6 py-3 font-medium text-white">
                      {l.nom}
                      {l.unite && <span className="text-gray-500 text-xs ml-1">({l.unite})</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-300">{l.qty}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{l.price_ttc.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-blue-400">
                      {(l.qty * l.price_ttc).toFixed(2)} DH
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => removeLine(i)}
                        className="text-gray-600 hover:text-red-400 transition-colors text-lg leading-none"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-800/50">
                  <td colSpan={3} className="px-6 py-4 font-semibold text-gray-400 text-right">
                    Total TTC
                  </td>
                  <td className="px-4 py-4 text-right font-bold text-xl text-white">
                    {total.toFixed(2)} DH
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Note + Save */}
        {lines.length > 0 && (
          <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
            <div className="mb-4">
              <Label>Note (optionnel)</Label>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={2}
                placeholder="Remarques sur la livraison…"
                className="w-full bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>
            <button
              onClick={saveBon}
              disabled={saving}
              className="w-full bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 disabled:opacity-50 text-white font-bold rounded-xl px-6 py-3 text-base transition-all shadow-lg"
            >
              {saving ? 'Sauvegarde…' : `💾 Enregistrer le bon — ${total.toFixed(2)} DH TTC`}
            </button>
            <p className="text-xs text-gray-500 mt-2 text-center">
              Les prix seront automatiquement mis à jour dans les liens fournisseur ↔ produit
            </p>
          </div>
        )}

      </div>
    </div>
  )
}
