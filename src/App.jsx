import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";

const fmt = (n) => `${Number(n).toFixed(2)} €`;
const tableTotal = (orders) => (orders || []).reduce((s, o) => s + o.price * o.qty, 0);

export default function TPV() {
  const [tables, setTables] = useState([]);
  const [zones, setZones] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState("tables");
  const [activeZone, setActiveZone] = useState("__all__");
  const [activeTableId, setActiveTableId] = useState(null);
  const [activeCategory, setActiveCategory] = useState(null);
  const [toast, setToast] = useState(null);
  const [closingId, setClosingId] = useState(null);
  const [connected, setConnected] = useState(false);

  // Admin menú
  const [editingMenu, setEditingMenu] = useState(false);
  const [newItem, setNewItem] = useState({ category: "", name: "", priceSalon: "", priceTerrace: "" });
  const [newCat, setNewCat] = useState("");

  // Admin sala
  const [editingSala, setEditingSala] = useState(false);
  const [newTableLabel, setNewTableLabel] = useState("");
  const [newTableZone, setNewTableZone] = useState("");
  const [newZoneName, setNewZoneName] = useState("");
  const [newZoneIcon, setNewZoneIcon] = useState("🪑");
  const [newZonePriceField, setNewZonePriceField] = useState("price_salon");

  const menuByCategory = groupByCategory(menuItems);

  // ─── CARGA INICIAL ────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    const [{ data: z }, { data: t }, { data: m }] = await Promise.all([
      supabase.from("zones").select("*").order("id"),
      supabase.from("tables").select("*").order("id"),
      supabase.from("menu_items").select("*").order("id"),
    ]);
    if (z) setZones(z);
    if (t) setTables(t);
    if (m) setMenuItems(m);
    if (z && z.length && !activeCategory) {
      // noop
    }
    setLoading(false);
    setConnected(true);
  }, [activeCategory]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ─── REALTIME SUBSCRIPTIONS ───────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel("artex-tpv-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "tables" }, (payload) => {
        setTables((prev) => applyChange(prev, payload));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "zones" }, (payload) => {
        setZones((prev) => applyChange(prev, payload));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "menu_items" }, (payload) => {
        setMenuItems((prev) => applyChange(prev, payload));
      })
      .subscribe((status) => {
        setConnected(status === "SUBSCRIBED");
      });

    return () => { supabase.removeChannel(channel); };
  }, []);

  function applyChange(list, payload) {
    if (payload.eventType === "INSERT") {
      if (list.some(x => x.id === payload.new.id)) return list;
      return [...list, payload.new];
    }
    if (payload.eventType === "UPDATE") {
      return list.map(x => x.id === payload.new.id ? payload.new : x);
    }
    if (payload.eventType === "DELETE") {
      return list.filter(x => x.id !== payload.old.id);
    }
    return list;
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 1800); };
  const getTable = (id) => tables.find(t => t.id === id);
  const activeTable = activeTableId ? getTable(activeTableId) : null;

  function groupByCategory(items) {
    const out = {};
    for (const it of items) {
      if (!out[it.category]) out[it.category] = [];
      out[it.category].push(it);
    }
    return out;
  }

  const getPriceForZone = (item, zoneId) => {
    const zone = zones.find(z => z.id === zoneId);
    const field = zone?.price_field || "price_salon";
    return Number(item[field === "price_terrace" ? "price_terrace" : "price_salon"]) || 0;
  };

  // ─── COMANDAS (escriben directamente en Supabase) ─────────────────────────
  const addItem = useCallback(async (menuItem) => {
    const tbl = getTable(activeTableId);
    if (!tbl) return;
    const price = getPriceForZone(menuItem, tbl.zone_id);
    const existing = (tbl.orders || []).find(o => o.id === menuItem.id);
    const orders = existing
      ? tbl.orders.map(o => o.id === menuItem.id ? { ...o, qty: o.qty + 1 } : o)
      : [...(tbl.orders || []), { id: menuItem.id, name: menuItem.name, price, qty: 1 }];

    // Actualización optimista local
    setTables(prev => prev.map(t => t.id === tbl.id ? { ...t, orders } : t));
    showToast(`+1 ${menuItem.name}`);

    const { error } = await supabase.from("tables").update({ orders }).eq("id", tbl.id);
    if (error) showToast("⚠ Error al guardar");
  }, [activeTableId, tables, zones]);

  const removeItem = useCallback(async (itemId) => {
    const tbl = getTable(activeTableId);
    if (!tbl) return;
    const orders = (tbl.orders || [])
      .map(o => o.id === itemId ? { ...o, qty: o.qty - 1 } : o)
      .filter(o => o.qty > 0);

    setTables(prev => prev.map(t => t.id === tbl.id ? { ...t, orders } : t));
    const { error } = await supabase.from("tables").update({ orders }).eq("id", tbl.id);
    if (error) showToast("⚠ Error al guardar");
  }, [activeTableId, tables]);

  const clearTable = useCallback(async (tid) => {
    setTables(prev => prev.map(t => t.id === tid ? { ...t, orders: [] } : t));
    const t = getTable(tid);
    const { error } = await supabase.from("tables").update({ orders: [] }).eq("id", tid);
    if (!error) showToast(`${t?.label || "Mesa"} cerrada ✓`);
    setView("tables");
    setActiveTableId(null);
  }, [tables]);

  // ─── ADMIN MENÚ ────────────────────────────────────────────────────────────
  const addMenuItem = async () => {
    if (!newItem.category || !newItem.name) return;
    const id = "x" + Date.now();
    const row = {
      id, category: newItem.category, name: newItem.name,
      price_salon: parseFloat(newItem.priceSalon) || 0,
      price_terrace: parseFloat(newItem.priceTerrace) || 0,
    };
    setMenuItems(prev => [...prev, row]);
    setNewItem({ category: newItem.category, name: "", priceSalon: "", priceTerrace: "" });
    const { error } = await supabase.from("menu_items").insert(row);
    if (!error) showToast("Producto añadido");
  };

  const deleteMenuItem = async (id) => {
    setMenuItems(prev => prev.filter(i => i.id !== id));
    await supabase.from("menu_items").delete().eq("id", id);
  };

  const updateMenuItemPrice = async (id, field, value) => {
    const val = parseFloat(value) || 0;
    setMenuItems(prev => prev.map(i => i.id === id ? { ...i, [field]: val } : i));
    await supabase.from("menu_items").update({ [field]: val }).eq("id", id);
  };

  const addCategory = () => {
    if (!newCat.trim()) return;
    // Una categoría existe implícitamente al tener un producto; guardamos
    // un placeholder local hasta que se añada el primer producto.
    setNewItem(p => ({ ...p, category: newCat.trim() }));
    setNewCat("");
  };

  // ─── ADMIN SALA ────────────────────────────────────────────────────────────
  const addTable = async () => {
    if (!newTableLabel.trim() || !newTableZone) return;
    const id = "m" + Date.now();
    const row = { id, label: newTableLabel.trim(), zone_id: newTableZone, orders: [] };
    setTables(prev => [...prev, row]);
    setNewTableLabel("");
    const { error } = await supabase.from("tables").insert(row);
    if (!error) showToast("Mesa añadida");
  };

  const deleteTable = async (id) => {
    setTables(prev => prev.filter(t => t.id !== id));
    await supabase.from("tables").delete().eq("id", id);
  };

  const updateTableLabel = async (id, label) => {
    setTables(prev => prev.map(t => t.id === id ? { ...t, label } : t));
    await supabase.from("tables").update({ label }).eq("id", id);
  };

  const updateTableZone = async (id, zone_id) => {
    setTables(prev => prev.map(t => t.id === id ? { ...t, zone_id } : t));
    await supabase.from("tables").update({ zone_id }).eq("id", id);
  };

  const addZone = async () => {
    if (!newZoneName.trim()) return;
    const id = "z" + Date.now();
    const row = { id, name: newZoneName.trim(), icon: newZoneIcon, price_field: newZonePriceField };
    setZones(prev => [...prev, row]);
    setNewZoneName(""); setNewZoneIcon("🪑"); setNewZonePriceField("price_salon");
    const { error } = await supabase.from("zones").insert(row);
    if (!error) showToast("Zona añadida");
  };

  const deleteZone = async (id) => {
    setZones(prev => prev.filter(z => z.id !== id));
    await supabase.from("zones").delete().eq("id", id);
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ ...S.root, alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: C.accentLight, fontSize: 16 }}>Cargando El Artex…</div>
      </div>
    );
  }

  const zonesWithTables = zones.map(z => ({ ...z, tables: tables.filter(t => t.zone_id === z.id) }));
  const categories = Object.keys(menuByCategory);
  const currentCategory = activeCategory || categories[0];

  return (
    <div style={S.root}>
      {toast && <div style={S.toast}>{toast}</div>}

      <header style={S.header}>
        {view !== "tables" && (
          <button style={S.backBtn} onClick={() => { setView("tables"); setActiveTableId(null); setClosingId(null); }}>←</button>
        )}
        <span style={S.headerTitle}>
          {view === "tables" && "🍷 El Artex"}
          {view === "mesa" && (() => { const t = activeTable; const z = zones.find(z => z.id === t?.zone_id); return `${t?.label || "Mesa"} · ${z?.icon || ""} ${z?.name || ""}`; })()}
          {view === "closing" && `Cobro — ${getTable(closingId)?.label}`}
          {view === "adminMenu" && "⚙ Carta y precios"}
          {view === "adminSala" && "🗺 Mesas y zonas"}
        </span>
        <div style={S.headerRight}>
          <span style={S.syncDot(connected)} title={connected ? "Conectado en vivo" : "Reconectando…"} />
          {view === "tables" && <>
            <button style={S.iconBtn} title="Gestionar sala" onClick={() => setView("adminSala")}>🗺</button>
            <button style={S.iconBtn} title="Carta" onClick={() => setView("adminMenu")}>⚙</button>
          </>}
          {view === "mesa" && activeTable && (
            <span style={S.headerTotal}>{fmt(tableTotal(activeTable.orders))}</span>
          )}
        </div>
      </header>

      {/* ── VISTA: MESAS ── */}
      {view === "tables" && (
        <div style={S.container}>
          <div style={S.zoneTabs}>
            <button style={S.zoneTab(activeZone === "__all__")} onClick={() => setActiveZone("__all__")}>Todas</button>
            {zones.map(z => (
              <button key={z.id} style={S.zoneTab(activeZone === z.id)} onClick={() => setActiveZone(z.id)}>{z.icon} {z.name}</button>
            ))}
          </div>

          {zonesWithTables.filter(z => activeZone === "__all__" || activeZone === z.id).map(z => (
            <div key={z.id} style={S.zoneBlock}>
              <div style={S.zoneHeader}>
                <span style={S.zoneIcon}>{z.icon}</span>
                <span style={S.zoneName}>{z.name}</span>
                <span style={S.zoneStat}>
                  {z.tables.filter(t => (t.orders || []).length > 0).length}/{z.tables.length} ocupadas · {fmt(z.tables.reduce((s, t) => s + tableTotal(t.orders), 0))}
                </span>
              </div>
              <div style={S.tablesGrid}>
                {z.tables.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>Sin mesas — añade desde 🗺</div>}
                {z.tables.map(t => {
                  const occupied = (t.orders || []).length > 0;
                  return (
                    <button key={t.id} style={S.tableCard(occupied)} onClick={() => {
                      setActiveTableId(t.id);
                      setActiveCategory(categories[0]);
                      setView("mesa");
                    }}>
                      <span style={S.tableNum}>{t.label}</span>
                      {occupied ? (
                        <><span style={S.tableProd}>{t.orders.reduce((s, o) => s + o.qty, 0)} prod.</span>
                        <span style={S.tablePrice}>{fmt(tableTotal(t.orders))}</span></>
                      ) : <span style={S.tableEmpty}>Libre</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div style={S.summaryBar}>
            <span>Ocupadas: <b>{tables.filter(t => (t.orders || []).length > 0).length}/{tables.length}</b></span>
            <span>Total sala: <b>{fmt(tables.reduce((s, t) => s + tableTotal(t.orders), 0))}</b></span>
          </div>
        </div>
      )}

      {/* ── VISTA: MESA ── */}
      {view === "mesa" && activeTable && (() => {
        const tableZone = zones.find(z => z.id === activeTable.zone_id);
        const priceField = tableZone?.price_field || "price_salon";
        return (
          <div style={S.container}>
            <div style={S.mesaLayout}>
              <div style={S.comandaPanel}>
                <div style={S.panelTitle}>Comanda</div>
                {(activeTable.orders || []).length === 0 && <div style={S.emptyComanda}>Sin productos aún</div>}
                {(activeTable.orders || []).map(item => (
                  <div key={item.id} style={S.comandaRow}>
                    <button style={S.qtyBtn} onClick={() => removeItem(item.id)}>−</button>
                    <span style={S.cmdQty}>{item.qty}</span>
                    <span style={S.cmdName}>{item.name}</span>
                    <span style={S.cmdPrice}>{fmt(item.price * item.qty)}</span>
                    <button style={S.qtyBtn} onClick={() => {
                      const mi = menuItems.find(m => m.id === item.id);
                      if (mi) addItem(mi);
                    }}>+</button>
                  </div>
                ))}
                <div style={S.totalRow}>
                  <span>TOTAL</span>
                  <span style={S.totalAmt}>{fmt(tableTotal(activeTable.orders))}</span>
                </div>
                {(activeTable.orders || []).length > 0 && (
                  <button style={S.cobrarBtn} onClick={() => { setClosingId(activeTableId); setView("closing"); }}>💳 Cobrar</button>
                )}
              </div>

              <div style={S.catalogPanel}>
                <div style={S.priceBanner}>
                  <span>{tableZone?.icon} {tableZone?.name}</span>
                  <span style={S.priceTag}>Tarifa {priceField === "price_terrace" ? "terraza ☀️" : "salón 🪑"}</span>
                </div>
                <div style={S.catTabs}>
                  {categories.map(cat => (
                    <button key={cat} style={S.catTab(cat === currentCategory)} onClick={() => setActiveCategory(cat)}>{cat}</button>
                  ))}
                </div>
                <div style={S.productsGrid}>
                  {(menuByCategory[currentCategory] || []).map(item => {
                    const inOrder = (activeTable.orders || []).find(o => o.id === item.id);
                    const price = Number(item[priceField]) || 0;
                    return (
                      <button key={item.id} style={S.productBtn(!!inOrder)} onClick={() => addItem(item)}>
                        <span style={S.productName}>{item.name}</span>
                        <span style={S.productPrice}>{price === 0 ? "Gratis" : fmt(price)}</span>
                        {inOrder && <span style={S.badge}>{inOrder.qty}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── VISTA: CIERRE ── */}
      {view === "closing" && closingId && (() => {
        const t = getTable(closingId);
        if (!t) return null;
        return (
          <div style={S.container}>
            <div style={S.closingCard}>
              <div style={S.closingTitle}>Mesa {t.label}</div>
              {(t.orders || []).map(item => (
                <div key={item.id} style={S.closingRow}>
                  <span style={S.closingQty}>{item.qty}×</span>
                  <span style={S.closingName}>{item.name}</span>
                  <span style={S.closingPrice}>{fmt(item.price * item.qty)}</span>
                </div>
              ))}
              <div style={S.closingTotal}>
                <span>TOTAL A COBRAR</span>
                <span style={S.closingTotalAmt}>{fmt(tableTotal(t.orders))}</span>
              </div>
              <button style={S.confirmarBtn} onClick={() => clearTable(closingId)}>✅ Cobrado — Liberar mesa</button>
              <button style={S.volverBtn} onClick={() => { setView("mesa"); setActiveTableId(closingId); }}>← Volver a la mesa</button>
            </div>
          </div>
        );
      })()}

      {/* ── VISTA: ADMIN MENÚ ── */}
      {view === "adminMenu" && (
        <div style={S.container}>
          <div style={S.adminCard}>
            <div style={S.adminSection}>
              <b style={{ color: C.accentLight }}>Nueva categoría</b>
              <div style={S.adminRow}>
                <input style={S.input} placeholder="Nombre" value={newCat} onChange={e => setNewCat(e.target.value)} />
                <button style={S.addBtn} onClick={addCategory}>+ Crear</button>
              </div>
              <span style={{ fontSize: 11, color: C.muted }}>
                * La categoría se crea al añadir su primer producto, abajo.
              </span>
            </div>

            <div style={S.adminSection}>
              <b style={{ color: C.accentLight }}>Añadir producto</b>
              <div style={S.adminRow}>
                <select style={S.select} value={newItem.category} onChange={e => setNewItem(p => ({ ...p, category: e.target.value }))}>
                  <option value="">Categoría…</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  {newItem.category && !categories.includes(newItem.category) && (
                    <option value={newItem.category}>{newItem.category} (nueva)</option>
                  )}
                </select>
                <input style={S.input} placeholder="Nombre" value={newItem.name} onChange={e => setNewItem(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div style={S.adminRow}>
                <div style={S.priceInputGroup}>
                  <span style={S.priceLabel}>🪑 Salón</span>
                  <input style={{ ...S.input, width: 80, flex: "none" }} placeholder="0.00" type="number" min="0" step="0.10"
                    value={newItem.priceSalon} onChange={e => setNewItem(p => ({ ...p, priceSalon: e.target.value }))} />
                </div>
                <div style={S.priceInputGroup}>
                  <span style={S.priceLabel}>☀️ Terraza</span>
                  <input style={{ ...S.input, width: 80, flex: "none" }} placeholder="0.00" type="number" min="0" step="0.10"
                    value={newItem.priceTerrace} onChange={e => setNewItem(p => ({ ...p, priceTerrace: e.target.value }))} />
                </div>
                <button style={S.addBtn} onClick={addMenuItem}>+ Añadir</button>
              </div>
            </div>

            {categories.map(cat => (
              <div key={cat} style={S.catBlock}>
                <div style={S.catBlockTitle}>{cat}</div>
                <div style={{ ...S.adminItemRow, color: C.muted, fontSize: 11, borderBottom: `1px solid ${C.border}`, paddingBottom: 4 }}>
                  <span style={{ flex: 1 }}>Producto</span>
                  <span style={{ width: 80, textAlign: "center" }}>🪑 Salón</span>
                  <span style={{ width: 88, textAlign: "center" }}>☀️ Terraza</span>
                  <span style={{ width: 24 }}></span>
                </div>
                {menuByCategory[cat].map(item => (
                  <div key={item.id} style={S.adminItemRow}>
                    <span style={{ flex: 1 }}>{item.name}</span>
                    <input style={{ ...S.input, width: 72, flex: "none", textAlign: "right" }} type="number" min="0" step="0.10"
                      value={item.price_salon} onChange={e => updateMenuItemPrice(item.id, "price_salon", e.target.value)} />
                    <input style={{ ...S.input, width: 72, flex: "none", textAlign: "right", marginLeft: 4 }} type="number" min="0" step="0.10"
                      value={item.price_terrace} onChange={e => updateMenuItemPrice(item.id, "price_terrace", e.target.value)} />
                    <button style={S.deleteBtn} onClick={() => deleteMenuItem(item.id)}>✕</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── VISTA: ADMIN SALA ── */}
      {view === "adminSala" && (
        <div style={S.container}>
          <div style={S.adminCard}>
            <div style={S.adminSection}>
              <b style={{ color: C.accentLight }}>Zonas del local</b>
              {zones.map(z => (
                <div key={z.id} style={S.adminItemRow}>
                  <span style={{ fontSize: 18, marginRight: 6 }}>{z.icon}</span>
                  <span style={{ flex: 1 }}>{z.name}</span>
                  <span style={{ fontSize: 11, color: C.muted, marginRight: 8 }}>
                    tarifa: {z.price_field === "price_terrace" ? "terraza" : "salón"}
                  </span>
                  <button style={S.deleteBtn} onClick={() => deleteZone(z.id)}>✕</button>
                </div>
              ))}
              <div style={S.adminRow}>
                <input style={{ ...S.input, width: 40, flex: "none" }} value={newZoneIcon} onChange={e => setNewZoneIcon(e.target.value)} maxLength={2} />
                <input style={S.input} placeholder="Nombre zona" value={newZoneName} onChange={e => setNewZoneName(e.target.value)} />
                <select style={S.select} value={newZonePriceField} onChange={e => setNewZonePriceField(e.target.value)}>
                  <option value="price_salon">Tarifa salón</option>
                  <option value="price_terrace">Tarifa terraza</option>
                </select>
                <button style={S.addBtn} onClick={addZone}>+ Zona</button>
              </div>
            </div>

            {zones.map(z => {
              const zt = tables.filter(t => t.zone_id === z.id);
              return (
                <div key={z.id} style={S.catBlock}>
                  <div style={S.catBlockTitle}>{z.icon} {z.name} — {zt.length} mesas</div>
                  {zt.map(t => (
                    <div key={t.id} style={S.adminItemRow}>
                      <input style={{ ...S.input, width: 80, flex: "none", fontWeight: 700 }}
                        defaultValue={t.label} onBlur={e => updateTableLabel(t.id, e.target.value)} maxLength={6} />
                      <select style={{ ...S.select, flex: 1 }} value={t.zone_id} onChange={e => updateTableZone(t.id, e.target.value)}>
                        {zones.map(dz => <option key={dz.id} value={dz.id}>{dz.icon} {dz.name}</option>)}
                      </select>
                      {(t.orders || []).length > 0 && <span style={{ fontSize: 11, color: C.accent, marginRight: 6 }}>ocupada</span>}
                      <button style={{ ...S.deleteBtn, opacity: (t.orders || []).length > 0 ? 0.3 : 1 }}
                        disabled={(t.orders || []).length > 0} onClick={() => deleteTable(t.id)}>✕</button>
                    </div>
                  ))}
                </div>
              );
            })}

            <div style={S.adminSection}>
              <b style={{ color: C.accentLight }}>Añadir mesa</b>
              <div style={S.adminRow}>
                <input style={{ ...S.input, width: 80, flex: "none" }} placeholder="Nº o nombre" value={newTableLabel}
                  onChange={e => setNewTableLabel(e.target.value)} maxLength={6} />
                <select style={{ ...S.select, flex: 1 }} value={newTableZone || zones[0]?.id || ""} onChange={e => setNewTableZone(e.target.value)}>
                  {zones.map(z => <option key={z.id} value={z.id}>{z.icon} {z.name}</option>)}
                </select>
                <button style={S.addBtn} onClick={addTable}>+ Mesa</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── COLORES ──────────────────────────────────────────────────────────────────
const C = {
  bg: "#1a1208", surface: "#251c0f", card: "#2e2210",
  accent: "#c8922a", accentLight: "#e8b04a",
  text: "#f0e6d0", muted: "#9a8870",
  danger: "#c04040", success: "#4a9a60",
  border: "#3d2e18", occupied: "#3a280e",
};

const S = {
  root: { minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter','Helvetica Neue',sans-serif", display: "flex", flexDirection: "column" },
  header: { background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "11px 14px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 100 },
  headerTitle: { flex: 1, fontSize: 15, fontWeight: 700, color: C.accentLight, letterSpacing: "-0.3px" },
  headerRight: { display: "flex", alignItems: "center", gap: 8 },
  headerTotal: { color: C.accentLight, fontWeight: 800, fontSize: 15 },
  backBtn: { background: "none", border: "none", color: C.accent, fontSize: 20, cursor: "pointer", padding: "2px 6px" },
  iconBtn: { background: "none", border: `1px solid ${C.border}`, color: C.muted, fontSize: 15, cursor: "pointer", padding: "4px 9px", borderRadius: 6 },
  syncDot: (ok) => ({ width: 7, height: 7, borderRadius: "50%", background: ok ? C.success : C.danger, display: "inline-block" }),
  container: { flex: 1, padding: 12, overflowY: "auto", maxWidth: 900, width: "100%", margin: "0 auto" },

  zoneTabs: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 },
  zoneTab: (a) => ({ background: a ? C.accent : C.card, color: a ? "#1a1208" : C.text, border: `1px solid ${a ? C.accent : C.border}`, borderRadius: 20, padding: "5px 14px", fontSize: 13, fontWeight: a ? 700 : 400, cursor: "pointer" }),

  zoneBlock: { marginBottom: 20 },
  zoneHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${C.border}` },
  zoneIcon: { fontSize: 18 },
  zoneName: { fontWeight: 700, fontSize: 15, color: C.accentLight },
  zoneStat: { marginLeft: "auto", fontSize: 12, color: C.muted },

  tablesGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(88px, 1fr))", gap: 9 },
  tableCard: (occ) => ({ background: occ ? C.occupied : C.card, border: `2px solid ${occ ? C.accent : C.border}`, borderRadius: 10, padding: "10px 6px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, minHeight: 76 }),
  tableNum: { fontSize: 20, fontWeight: 800, color: C.accentLight },
  tableProd: { fontSize: 11, color: C.muted },
  tablePrice: { fontSize: 13, fontWeight: 700, color: C.accent },
  tableEmpty: { fontSize: 11, color: C.muted },

  summaryBar: { background: C.surface, borderRadius: 10, padding: "10px 14px", display: "flex", justifyContent: "space-between", fontSize: 13, color: C.muted, border: `1px solid ${C.border}`, marginTop: 8 },

  mesaLayout: { display: "flex", flexDirection: "column", gap: 12 },
  comandaPanel: { background: C.surface, borderRadius: 12, padding: 14, border: `1px solid ${C.border}` },
  panelTitle: { fontWeight: 700, fontSize: 14, color: C.accentLight, marginBottom: 10, borderBottom: `1px solid ${C.border}`, paddingBottom: 7 },
  emptyComanda: { color: C.muted, fontSize: 13, textAlign: "center", padding: "14px 0" },
  comandaRow: { display: "flex", alignItems: "center", gap: 7, padding: "6px 0", borderBottom: `1px solid ${C.border}` },
  qtyBtn: { background: C.card, border: `1px solid ${C.border}`, color: C.text, width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0 },
  cmdQty: { width: 20, textAlign: "center", fontWeight: 700, fontSize: 14, color: C.accentLight },
  cmdName: { flex: 1, fontSize: 13 },
  cmdPrice: { fontSize: 13, fontWeight: 600, color: C.accent, minWidth: 56, textAlign: "right" },
  totalRow: { display: "flex", justifyContent: "space-between", padding: "10px 2px 4px", fontWeight: 700, fontSize: 14 },
  totalAmt: { color: C.accentLight, fontSize: 18 },
  cobrarBtn: { width: "100%", marginTop: 10, background: C.accent, color: "#1a1208", border: "none", borderRadius: 10, padding: "12px", fontSize: 15, fontWeight: 800, cursor: "pointer" },

  catalogPanel: { background: C.surface, borderRadius: 12, padding: 12, border: `1px solid ${C.border}` },
  priceBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", background: C.card, borderRadius: 8, padding: "6px 10px", marginBottom: 10, fontSize: 13 },
  priceTag: { color: C.accentLight, fontWeight: 700, fontSize: 12 },
  catTabs: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 },
  catTab: (a) => ({ background: a ? C.accent : C.card, color: a ? "#1a1208" : C.text, border: `1px solid ${a ? C.accent : C.border}`, borderRadius: 20, padding: "4px 11px", fontSize: 12, fontWeight: a ? 700 : 400, cursor: "pointer" }),
  productsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))", gap: 8 },
  productBtn: (inOrder) => ({ background: inOrder ? "#3a2c10" : C.card, border: `1.5px solid ${inOrder ? C.accent : C.border}`, borderRadius: 10, padding: "9px 8px", cursor: "pointer", textAlign: "left", position: "relative", display: "flex", flexDirection: "column", gap: 4 }),
  productName: { fontSize: 13, color: C.text, fontWeight: 500, lineHeight: 1.2 },
  productPrice: { fontSize: 13, color: C.accent, fontWeight: 700 },
  badge: { position: "absolute", top: 5, right: 6, background: C.accent, color: "#1a1208", borderRadius: "50%", width: 17, height: 17, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800 },

  closingCard: { background: C.surface, borderRadius: 14, padding: 20, border: `1px solid ${C.border}`, maxWidth: 420, margin: "0 auto" },
  closingTitle: { fontSize: 18, fontWeight: 800, color: C.accentLight, marginBottom: 14, textAlign: "center" },
  closingRow: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: `1px solid ${C.border}` },
  closingQty: { color: C.accent, fontWeight: 700, minWidth: 26, fontSize: 14 },
  closingName: { flex: 1, fontSize: 14 },
  closingPrice: { fontSize: 14, fontWeight: 600, color: C.accentLight },
  closingTotal: { display: "flex", justifyContent: "space-between", padding: "13px 0 16px", fontWeight: 700, fontSize: 15, borderTop: `2px solid ${C.accent}`, marginTop: 4 },
  closingTotalAmt: { color: C.accentLight, fontSize: 28, fontWeight: 900 },
  confirmarBtn: { width: "100%", background: C.success, color: "#fff", border: "none", borderRadius: 10, padding: "13px", fontSize: 15, fontWeight: 700, cursor: "pointer", marginBottom: 10 },
  volverBtn: { width: "100%", background: "none", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px", fontSize: 14, cursor: "pointer" },

  adminCard: { background: C.surface, borderRadius: 14, padding: 16, border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 16, marginBottom: 16 },
  adminSection: { display: "flex", flexDirection: "column", gap: 8 },
  adminRow: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
  adminItemRow: { display: "flex", alignItems: "center", gap: 6, padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 },
  priceInputGroup: { display: "flex", alignItems: "center", gap: 4, background: C.card, borderRadius: 8, padding: "4px 8px", border: `1px solid ${C.border}` },
  priceLabel: { fontSize: 12, color: C.muted, whiteSpace: "nowrap" },
  input: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 10px", color: C.text, fontSize: 13, flex: 1, minWidth: 80 },
  select: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 10px", color: C.text, fontSize: 13 },
  addBtn: { background: C.accent, color: "#1a1208", border: "none", borderRadius: 8, padding: "8px 13px", fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0 },
  deleteBtn: { background: "none", border: "none", color: C.danger, cursor: "pointer", fontSize: 14, padding: "2px 5px" },
  catBlock: { background: C.card, borderRadius: 10, padding: 12, border: `1px solid ${C.border}` },
  catBlockTitle: { fontWeight: 700, color: C.accent, fontSize: 13, marginBottom: 8 },

  toast: { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: C.accent, color: "#1a1208", padding: "9px 18px", borderRadius: 20, fontWeight: 700, fontSize: 14, zIndex: 999, boxShadow: "0 4px 20px rgba(0,0,0,0.4)", whiteSpace: "nowrap" },
};
