import { Router } from 'express';
import User from '../models/User.js';
import Organization from '../models/Organization.js';
import Contact from '../models/Contact.js';
import Hotel from '../models/Hotel.js';
import { Deal } from '../models/Deal.js';
import { protect } from '../middleware/auth.js';

const router = Router();

const ADMIN_ROLES = ['owner', 'admin'];
const isAdmin = (user) => ADMIN_ROLES.includes(user.role);

// All possible checklist items. Each item has its own role gate; backend filters
// by the requesting user's role so non-admins don't see admin-only steps.
function buildItemDefs() {
  return [
    {
      id: 'complete_profile',
      label: 'Complete your profile',
      description: 'Add your name, phone, and a profile photo so teammates can recognize you.',
      link: '/settings',
      linkLabel: 'Open profile',
      dismissable: false,
      adminOnly: false,
      visibleToViewer: true,
    },
    {
      id: 'quote_signature',
      label: 'Add your quote signature',
      description: 'Sign quotes with a personal touch — clients respond better to a human-shaped close.',
      link: '/settings',
      linkLabel: 'Add signature',
      dismissable: false,
      adminOnly: false,
      visibleToViewer: false,
    },
    {
      id: 'set_branding',
      label: 'Set company branding',
      description: 'Upload your logo and pick brand colors. Used on every quote you send.',
      link: '/settings',
      linkLabel: 'Open branding',
      dismissable: false,
      adminOnly: true,
      visibleToViewer: false,
    },
    {
      id: 'invite_team',
      label: 'Invite your team',
      description: 'Bring in agents, marketers, and ops folks — assign them to the right pipelines.',
      link: '/settings',
      linkLabel: 'Invite teammates',
      dismissable: false,
      adminOnly: true,
      visibleToViewer: false,
    },
    {
      id: 'first_contact',
      label: 'Add your first contact',
      description: 'Build your client list. Import from CSV or add one manually.',
      link: '/crm',
      linkLabel: 'Add a contact',
      dismissable: false,
      adminOnly: false,
      visibleToViewer: false,
    },
    {
      id: 'first_deal',
      label: 'Create your first deal',
      description: 'Drop an inquiry into your sales pipeline and start tracking it.',
      link: '/crm',
      linkLabel: 'Create a deal',
      dismissable: false,
      adminOnly: false,
      visibleToViewer: false,
    },
    {
      id: 'first_hotel',
      label: 'Upload your first hotel',
      description: 'Build your hotel library so quotes can pull rates and rooms instantly.',
      link: '/partners',
      linkLabel: 'Add a hotel',
      dismissable: true,
      dismissLabel: 'SafiriPro is uploading these for me',
      adminOnly: false,
      visibleToViewer: false,
    },
  ];
}

// Returns the list of items relevant to this user, with `completed` flags filled in.
async function buildStatusForUser(user) {
  const orgId = user.organization;

  // Filter by role first to avoid unnecessary queries.
  const userIsAdmin = isAdmin(user);
  const userIsViewer = user.role === 'viewer';
  const all = buildItemDefs().filter(item => {
    if (item.adminOnly && !userIsAdmin) return false;
    if (userIsViewer && !item.visibleToViewer) return false;
    return true;
  });

  // Run all the org-state lookups we might need in parallel.
  const [org, contactCount, dealCount, hotelCount, teamCount] = await Promise.all([
    Organization.findById(orgId).select('branding').lean(),
    Contact.countDocuments({ organization: orgId, isActive: true }),
    Deal.countDocuments({ organization: orgId, isActive: true }),
    Hotel.countDocuments({ organization: orgId }),
    User.countDocuments({ organization: orgId, isActive: true }),
  ]);

  const isComplete = (id) => {
    switch (id) {
      case 'complete_profile':
        return Boolean(user.name && user.phone);
      case 'quote_signature':
        return Boolean(user.signature || user.signatureNote);
      case 'set_branding':
        return Boolean(org?.branding?.logo);
      case 'invite_team':
        return teamCount > 1;
      case 'first_contact':
        return contactCount > 0;
      case 'first_deal':
        return dealCount > 0;
      case 'first_hotel':
        return hotelCount > 0;
      default:
        return false;
    }
  };

  const dismissed = user.onboardingItemsDismissed || [];

  // Items the user explicitly skipped count as "done" for progress purposes
  // and surface in the UI as a muted/skipped state.
  const items = all.map(item => ({
    ...item,
    completed: isComplete(item.id),
    skipped: dismissed.includes(item.id),
  }));

  const total = items.length;
  const completed = items.filter(i => i.completed || i.skipped).length;

  return {
    dismissed: Boolean(user.onboardingDismissed),
    items,
    progress: { completed, total },
  };
}

router.get('/status', protect, async (req, res) => {
  try {
    const status = await buildStatusForUser(req.user);
    res.json(status);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/dismiss', protect, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { onboardingDismissed: true });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/reopen', protect, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { onboardingDismissed: false });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/dismiss-item', protect, async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ message: 'itemId is required' });
    const allowed = buildItemDefs().filter(i => i.dismissable).map(i => i.id);
    if (!allowed.includes(itemId)) {
      return res.status(400).json({ message: 'This item cannot be skipped' });
    }
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { onboardingItemsDismissed: itemId } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Restore a previously skipped item (in case operator changes their mind).
router.post('/restore-item', protect, async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ message: 'itemId is required' });
    await User.findByIdAndUpdate(req.user._id, { $pull: { onboardingItemsDismissed: itemId } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
