// ============================================================
// Industry presets — starter tag packs and pipeline templates.
//
// Pure data, no I/O. Consumed by the Settings → Tags card ("Add starter
// tags") and the Pipelines "New pipeline" dialog ("Start from a
// template"). Names are English on purpose: they become real rows the
// user can rename, not UI copy.
// ============================================================

export type IndustryId =
  | 'general'
  | 'saas'
  | 'services'
  | 'ecommerce'
  | 'real_estate'
  | 'education'
  | 'healthcare'
  | 'finance'
  | 'hospitality'
  | 'recruitment';

export interface PresetTag {
  name: string;
  color: string;
}

export interface PresetStage {
  name: string;
  color: string;
}

export interface PresetPipeline {
  /** Stable id used as a <select> value; not persisted. */
  id: string;
  name: string;
  description: string;
  stages: PresetStage[];
}

export interface IndustryPreset {
  id: IndustryId;
  label: string;
  tags: PresetTag[];
  pipelines: PresetPipeline[];
}

// Palette shared with the tag manager's swatches.
const C = {
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  emerald: '#10b981',
  green: '#22c55e',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  pink: '#ec4899',
  slate: '#64748b',
} as const;

/** Lifecycle + engagement tags every CRM benefits from. */
const COMMON_TAGS: PresetTag[] = [
  { name: 'Lead', color: C.blue },
  { name: 'Prospect', color: C.cyan },
  { name: 'Customer', color: C.emerald },
  { name: 'VIP', color: C.amber },
  { name: 'Hot', color: C.red },
  { name: 'Warm', color: C.orange },
  { name: 'Cold', color: C.slate },
  { name: 'Follow-up', color: C.violet },
  { name: 'Newsletter', color: C.pink },
  { name: 'Do Not Contact', color: C.red },
  { name: 'Churned', color: C.slate },
  { name: 'Referral', color: C.green },
];

/** The classic 5-stage sales funnel (matches the seeded default). */
const SALES_PIPELINE: PresetPipeline = {
  id: 'general-sales',
  name: 'Sales Pipeline',
  description: 'Classic lead-to-close funnel for any business.',
  stages: [
    { name: 'New Lead', color: C.blue },
    { name: 'Qualified', color: C.yellow },
    { name: 'Proposal Sent', color: C.orange },
    { name: 'Negotiation', color: C.violet },
    { name: 'Won', color: C.green },
  ],
};

export const INDUSTRY_PRESETS: IndustryPreset[] = [
  {
    id: 'general',
    label: 'General / Any business',
    tags: COMMON_TAGS,
    pipelines: [
      SALES_PIPELINE,
      {
        id: 'general-support',
        name: 'Customer Support',
        description: 'Track support requests from first message to resolution.',
        stages: [
          { name: 'New Request', color: C.blue },
          { name: 'In Progress', color: C.yellow },
          { name: 'Waiting on Customer', color: C.orange },
          { name: 'Resolved', color: C.green },
          { name: 'Closed', color: C.slate },
        ],
      },
    ],
  },
  {
    id: 'saas',
    label: 'SaaS / Software',
    tags: [
      { name: 'Trial', color: C.cyan },
      { name: 'Free Plan', color: C.slate },
      { name: 'Paid', color: C.emerald },
      { name: 'Enterprise', color: C.violet },
      { name: 'Demo Requested', color: C.blue },
      { name: 'Onboarding', color: C.yellow },
      { name: 'Upsell', color: C.amber },
      { name: 'At Risk', color: C.red },
      { name: 'Churned', color: C.slate },
      { name: 'Renewal Due', color: C.orange },
      { name: 'Advocate', color: C.pink },
      { name: 'Feature Request', color: C.green },
    ],
    pipelines: [
      {
        id: 'saas-sales',
        name: 'SaaS Sales',
        description: 'Demo → trial → paid subscription.',
        stages: [
          { name: 'Lead', color: C.blue },
          { name: 'Demo Scheduled', color: C.cyan },
          { name: 'Trial', color: C.yellow },
          { name: 'Proposal', color: C.orange },
          { name: 'Negotiation', color: C.violet },
          { name: 'Closed Won', color: C.green },
        ],
      },
      {
        id: 'saas-onboarding',
        name: 'Customer Onboarding',
        description: 'Get new accounts to first value.',
        stages: [
          { name: 'Signed Up', color: C.blue },
          { name: 'Kickoff Call', color: C.cyan },
          { name: 'Setup', color: C.yellow },
          { name: 'Training', color: C.orange },
          { name: 'Activated', color: C.green },
        ],
      },
      {
        id: 'saas-renewal',
        name: 'Renewals & Expansion',
        description: 'Manage upcoming renewals and upsells.',
        stages: [
          { name: 'Renewal in 90 days', color: C.blue },
          { name: 'Health Check', color: C.cyan },
          { name: 'Upsell Proposed', color: C.amber },
          { name: 'Renewed', color: C.green },
          { name: 'Churned', color: C.red },
        ],
      },
    ],
  },
  {
    id: 'services',
    label: 'Agency / Service business',
    tags: [
      { name: 'Inquiry', color: C.blue },
      { name: 'Quote Sent', color: C.orange },
      { name: 'Active Client', color: C.emerald },
      { name: 'Retainer', color: C.violet },
      { name: 'One-off Project', color: C.cyan },
      { name: 'Past Client', color: C.slate },
      { name: 'Partner', color: C.pink },
      { name: 'Vendor', color: C.amber },
      { name: 'Invoice Pending', color: C.red },
      { name: 'Testimonial', color: C.green },
    ],
    pipelines: [
      {
        id: 'services-sales',
        name: 'Client Acquisition',
        description: 'Inquiry → discovery → quote → signed.',
        stages: [
          { name: 'Inquiry', color: C.blue },
          { name: 'Discovery Call', color: C.cyan },
          { name: 'Quote Sent', color: C.orange },
          { name: 'Negotiation', color: C.violet },
          { name: 'Signed', color: C.green },
        ],
      },
      {
        id: 'services-delivery',
        name: 'Project Delivery',
        description: 'Track each engagement from kickoff to handover.',
        stages: [
          { name: 'Kickoff', color: C.blue },
          { name: 'In Progress', color: C.yellow },
          { name: 'Client Review', color: C.orange },
          { name: 'Revisions', color: C.violet },
          { name: 'Delivered', color: C.green },
          { name: 'Invoiced', color: C.emerald },
        ],
      },
    ],
  },
  {
    id: 'ecommerce',
    label: 'E-commerce / Retail',
    tags: [
      { name: 'First-time Buyer', color: C.blue },
      { name: 'Repeat Customer', color: C.emerald },
      { name: 'Abandoned Cart', color: C.orange },
      { name: 'Wholesale', color: C.violet },
      { name: 'COD', color: C.amber },
      { name: 'Prepaid', color: C.cyan },
      { name: 'Return Requested', color: C.red },
      { name: 'Loyalty Member', color: C.pink },
      { name: 'Big Spender', color: C.yellow },
      { name: 'Reviewer', color: C.green },
    ],
    pipelines: [
      {
        id: 'ecom-orders',
        name: 'Order Fulfilment',
        description: 'Follow every order from placed to delivered.',
        stages: [
          { name: 'Order Placed', color: C.blue },
          { name: 'Payment Confirmed', color: C.cyan },
          { name: 'Packed', color: C.yellow },
          { name: 'Shipped', color: C.orange },
          { name: 'Delivered', color: C.green },
        ],
      },
      {
        id: 'ecom-cart',
        name: 'Abandoned Cart Recovery',
        description: 'Recover carts over WhatsApp.',
        stages: [
          { name: 'Cart Abandoned', color: C.orange },
          { name: 'Reminder Sent', color: C.blue },
          { name: 'Offer Sent', color: C.amber },
          { name: 'Recovered', color: C.green },
          { name: 'Lost', color: C.slate },
        ],
      },
      {
        id: 'ecom-returns',
        name: 'Returns & Exchanges',
        description: 'Handle return requests end to end.',
        stages: [
          { name: 'Requested', color: C.blue },
          { name: 'Approved', color: C.cyan },
          { name: 'Pickup Scheduled', color: C.yellow },
          { name: 'Received', color: C.orange },
          { name: 'Refunded / Exchanged', color: C.green },
        ],
      },
    ],
  },
  {
    id: 'real_estate',
    label: 'Real estate',
    tags: [
      { name: 'Buyer', color: C.blue },
      { name: 'Seller', color: C.violet },
      { name: 'Tenant', color: C.cyan },
      { name: 'Landlord', color: C.amber },
      { name: 'Investor', color: C.emerald },
      { name: 'Site Visit Done', color: C.yellow },
      { name: 'Loan Pre-approved', color: C.green },
      { name: 'Ready to Move', color: C.orange },
      { name: 'Under Construction', color: C.slate },
      { name: 'Broker', color: C.pink },
    ],
    pipelines: [
      {
        id: 're-buyers',
        name: 'Buyer Pipeline',
        description: 'Enquiry → site visit → booking → registration.',
        stages: [
          { name: 'New Enquiry', color: C.blue },
          { name: 'Requirement Understood', color: C.cyan },
          { name: 'Site Visit', color: C.yellow },
          { name: 'Negotiation', color: C.orange },
          { name: 'Booking', color: C.violet },
          { name: 'Agreement / Registration', color: C.green },
        ],
      },
      {
        id: 're-rentals',
        name: 'Rentals',
        description: 'Match tenants to listings.',
        stages: [
          { name: 'Enquiry', color: C.blue },
          { name: 'Viewing Scheduled', color: C.yellow },
          { name: 'Application', color: C.orange },
          { name: 'Deposit Paid', color: C.violet },
          { name: 'Moved In', color: C.green },
        ],
      },
    ],
  },
  {
    id: 'education',
    label: 'Education / Coaching',
    tags: [
      { name: 'Student', color: C.blue },
      { name: 'Parent', color: C.cyan },
      { name: 'Enrolled', color: C.emerald },
      { name: 'Alumni', color: C.slate },
      { name: 'Demo Class', color: C.yellow },
      { name: 'Scholarship', color: C.amber },
      { name: 'Fee Pending', color: C.red },
      { name: 'Batch A', color: C.violet },
      { name: 'Batch B', color: C.pink },
      { name: 'Webinar Attendee', color: C.orange },
    ],
    pipelines: [
      {
        id: 'edu-admissions',
        name: 'Admissions',
        description: 'Enquiry → counselling → enrolment.',
        stages: [
          { name: 'Enquiry', color: C.blue },
          { name: 'Counselling Call', color: C.cyan },
          { name: 'Demo / Trial Class', color: C.yellow },
          { name: 'Application', color: C.orange },
          { name: 'Fee Paid', color: C.violet },
          { name: 'Enrolled', color: C.green },
        ],
      },
    ],
  },
  {
    id: 'healthcare',
    label: 'Healthcare / Clinic',
    tags: [
      { name: 'New Patient', color: C.blue },
      { name: 'Returning Patient', color: C.emerald },
      { name: 'Appointment Booked', color: C.yellow },
      { name: 'No-show', color: C.red },
      { name: 'Follow-up Due', color: C.orange },
      { name: 'Insurance', color: C.cyan },
      { name: 'Self-pay', color: C.amber },
      { name: 'Lab Results Pending', color: C.violet },
      { name: 'Chronic Care', color: C.pink },
    ],
    pipelines: [
      {
        id: 'health-appointments',
        name: 'Appointments',
        description: 'From enquiry to completed visit.',
        stages: [
          { name: 'Enquiry', color: C.blue },
          { name: 'Booked', color: C.yellow },
          { name: 'Confirmed', color: C.cyan },
          { name: 'Visited', color: C.green },
          { name: 'Follow-up', color: C.orange },
        ],
      },
      {
        id: 'health-treatment',
        name: 'Treatment Plans',
        description: 'Multi-visit treatments and packages.',
        stages: [
          { name: 'Consultation', color: C.blue },
          { name: 'Plan Proposed', color: C.orange },
          { name: 'Accepted', color: C.violet },
          { name: 'In Treatment', color: C.yellow },
          { name: 'Completed', color: C.green },
        ],
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance / Insurance',
    tags: [
      { name: 'Policy Holder', color: C.emerald },
      { name: 'Loan Applicant', color: C.blue },
      { name: 'KYC Pending', color: C.orange },
      { name: 'KYC Verified', color: C.green },
      { name: 'Renewal Due', color: C.amber },
      { name: 'Claim Open', color: C.red },
      { name: 'High Net Worth', color: C.violet },
      { name: 'SIP / Recurring', color: C.cyan },
      { name: 'Lapsed', color: C.slate },
    ],
    pipelines: [
      {
        id: 'fin-loans',
        name: 'Loan Applications',
        description: 'Lead → documents → approval → disbursal.',
        stages: [
          { name: 'Lead', color: C.blue },
          { name: 'Documents Collected', color: C.cyan },
          { name: 'Under Review', color: C.yellow },
          { name: 'Approved', color: C.violet },
          { name: 'Disbursed', color: C.green },
          { name: 'Rejected', color: C.red },
        ],
      },
      {
        id: 'fin-policy',
        name: 'Policy Sales',
        description: 'Quote → proposal → issued.',
        stages: [
          { name: 'Enquiry', color: C.blue },
          { name: 'Quote Shared', color: C.orange },
          { name: 'Proposal Submitted', color: C.yellow },
          { name: 'Medical / KYC', color: C.cyan },
          { name: 'Policy Issued', color: C.green },
        ],
      },
    ],
  },
  {
    id: 'hospitality',
    label: 'Hospitality / Travel',
    tags: [
      { name: 'Guest', color: C.blue },
      { name: 'Repeat Guest', color: C.emerald },
      { name: 'Corporate', color: C.violet },
      { name: 'Group Booking', color: C.cyan },
      { name: 'Honeymoon', color: C.pink },
      { name: 'Special Request', color: C.amber },
      { name: 'Review Requested', color: C.yellow },
      { name: 'Cancelled', color: C.red },
      { name: 'Travel Agent', color: C.orange },
    ],
    pipelines: [
      {
        id: 'hosp-bookings',
        name: 'Bookings',
        description: 'Enquiry → quote → confirmed stay.',
        stages: [
          { name: 'Enquiry', color: C.blue },
          { name: 'Quote Sent', color: C.orange },
          { name: 'Advance Received', color: C.yellow },
          { name: 'Confirmed', color: C.violet },
          { name: 'Checked In', color: C.cyan },
          { name: 'Checked Out', color: C.green },
        ],
      },
    ],
  },
  {
    id: 'recruitment',
    label: 'Recruitment / HR',
    tags: [
      { name: 'Candidate', color: C.blue },
      { name: 'Client Company', color: C.violet },
      { name: 'Shortlisted', color: C.yellow },
      { name: 'Interview Scheduled', color: C.cyan },
      { name: 'Offer Extended', color: C.amber },
      { name: 'Hired', color: C.green },
      { name: 'Rejected', color: C.red },
      { name: 'Passive', color: C.slate },
      { name: 'Referral', color: C.pink },
    ],
    pipelines: [
      {
        id: 'hr-hiring',
        name: 'Hiring Pipeline',
        description: 'Applied → screened → interviewed → hired.',
        stages: [
          { name: 'Applied', color: C.blue },
          { name: 'Screening', color: C.cyan },
          { name: 'Interview', color: C.yellow },
          { name: 'Assessment', color: C.orange },
          { name: 'Offer', color: C.violet },
          { name: 'Hired', color: C.green },
        ],
      },
    ],
  },
];

export function getIndustryPreset(id: IndustryId): IndustryPreset {
  return INDUSTRY_PRESETS.find((p) => p.id === id) ?? INDUSTRY_PRESETS[0];
}

/** Every pipeline template with its industry label, for a grouped <select>. */
export function allPipelineTemplates(): { industry: IndustryPreset; pipeline: PresetPipeline }[] {
  return INDUSTRY_PRESETS.flatMap((industry) =>
    industry.pipelines.map((pipeline) => ({ industry, pipeline }))
  );
}

export function findPipelineTemplate(id: string): PresetPipeline | null {
  return allPipelineTemplates().find((x) => x.pipeline.id === id)?.pipeline ?? null;
}

const key = (s: string) => s.trim().toLowerCase();

/**
 * The preset tags that do NOT already exist (case-insensitive name
 * match), so "Add starter tags" never creates a duplicate.
 */
export function missingPresetTags(preset: PresetTag[], existingNames: string[]): PresetTag[] {
  const have = new Set(existingNames.map(key));
  const seen = new Set<string>();
  return preset.filter((t) => {
    const k = key(t.name);
    if (have.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
