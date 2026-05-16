import express from "express";
import axios   from "axios";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);

const META_BASE    = process.env.META_BASE_URL    || "https://graph.facebook.com";
const META_VERSION = process.env.META_API_VERSION || "v19.0";

/**
 * Handle Meta Embedded Signup callback.
 * Exchanges the code for access token + phone number ID.
 */
router.post("/whatsapp/embedded-signup", async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ message: "Authorization code is required" });
    }

    // Step 1 — Exchange code for access token
    const tokenResponse = await axios.get(`${META_BASE}/oauth/access_token`, {
      params: {
        client_id:     process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        code,
      },
    });

    const accessToken = tokenResponse.data.access_token;
    if (!accessToken) {
      return res.status(400).json({ message: "Failed to get access token from Meta" });
    }

    // Step 2 — Get WhatsApp Business Account details
    const wabaResponse = await axios.get(`${META_BASE}/${META_VERSION}/me/whatsapp_business_accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const wabaData = wabaResponse.data?.data?.[0];
    if (!wabaData) {
      return res.status(400).json({ message: "No WhatsApp Business Account found" });
    }

    const wabaId = wabaData.id;

    // Step 3 — Get phone numbers in the WABA
    const phoneResponse = await axios.get(`${META_BASE}/${META_VERSION}/${wabaId}/phone_numbers`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const phoneData    = phoneResponse.data?.data?.[0];
    const phoneNumberId = phoneData?.id;
    const phoneNumber  = phoneData?.display_phone_number;

    if (!phoneNumberId) {
      return res.status(400).json({ message: "No phone number found in WhatsApp Business Account" });
    }

    // Step 4 — Check if phone number already used by another business
    const { rows: existing } = await query(`
      SELECT business_id FROM whatsapp_configs
      WHERE phone_number_id = $1
        AND business_id != $2
    `, [phoneNumberId, req.user.business_id]);

    if (existing.length > 0) {
      return res.status(409).json({
        message: "This WhatsApp number is already connected to another Voxiro account.",
      });
    }

    // Step 5 — Save to database
    await query(`
      INSERT INTO whatsapp_configs
        (business_id, phone_number_id, access_token, whatsapp_number, is_verified)
      VALUES ($1, $2, $3, $4, TRUE)
      ON CONFLICT (business_id) DO UPDATE
      SET phone_number_id  = $2,
          access_token     = $3,
          whatsapp_number  = $4,
          is_verified      = TRUE,
          updated_at       = NOW()
    `, [req.user.business_id, phoneNumberId, accessToken, phoneNumber]);

    // Step 6 — Subscribe to webhook messages
    try {
      await axios.post(
        `${META_BASE}/${META_VERSION}/${wabaId}/subscribed_apps`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    } catch {
      // Non-critical — subscription can be done manually
    }

    res.json({
      success:        true,
      phoneNumberId,
      whatsappNumber: phoneNumber,
      wabaId,
    });

  } catch (err) {
    console.error("Embedded signup error:", err.response?.data || err.message);
    res.status(500).json({
      message: err.response?.data?.error?.message || "Failed to connect WhatsApp. Please try manual setup.",
    });
  }
});

export default router;