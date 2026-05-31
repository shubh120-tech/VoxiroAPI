import { useState, useEffect } from "react";
import { useSearchParams }     from "react-router-dom";
import api                     from "../../services/api";
import COLORS                  from "../../styles/colors";
import PageHeader              from "../../components/ui/PageHeader";
import Button                  from "../../components/ui/Button";

export default function Integrations() {
  const [searchParams]  = useSearchParams();
  const [integrations,  setIntegrations]  = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [msg,           setMsg]           = useState({ text: "", type: "success" });
  const [shopUrl,       setShopUrl]       = useState("");
  const [showShopify,   setShowShopify]   = useState(false);
  const [showWoo,       setShowWoo]       = useState(false);
  const [wooForm,       setWooForm]       = useState({ store_url: "", api_key: "", api_secret: "" });
  const [connecting,    setConnecting]    = useState(false);
  const [syncing,       setSyncing]       = useState(null);

  const showMsg = (text, type = "success") => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: "", type: "success" }), 5000);
  };

  useEffect(() => {
    loadIntegrations();

    // Handle OAuth callback from Shopify
    const success = searchParams.get("success");
    const error   = searchParams.get("error");
    const shop    = searchParams.get("shop");

    if (success === "shopify_connected") {
      showMsg(`✅ ${shop || "Shopify"} connected successfully! Products are syncing...`);
      setShowShopify(false);
    } else if (error) {
      const msgs = {
        invalid_state: "Session expired. Please try connecting again.",
        invalid_hmac:  "Security check failed — check SHOPIFY_CLIENT_SECRET in Railway.",
        no_token:      "Could not get access token — check Client ID and Secret.",
        token_failed:  "Token exchange failed (403) — credentials mismatch.",
      };
      showMsg(msgs[error] || `Connection failed: ${error}`, "error");
      console.error("Shopify OAuth error:", error, searchParams.toString());
    }
  }, []);

  const loadIntegrations = async () => {
    setLoading(true);
    try {
      const res = await api.get("/store/integrations");
      setIntegrations(res.integrations || []);
    } catch { setIntegrations([]); }
    finally { setLoading(false); }
  };

  const shopify = integrations.find(i => i.platform === "shopify");
  const woo     = integrations.find(i => i.platform === "woocommerce");

  // ── Shopify OAuth ─────────────────────────────────────────
  const handleShopifyConnect = async () => {
    if (!shopUrl.trim()) { showMsg("Enter your Shopify store URL", "error"); return; }
    setConnecting(true);
    try {
      const res = await api.post("/store/shopify/install", { shop: shopUrl.trim() });
      const url = res.authUrl || res.installUrl;
      if (url) {
        // Redirect to Shopify OAuth
        window.location.href = url;
      } else {
        showMsg(res.message || "Failed to get auth URL", "error");
        setConnecting(false);
      }
    } catch (err) {
      showMsg(err.message || "Connection failed", "error");
      setConnecting(false);
    }
  };

  // ── WooCommerce ───────────────────────────────────────────
  const handleWooConnect = async () => {
    if (!wooForm.store_url || !wooForm.api_key || !wooForm.api_secret) {
      showMsg("All WooCommerce fields are required", "error"); return;
    }
    setConnecting(true);
    try {
      await api.post("/store/connect/woocommerce", wooForm);
      showMsg("✅ WooCommerce connected!");
      setWooForm({ store_url: "", api_key: "", api_secret: "" });
      setShowWoo(false);
      loadIntegrations();
    } catch (err) {
      showMsg(err.message || "Connection failed", "error");
    }
    setConnecting(false);
  };

  // ── Sync products ─────────────────────────────────────────
  const handleSync = async (id) => {
    setSyncing(id);
    try {
      await api.post(`/store/integrations/${id}/sync`, {});
      showMsg("✅ Sync started — products will update shortly");
      loadIntegrations();
    } catch (err) {
      showMsg(err.message || "Sync failed", "error");
    }
    setSyncing(null);
  };

  // ── Disconnect ────────────────────────────────────────────
  const handleDisconnect = async (id, name) => {
    if (!confirm(`Disconnect ${name}? Product sync will stop.`)) return;
    try {
      await api.delete(`/store/integrations/${id}`);
      showMsg(`${name} disconnected`);
      loadIntegrations();
    } catch (err) {
      showMsg(err.message || "Failed to disconnect", "error");
    }
  };

  const card = { background: "white", borderRadius: 16, border: `1px solid ${COLORS.border}`, padding: "20px 22px", marginBottom: 14 };
  const inp  = { width: "100%", padding: "10px 12px", border: `1.5px solid ${COLORS.border}`, borderRadius: 10, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };

  return (
    <div className="fade-in" style={{ maxWidth: 720, margin: "0 auto" }}>
      <PageHeader title="Integrations" subtitle="Connect your store to sync products and orders automatically" />

      {msg.text && (
        <div style={{ background: msg.type === "error" ? "#fef2f2" : COLORS.greenBg, border: `1px solid ${msg.type === "error" ? "#fecaca" : COLORS.greenBorder}`, borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13, color: msg.type === "error" ? "#dc2626" : "#15803d", fontWeight: 600 }}>
          {msg.text}
        </div>
      )}

      {/* ── SHOPIFY ─────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: (shopify || showShopify) ? 18 : 0 }}>
          {/* Shopify icon */}
          <div style={{ width: 48, height: 48, borderRadius: 12, background: "#95BF47", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>
            🛍️
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Shopify</div>
            <div style={{ fontSize: 13, color: COLORS.textLight }}>
              {shopify
                ? `Connected: ${shopify.store_url}`
                : "Sync products, inventory and orders from your Shopify store"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {shopify ? (
              <>
                <span style={{ fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: COLORS.greenBg, color: "#15803d" }}>✅ Connected</span>
                <button onClick={() => handleSync(shopify.id)} disabled={syncing === shopify.id}
                  style={{ padding: "6px 14px", background: COLORS.tealBg, border: `1px solid ${COLORS.tealBorder}`, borderRadius: 8, fontSize: 12, color: COLORS.tealDark, cursor: "pointer", fontWeight: 600 }}>
                  {syncing === shopify.id ? "Syncing..." : "🔄 Sync Now"}
                </button>
                <button onClick={() => handleDisconnect(shopify.id, "Shopify")}
                  style={{ padding: "6px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 12, color: "#dc2626", cursor: "pointer", fontWeight: 600 }}>
                  Disconnect
                </button>
              </>
            ) : (
              <Button onClick={() => setShowShopify(!showShopify)} size="sm">
                {showShopify ? "Cancel" : "Connect Shopify"}
              </Button>
            )}
          </div>
        </div>

        {/* Shopify connect form */}
        {showShopify && !shopify && (
          <div style={{ borderTop: `1px solid ${COLORS.borderLight}`, paddingTop: 18 }}>
            <div style={{ background: COLORS.tealBg, border: `1px solid ${COLORS.tealBorder}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16, fontSize: 13, color: COLORS.tealDark }}>
              <strong>How it works:</strong> You'll be redirected to Shopify to authorize Yougant. Products sync automatically every 6 hours.
            </div>

            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: COLORS.textMid, marginBottom: 6 }}>
              Shopify Store URL
            </label>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1, position: "relative" }}>
                <input
                  value={shopUrl}
                  onChange={e => setShopUrl(e.target.value)}
                  placeholder="yourstore.myshopify.com"
                  style={{ ...inp }}
                  onKeyDown={e => e.key === "Enter" && handleShopifyConnect()}
                />
              </div>
              <Button loading={connecting} onClick={handleShopifyConnect}>
                Connect →
              </Button>
            </div>
            <div style={{ fontSize: 11, color: COLORS.textLight, marginTop: 6 }}>
              Enter just the subdomain (e.g. <strong>mystore</strong>) or full URL (mystore.myshopify.com)
            </div>
          </div>
        )}

        {/* Shopify stats */}
        {shopify && (
          <div style={{ borderTop: `1px solid ${COLORS.borderLight}`, paddingTop: 14, display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: COLORS.textLight }}>
              📦 <strong style={{ color: COLORS.text }}>{shopify.products_count || 0}</strong> products synced
            </div>
            <div style={{ fontSize: 12, color: COLORS.textLight }}>
              🕐 Last sync: <strong style={{ color: COLORS.text }}>{shopify.last_synced_at ? new Date(shopify.last_synced_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never"}</strong>
            </div>
            <div style={{ fontSize: 12, color: COLORS.textLight }}>
              🔄 Auto-sync every 6 hours
            </div>
          </div>
        )}
      </div>

      {/* ── WOOCOMMERCE ─────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: (woo || showWoo) ? 18 : 0 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: "#7F54B3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>
            🛒
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>WooCommerce</div>
            <div style={{ fontSize: 13, color: COLORS.textLight }}>
              {woo ? `Connected: ${woo.store_url}` : "Connect your WordPress WooCommerce store via API key"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {woo ? (
              <>
                <span style={{ fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: COLORS.greenBg, color: "#15803d" }}>✅ Connected</span>
                <button onClick={() => handleSync(woo.id)} disabled={syncing === woo.id}
                  style={{ padding: "6px 14px", background: COLORS.tealBg, border: `1px solid ${COLORS.tealBorder}`, borderRadius: 8, fontSize: 12, color: COLORS.tealDark, cursor: "pointer", fontWeight: 600 }}>
                  {syncing === woo.id ? "Syncing..." : "🔄 Sync Now"}
                </button>
                <button onClick={() => handleDisconnect(woo.id, "WooCommerce")}
                  style={{ padding: "6px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 12, color: "#dc2626", cursor: "pointer", fontWeight: 600 }}>
                  Disconnect
                </button>
              </>
            ) : (
              <Button onClick={() => setShowWoo(!showWoo)} size="sm">
                {showWoo ? "Cancel" : "Connect WooCommerce"}
              </Button>
            )}
          </div>
        </div>

        {/* WooCommerce connect form */}
        {showWoo && !woo && (
          <div style={{ borderTop: `1px solid ${COLORS.borderLight}`, paddingTop: 18 }}>
            <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 10, padding: "12px 14px", marginBottom: 16, fontSize: 13, color: "#6d28d9" }}>
              <strong>Where to get API keys:</strong> WordPress Admin → WooCommerce → Settings → Advanced → REST API → Add Key
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: COLORS.textMid, marginBottom: 5 }}>Store URL *</label>
                <input value={wooForm.store_url} onChange={e => setWooForm(p => ({ ...p, store_url: e.target.value }))} placeholder="https://yourstore.com" style={inp} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: COLORS.textMid, marginBottom: 5 }}>Consumer Key *</label>
                <input value={wooForm.api_key} onChange={e => setWooForm(p => ({ ...p, api_key: e.target.value }))} placeholder="ck_xxxxxxxxxxxx" style={inp} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: COLORS.textMid, marginBottom: 5 }}>Consumer Secret *</label>
                <input type="password" value={wooForm.api_secret} onChange={e => setWooForm(p => ({ ...p, api_secret: e.target.value }))} placeholder="cs_xxxxxxxxxxxx" style={inp} />
              </div>
            </div>
            <Button loading={connecting} onClick={handleWooConnect}>Connect WooCommerce</Button>
          </div>
        )}

        {/* WooCommerce stats */}
        {woo && (
          <div style={{ borderTop: `1px solid ${COLORS.borderLight}`, paddingTop: 14, display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: COLORS.textLight }}>
              📦 <strong style={{ color: COLORS.text }}>{woo.products_count || 0}</strong> products synced
            </div>
            <div style={{ fontSize: 12, color: COLORS.textLight }}>
              🕐 Last sync: <strong style={{ color: COLORS.text }}>{woo.last_synced_at ? new Date(woo.last_synced_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never"}</strong>
            </div>
          </div>
        )}
      </div>

      {/* ── COMING SOON ─────────────────────────────────── */}
      <div style={{ ...card, opacity: 0.6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: "#FF9900", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>📦</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Amazon Seller <span style={{ fontSize: 11, background: COLORS.borderLight, color: COLORS.textLight, padding: "2px 8px", borderRadius: 20, marginLeft: 6 }}>Coming Soon</span></div>
            <div style={{ fontSize: 13, color: COLORS.textLight }}>Connect your Amazon seller account</div>
          </div>
        </div>
      </div>

      <div style={{ ...card, opacity: 0.6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: "#F05122", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🛍️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Flipkart Seller <span style={{ fontSize: 11, background: COLORS.borderLight, color: COLORS.textLight, padding: "2px 8px", borderRadius: 20, marginLeft: 6 }}>Coming Soon</span></div>
            <div style={{ fontSize: 13, color: COLORS.textLight }}>Connect your Flipkart seller account</div>
          </div>
        </div>
      </div>

      {/* ── SETUP GUIDE for Shopify ──────────────────────── */}
      {!shopify && (
        <div style={{ ...card, background: COLORS.bg }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>📖 How to connect Shopify</div>
          {[
            { step: "1", text: "Click \"Connect Shopify\" above" },
            { step: "2", text: "Enter your store URL (e.g. mystore.myshopify.com)" },
            { step: "3", text: "You'll be redirected to Shopify to authorize" },
            { step: "4", text: "Click \"Install app\" on Shopify" },
            { step: "5", text: "You'll be redirected back — products sync automatically" },
          ].map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "flex-start" }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", background: COLORS.teal, color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                {s.step}
              </div>
              <div style={{ fontSize: 13, color: COLORS.textMid, paddingTop: 3 }}>{s.text}</div>
            </div>
          ))}
          <div style={{ marginTop: 14, padding: "10px 14px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, fontSize: 12, color: "#92400e" }}>
            ⚠️ Make sure you have added your app's callback URL in Shopify Partner Dashboard:<br />
            <code style={{ fontFamily: "monospace", fontWeight: 600 }}>https://voxiroapi-production.up.railway.app/api/store/shopify/callback</code>
          </div>
        </div>
      )}
    </div>
  );
}