// Partner record quota — caps on hotels/activities/destinations/transport per org.
// Limits come from config/plans.js (PLANS[plan].partnerCaps[type]).
// Also enforces the per-record image limit so a single record can't upload hundreds of photos.

import Hotel from '../models/Hotel.js';
import Activity from '../models/Activity.js';
import Destination from '../models/Destination.js';
import Transport from '../models/Transport.js';
import Contact from '../models/Contact.js';
import { Pipeline } from '../models/Deal.js';
import { PLANS, UNLIMITED } from '../config/plans.js';

const MODEL = { hotel: Hotel, activity: Activity, destination: Destination, transport: Transport };
const PLURAL = { hotel: 'hotels', activity: 'activities', destination: 'destinations', transport: 'transport entries' };

/**
 * Enforce the per-type record cap on POST routes. Counts live records (isActive: true)
 * at check time so soft-deletes free up slots — no counter field to drift out of sync.
 */
export const requirePartnerQuota = (type) => async (req, res, next) => {
  if (!req.organizationId) return next();
  const Model = MODEL[type];
  if (!Model) return next();

  try {
    const plan = PLANS[req.organization?.plan] || PLANS.trial;
    const cap = plan.partnerCaps?.[type] ?? UNLIMITED;
    if (cap === UNLIMITED) return next();

    const count = await Model.countDocuments({ organization: req.organizationId, isActive: true });
    if (count >= cap) {
      return res.status(403).json({
        message: `Your ${plan.label} plan supports up to ${cap} ${PLURAL[type]}. Upgrade or deactivate existing records.`,
        type,
        used: count,
        limit: cap,
        code: 'PARTNER_QUOTA_EXCEEDED',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Enforce the per-record image cap on create/update routes.
 * Reads `images` from the request body — callers pass `images` array when populating media.
 */
export const enforceImageCap = (req, res, next) => {
  const images = req.body?.images;
  if (!Array.isArray(images)) return next();

  const plan = PLANS[req.organization?.plan] || PLANS.trial;
  const max = plan.maxImagesPerRecord ?? UNLIMITED;
  if (max === UNLIMITED) return next();

  if (images.length > max) {
    return res.status(413).json({
      message: `Your ${plan.label} plan allows up to ${max} images per record. Remove some before saving.`,
      provided: images.length,
      limit: max,
      code: 'IMAGE_CAP_EXCEEDED',
    });
  }
  next();
};

/**
 * Cap the number of custom pipelines per plan. Pipelines are a product-tier lever,
 * not a cost lever — the cap signals "multiple pipelines = serious business".
 */
export const requirePipelineQuota = async (req, res, next) => {
  if (!req.organizationId) return next();
  try {
    const plan = PLANS[req.organization?.plan] || PLANS.trial;
    const cap = plan.pipelines ?? UNLIMITED;
    if (cap === UNLIMITED) return next();

    const count = await Pipeline.countDocuments({ organization: req.organizationId, isActive: true });
    if (count >= cap) {
      return res.status(403).json({
        message: `Your ${plan.label} plan supports up to ${cap} pipeline${cap === 1 ? '' : 's'}. Upgrade to add more.`,
        used: count,
        limit: cap,
        code: 'PIPELINE_QUOTA_EXCEEDED',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Trial-only contact cap — prevents trial abuse where a user imports their full CRM,
 * uses the app for 14 days, then walks. Not enforced on paid plans.
 */
export const requireTrialContactQuota = async (req, res, next) => {
  if (!req.organizationId) return next();
  const plan = PLANS[req.organization?.plan];
  if (!plan || req.organization?.plan !== 'trial') return next();

  const cap = plan.trialContacts ?? UNLIMITED;
  if (cap === UNLIMITED) return next();

  try {
    const count = await Contact.countDocuments({ organization: req.organizationId, isActive: true });
    if (count >= cap) {
      return res.status(403).json({
        message: `Trial accounts are limited to ${cap} contacts. Upgrade to import your full list.`,
        used: count,
        limit: cap,
        code: 'TRIAL_CONTACT_LIMIT',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Cap CSV/spreadsheet import row count. Parses the uploaded file (text or XLSX) to
 * count rows before the import handler processes them. Applies the plan's csvImportRows.
 *
 * Trial also caps at whatever PLANS.trial.csvImportRows says (50).
 */
export const enforceCsvRowCap = (parseRowsFromFile) => (req, res, next) => {
  if (!req.organizationId || !req.file) return next();
  const plan = PLANS[req.organization?.plan] || PLANS.trial;
  const cap = plan.csvImportRows ?? UNLIMITED;
  if (cap === UNLIMITED) return next();

  try {
    const rowCount = parseRowsFromFile(req.file);
    if (rowCount > cap) {
      return res.status(413).json({
        message: `Your ${plan.label} plan allows up to ${cap.toLocaleString()} rows per import. Your file has ${rowCount.toLocaleString()} rows.`,
        provided: rowCount,
        limit: cap,
        code: 'IMPORT_ROW_LIMIT',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};
