import { Router } from 'express';
import { getStaffUser, requireStaffAuth } from '../middleware/staffAuth.js';
import { getAloNowDelivery } from '../database/aloNowDeliveries.js';
import { readTrustedShopifyOrderV2290 } from '../integrations/shopify/aloNowTrustedOrderReader.v2290.js';
import { readDriverShopifyEvidenceV2291 } from '../modules/aloNow/aloNowDriverOrderEvidence.v2291.js';

export const aloNowDriverOrderEvidenceRouterV2291 = Router();
aloNowDriverOrderEvidenceRouterV2291.get(
  '/driver/deliveries/:orderNumber/shopify-evidence',
  requireStaffAuth,
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (process.env.ALO_NOW_DRIVER_ORDER_EVIDENCE_ENABLED !== 'true')
      return res.status(503).json({ok: false, error: 'ALO_DRIVER_ORDER_EVIDENCE_DISABLED'});
    const staff = getStaffUser(res);
    const orderNumber = String(req.params.orderNumber ?? '').trim();
    if (!/^[1-9][0-9]{0,18}$/.test(orderNumber))
      return res.status(400).json({ok: false, error: 'INVALID_SHOPIFY_ORDER_NUMBER'});
    try {
      const evidence = await readDriverShopifyEvidenceV2291(orderNumber, staff.id, {
        getDelivery: getAloNowDelivery,
        readOrder: readTrustedShopifyOrderV2290,
      });
      if (!evidence) return res.status(404).json({ok: false, error: 'DELIVERY_NOT_FOUND'});
      return res.json({ok: true, evidence});
    } catch {
      return res.status(503).json({ok: false, error: 'DRIVER_SHOPIFY_EVIDENCE_UNAVAILABLE'});
    }
  },
);
