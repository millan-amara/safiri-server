import mongoose from 'mongoose';

// Captures every /api/search call so the operator (and the platform admin)
// can see what real users type, which intent the parser inferred, and whether
// the system actually returned anything. Used to validate guesses about which
// features get used vs. which patterns the parser mishandles.
//
// Auto-expires via TTL — 90 days is plenty to spot patterns; longer windows
// just bloat the collection.

const parsedSummarySchema = new mongoose.Schema({
  type: { type: String, default: null },              // 'hotel' | 'activity' | 'transport' | 'package' | null
  destinationName: { type: String, default: null },
  propertyType: { type: [String], default: undefined }, // null when not narrowed
  subjectName: { type: String, default: null },       // lookup intent
  lookupTopic: { type: String, default: null },       // lookup intent
  diagnostic: { type: String, default: null },        // diagnostic intent
  adults: { type: Number, default: null },
  childrenCount: { type: Number, default: 0 },
  budgetMax: { type: Number, default: null },
  currency: { type: String, default: null },
  boardBasis: { type: String, default: null },
  clientType: { type: String, default: null },
  nationality: { type: String, default: null },
  mustHave: { type: [String], default: [] },          // first 10 entries
  dateFrom: { type: String, default: null },          // ISO yyyy-mm-dd
  dateTo: { type: String, default: null },
}, { _id: false });

const searchLogSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Raw operator-typed query (capped at 500 chars upstream by the route).
  query: { type: String, required: true },

  // 'search' | 'lookup' | 'diagnostic' — what the parser inferred AFTER any
  // demotion (e.g. lookup without subjectName auto-demotes to search).
  intent: { type: String, enum: ['search', 'lookup', 'diagnostic'], required: true },

  // Snapshot of the structured parse — lets us spot patterns like
  // "operators keep asking about cancellation policy" without re-running the parser.
  parsed: { type: parsedSummarySchema, default: () => ({}) },

  // Branch the route actually took. Useful for separating "returned 0 results"
  // from "asked for clarification" from "served candidates for disambiguation".
  outcome: {
    type: String,
    enum: ['results', 'no_results', 'clarification', 'lookup_answer', 'lookup_candidates', 'diagnostic_items', 'diagnostic_clean', 'error'],
    required: true,
  },

  resultCount: { type: Number, default: 0 },          // # of items in the response (results / candidates / items)
  vectorPathUsed: { type: Boolean, default: false },  // true when the hotel/activity/transport vector path produced results
  ms: { type: Number, default: 0 },                   // wall-clock duration

  // TTL anchor — Mongo will delete the doc 90 days after this timestamp.
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
}, {
  // We use the explicit createdAt above (so the TTL index attaches to it).
  // Skip timestamps:true which would create updatedAt without a TTL.
  timestamps: false,
});

// Common query patterns: per-org most-recent, filter by intent/outcome.
searchLogSchema.index({ organization: 1, createdAt: -1 });
searchLogSchema.index({ organization: 1, intent: 1, createdAt: -1 });
searchLogSchema.index({ outcome: 1, createdAt: -1 });

export default mongoose.model('SearchLog', searchLogSchema);
