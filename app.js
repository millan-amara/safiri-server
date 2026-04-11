import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import connectDB from './config/db.js';

import authRoutes from './routes/auth.js';
import partnerRoutes from './routes/partners.js';
import crmRoutes from './routes/crm.js';
import quoteRoutes from './routes/quotes.js';
import settingsRoutes from './routes/settings.js';
import aiRoutes from './routes/ai.js';
import uploadRoutes from './routes/uploads.js';
import pdfRoutes from './routes/pdf.js';
import notificationRoutes from './routes/notifications.js';
import destinationRoutes from './routes/destinations.js';
import automationRoutes from './routes/automations.js';
import webhookRoutes from './routes/webhooks.js';
import { checkInactiveDeals, checkOverdueTasks } from './automations/engine.js';

dotenv.config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/partners', partnerRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/pdf', pdfRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/destinations', destinationRoutes);
app.use('/api/automations', automationRoutes);
app.use('/api/webhooks', webhookRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();

  // Clean up stale indexes that may cause issues
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;

    // Fix quote indexes
    const quoteColls = await db.listCollections({ name: 'quotes' }).toArray();
    if (quoteColls.length > 0) {
      const indexes = await db.collection('quotes').indexes();
      for (const idx of indexes) {
        if (idx.name !== '_id_' && idx.key?.shareToken === 1 && idx.name !== 'shareToken_1') {
          await db.collection('quotes').dropIndex(idx.name);
          console.log(`Dropped stale index: ${idx.name}`);
        }
      }
    }

    // Remove destinations without organization (leftover from old global schema)
    const destColls = await db.listCollections({ name: 'destinations' }).toArray();
    if (destColls.length > 0) {
      const result = await db.collection('destinations').deleteMany({ organization: { $exists: false } });
      if (result.deletedCount > 0) console.log(`Cleaned ${result.deletedCount} org-less destinations`);

      // Drop old text index if it exists (replaced with org+name compound)
      try {
        const destIndexes = await db.collection('destinations').indexes();
        for (const idx of destIndexes) {
          if (idx.name !== '_id_' && (idx.key?.name === 'text' || idx.key?._fts === 'text')) {
            await db.collection('destinations').dropIndex(idx.name);
            console.log(`Dropped stale destination index: ${idx.name}`);
          }
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // Not critical
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Run scheduled automation checks
    // Inactive deals — every 6 hours
    setInterval(checkInactiveDeals, 6 * 60 * 60 * 1000);
    // Overdue tasks — every hour
    setInterval(checkOverdueTasks, 60 * 60 * 1000);
  });
};

start();