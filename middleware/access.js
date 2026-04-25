import { Pipeline, Deal } from '../models/Deal.js';

const ADMIN_ROLES = ['owner', 'admin'];

// Returns ObjectIds of pipelines the user can see.
// Owner/admin → every pipeline in the org.
// Agent/viewer → pipelines where visibility='organization' OR they're explicitly listed in members[].
export const getAccessiblePipelineIds = async (user) => {
  const baseFilter = { organization: user.organization, isActive: true };

  if (ADMIN_ROLES.includes(user.role)) {
    const pipelines = await Pipeline.find(baseFilter).select('_id').lean();
    return pipelines.map(p => p._id);
  }

  const pipelines = await Pipeline.find({
    ...baseFilter,
    $or: [
      { visibility: 'organization' },
      { visibility: 'members', members: user._id },
    ],
  }).select('_id').lean();
  return pipelines.map(p => p._id);
};

// Exported so routes that derive a pipeline from the request body
// (e.g. POST /deals where pipeline is in body.pipeline, not :params) can use it inline.
export const userCanSeePipeline = (user, pipeline) => {
  if (ADMIN_ROLES.includes(user.role)) return true;
  if (pipeline.visibility === 'organization') return true;
  return (pipeline.members || []).some(m => String(m) === String(user._id));
};

// Loads pipeline by req.params[paramName], enforces access, attaches to req.pipeline.
export const requirePipelineAccess = (paramName = 'id') => async (req, res, next) => {
  try {
    const pipelineId = req.params[paramName];
    if (!pipelineId) return res.status(400).json({ message: 'Pipeline id required' });

    const pipeline = await Pipeline.findOne({
      _id: pipelineId,
      organization: req.organizationId,
      isActive: true,
    }).lean();

    if (!pipeline) return res.status(404).json({ message: 'Pipeline not found' });
    if (!userCanSeePipeline(req.user, pipeline)) {
      return res.status(403).json({ message: 'No access to this pipeline' });
    }

    req.pipeline = pipeline;
    next();
  } catch (err) {
    res.status(500).json({ message: 'Access check failed' });
  }
};

// Loads deal by req.params[paramName], enforces pipeline access, attaches req.deal + req.pipeline.
export const requireDealAccess = (paramName = 'id') => async (req, res, next) => {
  try {
    const dealId = req.params[paramName];
    if (!dealId) return res.status(400).json({ message: 'Deal id required' });

    const deal = await Deal.findOne({
      _id: dealId,
      organization: req.organizationId,
      isActive: true,
    });
    if (!deal) return res.status(404).json({ message: 'Deal not found' });

    const pipeline = await Pipeline.findOne({
      _id: deal.pipeline,
      organization: req.organizationId,
    }).lean();
    if (!pipeline) return res.status(404).json({ message: 'Pipeline not found' });

    if (!userCanSeePipeline(req.user, pipeline)) {
      return res.status(403).json({ message: 'No access to this deal' });
    }

    req.deal = deal;
    req.pipeline = pipeline;
    next();
  } catch (err) {
    res.status(500).json({ message: 'Access check failed' });
  }
};

// Pure helper — does this user have permission to delete this deal under the org's policy?
// Routes call this after they've already loaded the deal + verified pipeline access.
export const canDeleteDeal = (user, deal, org) => {
  if (user.role === 'viewer') return false;
  if (ADMIN_ROLES.includes(user.role)) return true;
  const policy = org?.preferences?.agentDealDeletion || 'own';
  if (policy === 'none') return false;
  return String(deal.createdBy) === String(user._id) || String(deal.assignedTo) === String(user._id);
};
