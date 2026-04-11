import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import Hotel from '../models/Hotel.js';
import Transport from '../models/Transport.js';
import Activity from '../models/Activity.js';
import Destination from '../models/Destination.js';
import { protect } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ─── HOTELS ────────────────────────────────────────

router.get('/hotels', protect, async (req, res) => {
  try {
    const { destination, search, page = 1, limit = 50 } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (destination) filter.destination = new RegExp(destination, 'i');
    if (search) filter.$text = { $search: search };
    
    const hotels = await Hotel.find(filter)
      .sort({ destination: 1, name: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await Hotel.countDocuments(filter);
    
    res.json({ hotels, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/hotels/:id', protect, async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!hotel) return res.status(404).json({ message: 'Not found' });
    res.json(hotel);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/hotels', protect, async (req, res) => {
  try {
    // Auto-create destination if needed
    if (req.body.destination) {
      const existing = await Destination.findOne({ name: { $regex: new RegExp(`^${req.body.destination}$`, 'i') } });
      if (!existing) {
        await Destination.create({ name: req.body.destination, country: 'Kenya' });
      }
    }
    const hotel = await Hotel.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(hotel);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/hotels/:id', protect, async (req, res) => {
  try {
    const hotel = await Hotel.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!hotel) return res.status(404).json({ message: 'Hotel not found' });
    res.json(hotel);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/hotels/:id', protect, async (req, res) => {
  try {
    await Hotel.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── TRANSPORT ────────────────────────────────────────

router.get('/transport', protect, async (req, res) => {
  try {
    const filter = { organization: req.organizationId, isActive: true };
    const transport = await Transport.find(filter).sort({ name: 1 });
    res.json({ transport, total: transport.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/transport', protect, async (req, res) => {
  try {
    const t = await Transport.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(t);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/transport/:id', protect, async (req, res) => {
  try {
    const t = await Transport.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true }
    );
    if (!t) return res.status(404).json({ message: 'Not found' });
    res.json(t);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/transport/:id', protect, async (req, res) => {
  try {
    await Transport.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── ACTIVITIES ────────────────────────────────────────

router.get('/activities', protect, async (req, res) => {
  try {
    const { destination } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (destination) filter.destination = new RegExp(destination, 'i');
    
    const activities = await Activity.find(filter).sort({ destination: 1, name: 1 });
    res.json({ activities, total: activities.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/activities', protect, async (req, res) => {
  try {
    const a = await Activity.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(a);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/activities/:id', protect, async (req, res) => {
  try {
    const a = await Activity.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true }
    );
    if (!a) return res.status(404).json({ message: 'Not found' });
    res.json(a);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/activities/:id', protect, async (req, res) => {
  try {
    await Activity.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── SPREADSHEET IMPORT ────────────────────────────────

router.post('/import', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const results = { hotels: 0, transport: 0, activities: 0, destinations: 0, errors: [] };
    const seenDestinations = new Set();

    for (const sheetName of workbook.SheetNames) {
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
      if (!data.length) continue;

      const type = sheetName.toLowerCase();

      if (type.includes('hotel') || type.includes('accommodation')) {
        for (const row of data) {
          try {
            // Auto-create destination if it doesn't exist
            if (row.Destination && !seenDestinations.has(row.Destination)) {
              seenDestinations.add(row.Destination);
              const existing = await Destination.findOne({ name: { $regex: new RegExp(`^${row.Destination}$`, 'i') } });
              if (!existing) {
                await Destination.create({ name: row.Destination, country: 'Kenya' });
                results.destinations++;
              }
            }

            // Find or create hotel, then add rate
            let hotel = await Hotel.findOne({
              organization: req.organizationId,
              name: row.Name,
              destination: row.Destination,
            });

            const rate = {
              roomType: row.RoomType || 'Standard',
              maxOccupancy: row.MaxOccupancy || 2,
              season: (row.Season || 'all').toLowerCase(),
              startMonth: row.StartMonth || 1,
              endMonth: row.EndMonth || 12,
              ratePerNight: row.RatePerNight || 0,
              mealPlan: row.MealPlan || 'BB',
              childFreeAge: row.ChildFreeAge || 3,
              childReducedAge: row.ChildReducedAge || 12,
              childReducedPct: row.ChildReducedPct || 50,
              minimumNights: row.MinimumNights || 1,
            };

            if (hotel) {
              hotel.rates.push(rate);
              await hotel.save();
            } else {
              hotel = await Hotel.create({
                organization: req.organizationId,
                name: row.Name,
                destination: row.Destination,
                location: row.Location || '',
                stars: row.Stars || 3,
                currency: row.Currency || 'KES',
                tags: row.Tags ? row.Tags.split(',').map(t => t.trim()) : [],
                notes: row.Notes || '',
                rates: [rate],
              });
            }
            results.hotels++;
          } catch (e) {
            results.errors.push(`Hotel "${row.Name}": ${e.message}`);
          }
        }
      }

      if (type.includes('transport')) {
        for (const row of data) {
          try {
            await Transport.create({
              organization: req.organizationId,
              name: row.Name,
              type: (row.Type || '4x4').toLowerCase(),
              capacity: row.Capacity || 6,
              pricingModel: row.PricingModel || 'per_day',
              season: (row.Season || 'all').toLowerCase(),
              routeOrZone: row.RouteOrZone || '',
              rate: row.Rate || 0,
              fuelIncluded: row.FuelIncluded === 'yes',
              driverIncluded: row.DriverIncluded === 'yes',
              destinations: row.Destinations ? row.Destinations.split(',').map(d => d.trim()) : [],
              currency: row.Currency || 'KES',
              notes: row.Notes || '',
            });
            results.transport++;
          } catch (e) {
            results.errors.push(`Transport "${row.Name}": ${e.message}`);
          }
        }
      }

      if (type.includes('activit')) {
        for (const row of data) {
          try {
            // Auto-create destination
            if (row.Destination && !seenDestinations.has(row.Destination)) {
              seenDestinations.add(row.Destination);
              const existing = await Destination.findOne({ name: { $regex: new RegExp(`^${row.Destination}$`, 'i') } });
              if (!existing) {
                await Destination.create({ name: row.Destination, country: 'Kenya' });
                results.destinations++;
              }
            }

            await Activity.create({
              organization: req.organizationId,
              name: row.Name,
              destination: row.Destination,
              description: row.Description || '',
              duration: row.Duration || 0,
              pricingModel: row.PricingModel || 'per_person',
              season: (row.Season || 'all').toLowerCase(),
              costPerPerson: row.CostPerPerson || 0,
              groupRate: row.GroupRate || 0,
              maxGroupSize: row.MaxGroupSize || 0,
              commissionRate: row.CommissionRate || 0,
              minimumAge: row.MinimumAge || 0,
              tags: row.Tags ? row.Tags.split(',').map(t => t.trim()) : [],
              currency: row.Currency || 'KES',
              notes: row.Notes || '',
            });
            results.activities++;
          } catch (e) {
            results.errors.push(`Activity "${row.Name}": ${e.message}`);
          }
        }
      }
    }

    res.json({
      message: `Imported ${results.hotels} hotel rates, ${results.transport} transport, ${results.activities} activities${results.destinations > 0 ? `, ${results.destinations} new destinations` : ''}`,
      ...results,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── STATS ────────────────────────────────────────

router.get('/stats', protect, async (req, res) => {
  try {
    const orgId = req.organizationId;
    const [hotels, transport, activities] = await Promise.all([
      Hotel.countDocuments({ organization: orgId, isActive: true }),
      Transport.countDocuments({ organization: orgId, isActive: true }),
      Activity.countDocuments({ organization: orgId, isActive: true }),
    ]);
    
    const destinations = await Hotel.distinct('destination', { organization: orgId, isActive: true });
    
    res.json({ hotels, transport, activities, destinations: destinations.length, destinationList: destinations });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;