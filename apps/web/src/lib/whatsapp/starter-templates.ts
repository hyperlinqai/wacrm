import type { TemplateButton } from "@/types";

export const STARTER_INDUSTRIES = [
  "marketing_agency",
  "automation",
  "real_estate",
  "service_business",
  "restaurant",
  "ecommerce",
  "clinic",
] as const;

export type StarterIndustryId = (typeof STARTER_INDUSTRIES)[number];

/** @deprecated Use STARTER_INDUSTRIES — kept so older imports still type-check. */
export const STARTER_COLUMNS = STARTER_INDUSTRIES;
export type StarterColumnId = StarterIndustryId;

export interface StarterTemplate {
  id: string;
  industry: StarterIndustryId;
  title: string;
  name: string;
  version: number;
  category: "Marketing" | "Utility";
  language: string;
  body_text: string;
  footer_text?: string;
  buttons: TemplateButton[];
  body_samples: string[];
}

function s(
  industry: StarterIndustryId,
  spec: Omit<StarterTemplate, "industry" | "language" | "version"> & {
    version?: number;
    language?: string;
  },
): StarterTemplate {
  return {
    version: 1,
    language: "en_US",
    ...spec,
    industry,
  };
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  // —— Marketing agency ——
  s("marketing_agency", {
    id: "agency_welcome",
    title: "Agency welcome",
    name: "agency_welcome",
    category: "Utility",
    body_text:
      "Hi {{1}}, thanks for reaching {{2}}. We help brands grow with ads, content, and automation. What should we look at first?",
    body_samples: ["Priya", "Hyperlinq"],
    buttons: [
      { type: "QUICK_REPLY", text: "Paid ads" },
      { type: "QUICK_REPLY", text: "Content" },
      { type: "QUICK_REPLY", text: "Automation" },
    ],
  }),
  s("marketing_agency", {
    id: "marketing_audit_offer",
    title: "Free marketing audit",
    name: "marketing_audit_offer",
    category: "Marketing",
    body_text:
      "Hi {{1}}, we reviewed {{2}} at a glance — tracking, ads, and follow-up look leaky. Want a 20-minute audit this week? We'll send 3 fixes you can use immediately.",
    body_samples: ["Rahul", "your site"],
    buttons: [
      { type: "QUICK_REPLY", text: "Book audit" },
      { type: "QUICK_REPLY", text: "Send examples" },
    ],
  }),
  s("marketing_agency", {
    id: "ads_performance_update",
    title: "Ads performance update",
    name: "ads_performance_update",
    category: "Utility",
    body_text:
      "Hi {{1}}, {{2}} recap: spend {{3}}. Top campaign is converting; we'll shift budget there tomorrow. Reply if you want the full breakdown.",
    body_samples: ["Ananya", "this week's ads", "$1,200"],
    buttons: [{ type: "QUICK_REPLY", text: "Send report" }],
  }),
  s("marketing_agency", {
    id: "retainer_proposal",
    title: "Retainer proposal",
    name: "retainer_proposal",
    category: "Marketing",
    body_text:
      "Hi {{1}}, here's a simple retainer for {{2}}: ads + creatives + weekly WhatsApp reporting. Want the one-pager or a call to tailor it?",
    body_samples: ["Arjun", "your brand"],
    buttons: [
      { type: "QUICK_REPLY", text: "Send one-pager" },
      { type: "QUICK_REPLY", text: "Book a call" },
    ],
  }),
  s("marketing_agency", {
    id: "content_calendar_ready",
    title: "Content calendar ready",
    name: "content_calendar_ready",
    category: "Utility",
    body_text:
      "Hi {{1}}, your {{2}} content calendar is ready — posts, captions, and ad variants. Approve in chat or tell us what to swap.",
    body_samples: ["Meera", "April"],
    buttons: [
      { type: "QUICK_REPLY", text: "Approve" },
      { type: "QUICK_REPLY", text: "Request edits" },
    ],
  }),
  s("marketing_agency", {
    id: "lead_nurture_followup",
    title: "Lead nurture follow-up",
    name: "lead_nurture_followup",
    category: "Marketing",
    body_text:
      "Hi {{1}}, circling back on {{2}}. We can run ads, landing pages, and WhatsApp follow-up as one system. What would help most this month?",
    body_samples: ["Kabir", "your enquiry"],
    buttons: [
      { type: "QUICK_REPLY", text: "Get a plan" },
      { type: "QUICK_REPLY", text: "See case study" },
    ],
  }),

  // —— Automation / CRM / AI ——
  s("automation", {
    id: "automation_welcome",
    title: "Automation studio welcome",
    name: "automation_welcome",
    category: "Utility",
    body_text:
      "Hi {{1}}, welcome to {{2}}. We build WhatsApp bots, CRM pipelines, and follow-ups that run while you sleep. Where are leads dropping today?",
    body_samples: ["Sneha", "HQ Intelligence"],
    buttons: [
      { type: "QUICK_REPLY", text: "Missed leads" },
      { type: "QUICK_REPLY", text: "Bookings" },
      { type: "QUICK_REPLY", text: "Support" },
    ],
  }),
  s("automation", {
    id: "whatsapp_crm_pitch",
    title: "WhatsApp CRM pitch",
    name: "whatsapp_crm_pitch",
    category: "Marketing",
    body_text:
      "Hi {{1}}, most {{2}} leads go cold after the first chat. We wire WhatsApp into your CRM: tags, reminders, and a human handoff when it matters. 15 minutes to map it?",
    body_samples: ["Vikram", "service"],
    buttons: [
      { type: "QUICK_REPLY", text: "Book demo" },
      { type: "QUICK_REPLY", text: "How it works" },
    ],
  }),
  s("automation", {
    id: "bot_demo_invite",
    title: "Bot demo invite",
    name: "bot_demo_invite",
    category: "Marketing",
    body_text:
      "Hi {{1}}, want to see a live WhatsApp flow for {{2}}? We'll show keyword capture, FAQs, and a handoff to your team — no slides, just the bot.",
    body_samples: ["Diya", "your business"],
    buttons: [
      { type: "QUICK_REPLY", text: "Show me" },
      { type: "QUICK_REPLY", text: "Send times" },
    ],
  }),
  s("automation", {
    id: "missed_lead_recovery",
    title: "Missed lead recovery",
    name: "missed_lead_recovery",
    category: "Utility",
    body_text:
      "Hi {{1}}, you messaged {{2}} and we missed you. Still need help? Reply and a specialist will pick this up — or tap below to book a slot.",
    body_samples: ["Aditya", "us"],
    buttons: [
      { type: "QUICK_REPLY", text: "Still interested" },
      { type: "QUICK_REPLY", text: "Book a slot" },
    ],
  }),
  s("automation", {
    id: "after_hours_auto_reply",
    title: "After-hours auto reply",
    name: "after_hours_auto_reply",
    category: "Utility",
    body_text:
      "Hi {{1}}, {{2}} is offline until {{3}}. Leave your question here — we'll reply first thing. For urgent jobs, tap Call.",
    body_samples: ["Isha", "our team", "9am"],
    buttons: [{ type: "QUICK_REPLY", text: "Leave a note" }],
  }),
  s("automation", {
    id: "workflow_kickoff",
    title: "Workflow setup kickoff",
    name: "workflow_kickoff",
    category: "Utility",
    body_text:
      "Hi {{1}}, we're kicking off your {{2}} automation: triggers, tags, and the first flow. We'll message when it's live in WhatsApp. Any keywords we must catch?",
    body_samples: ["Rohan", "lead capture"],
    buttons: [
      { type: "QUICK_REPLY", text: "Share keywords" },
      { type: "QUICK_REPLY", text: "Looks good" },
    ],
  }),
  s("automation", {
    id: "security_priority",
    title: "Your security, our priority",
    name: "security_priority",
    category: "Utility",
    body_text:
      "Hi {{1}}, chats stay in your account. Data is encrypted in transit. We don't sell conversations. Want a one-line privacy note for clients?",
    body_samples: ["Neha"],
    buttons: [{ type: "QUICK_REPLY", text: "Send the note" }],
  }),

  // —— Real estate ——
  s("real_estate", {
    id: "property_welcome",
    title: "Property enquiry welcome",
    name: "property_welcome",
    category: "Utility",
    body_text:
      "Hi {{1}}, thanks for asking about {{2}}. I can send photos, price, and viewing slots. Buying, renting, or investing?",
    body_samples: ["Karan", "Oak Avenue"],
    buttons: [
      { type: "QUICK_REPLY", text: "Buying" },
      { type: "QUICK_REPLY", text: "Renting" },
      { type: "QUICK_REPLY", text: "Investing" },
    ],
  }),
  s("real_estate", {
    id: "viewing_confirmed",
    title: "Viewing confirmed",
    name: "viewing_confirmed",
    category: "Utility",
    body_text:
      "Hi {{1}}, you're booked to view {{2}} on {{3}}. I'll be at the entrance. Reply if you need to reschedule.",
    body_samples: ["Aisha", "Oak Avenue", "Sat 11am"],
    buttons: [
      { type: "QUICK_REPLY", text: "I'll be there" },
      { type: "QUICK_REPLY", text: "Reschedule" },
    ],
  }),
  s("real_estate", {
    id: "viewing_reminder",
    title: "Viewing reminder",
    name: "viewing_reminder",
    category: "Utility",
    body_text:
      "Hi {{1}}, reminder: {{2}} viewing is tomorrow at {{3}}. Parking is on the street. See you there.",
    body_samples: ["Aman", "Oak Avenue", "11am"],
    buttons: [{ type: "QUICK_REPLY", text: "Confirmed" }],
  }),
  s("real_estate", {
    id: "new_listing_alert",
    title: "New listing alert",
    name: "new_listing_alert",
    category: "Marketing",
    body_text:
      "Hi {{1}}, a {{2}} just listed in {{3}} in your budget. Want the brochure, or should I book a viewing?",
    body_samples: ["Pooja", "2-bed", "Riverside"],
    buttons: [
      { type: "QUICK_REPLY", text: "Send brochure" },
      { type: "QUICK_REPLY", text: "Book viewing" },
    ],
  }),

  // —— Service business ——
  s("service_business", {
    id: "service_welcome",
    title: "Service enquiry welcome",
    name: "service_welcome",
    version: 2,
    category: "Utility",
    body_text:
      "Hello {{1}}, welcome to {{2}}. Tell us what you need and a preferred time — we'll confirm or suggest the next slot.",
    body_samples: ["Nikhil", "our workshop"],
    buttons: [
      { type: "QUICK_REPLY", text: "Get a quote" },
      { type: "QUICK_REPLY", text: "Book a visit" },
    ],
  }),
  s("service_business", {
    id: "booking_confirmed",
    title: "Booking confirmed",
    name: "booking_confirmed",
    category: "Utility",
    body_text:
      "Hi {{1}}, you're confirmed for {{2}} on {{3}}. We'll message if anything changes. Reply STOP only if you need to cancel.",
    body_samples: ["Riya", "AC service", "Tue 3pm"],
    buttons: [{ type: "QUICK_REPLY", text: "Add to calendar" }],
  }),
  s("service_business", {
    id: "appointment_reminder",
    title: "Appointment reminder",
    name: "appointment_reminder",
    category: "Utility",
    body_text:
      "Hi {{1}}, reminder: {{2}} is tomorrow at {{3}}. Please have the site accessible. Need to move it?",
    body_samples: ["Varun", "your visit", "10am"],
    buttons: [
      { type: "QUICK_REPLY", text: "On my way" },
      { type: "QUICK_REPLY", text: "Reschedule" },
    ],
  }),
  s("service_business", {
    id: "job_complete_review",
    title: "Job complete + review",
    name: "job_complete_review",
    category: "Utility",
    body_text:
      "Hi {{1}}, {{2}} is done. Anything we should fix while we're close by? A short review helps the next customer find us.",
    body_samples: ["Kavya", "today's job"],
    buttons: [
      { type: "QUICK_REPLY", text: "All good" },
      { type: "QUICK_REPLY", text: "Need a tweak" },
    ],
  }),
  s("service_business", {
    id: "scheduled_maintenance_alert",
    title: "Scheduled maintenance",
    name: "scheduled_maintenance_alert",
    category: "Utility",
    body_text:
      "Heads up {{1}}: we'll pause {{2}} during {{3}}. We'll message when we're back. Thanks for your patience.",
    body_samples: ["Sameer", "bookings", "Sun 2–4am"],
    buttons: [],
  }),

  // —— Restaurant ——
  s("restaurant", {
    id: "table_reservation",
    title: "Table reservation",
    name: "table_reservation",
    category: "Utility",
    body_text:
      "Hi {{1}}, table for {{2}} at {{3}} is held under your name. We'll keep it 15 minutes. Reply if the party size changes.",
    body_samples: ["Tanvi", "4", "7:30pm"],
    buttons: [
      { type: "QUICK_REPLY", text: "Confirmed" },
      { type: "QUICK_REPLY", text: "Change time" },
    ],
  }),
  s("restaurant", {
    id: "order_ready_pickup",
    title: "Order ready for pickup",
    name: "order_ready_pickup",
    category: "Utility",
    body_text:
      "Hi {{1}}, order {{2}} is ready. Collect at the counter and show this chat. Enjoy!",
    body_samples: ["Dev", "#1842"],
    buttons: [{ type: "QUICK_REPLY", text: "On my way" }],
  }),
  s("restaurant", {
    id: "weekend_specials",
    title: "Weekend specials",
    name: "weekend_specials",
    category: "Marketing",
    body_text:
      "Hi {{1}}, this weekend at {{2}}: chef specials and a set menu. Want a table, or shall we send the menu?",
    body_samples: ["Anika", "the kitchen"],
    buttons: [
      { type: "QUICK_REPLY", text: "Book a table" },
      { type: "QUICK_REPLY", text: "Send menu" },
    ],
  }),
  s("restaurant", {
    id: "feedback_after_visit",
    title: "After-visit feedback",
    name: "feedback_after_visit",
    category: "Utility",
    body_text:
      "Hi {{1}}, thanks for dining with us. How was {{2}}? One tap helps the kitchen — and we'll fix anything that missed.",
    body_samples: ["Harsh", "last night"],
    buttons: [
      { type: "QUICK_REPLY", text: "Loved it" },
      { type: "QUICK_REPLY", text: "It was ok" },
      { type: "QUICK_REPLY", text: "Had an issue" },
    ],
  }),

  // —— Ecommerce ——
  s("ecommerce", {
    id: "order_shipped",
    title: "Order shipped",
    name: "order_shipped",
    category: "Utility",
    body_text:
      "Hi {{1}}, order {{2}} is on the way. We'll share tracking as soon as the courier scans it. Reply if the address changed.",
    body_samples: ["Nisha", "#5521"],
    buttons: [{ type: "QUICK_REPLY", text: "Update address" }],
  }),
  s("ecommerce", {
    id: "cart_comeback",
    title: "Cart comeback",
    name: "cart_comeback",
    category: "Marketing",
    body_text:
      "Hi {{1}}, you left {{2}} in your cart. Still want it? I can hold stock or apply a small returner note at checkout.",
    body_samples: ["Yash", "the items"],
    buttons: [
      { type: "QUICK_REPLY", text: "Complete order" },
      { type: "QUICK_REPLY", text: "Not now" },
    ],
  }),
  s("ecommerce", {
    id: "cod_confirm",
    title: "Cash on delivery confirm",
    name: "cod_confirm",
    category: "Utility",
    body_text:
      "Hi {{1}}, confirm cash on delivery for {{2}} to {{3}}? Reply YES and we'll pack it today.",
    body_samples: ["Shruti", "your order", "home"],
    buttons: [
      { type: "QUICK_REPLY", text: "YES" },
      { type: "QUICK_REPLY", text: "Change address" },
    ],
  }),
  s("ecommerce", {
    id: "catalog_drop",
    title: "New catalog drop",
    name: "catalog_drop",
    category: "Marketing",
    body_text:
      "Hi {{1}}, new {{2}} just went live. Want the catalog in chat, or a pick based on what you bought last time?",
    body_samples: ["Manish", "arrivals"],
    buttons: [
      { type: "QUICK_REPLY", text: "Send catalog" },
      { type: "QUICK_REPLY", text: "Surprise me" },
    ],
  }),

  // —— Clinic ——
  s("clinic", {
    id: "clinic_welcome",
    title: "Clinic enquiry",
    name: "clinic_welcome",
    category: "Utility",
    body_text:
      "Hi {{1}}, thanks for contacting {{2}}. Are you booking a consult, a follow-up, or asking about a report?",
    body_samples: ["Divya", "the clinic"],
    buttons: [
      { type: "QUICK_REPLY", text: "New consult" },
      { type: "QUICK_REPLY", text: "Follow-up" },
      { type: "QUICK_REPLY", text: "Reports" },
    ],
  }),
  s("clinic", {
    id: "clinic_appointment",
    title: "Appointment confirmed",
    name: "clinic_appointment",
    category: "Utility",
    body_text:
      "Hi {{1}}, you're booked with {{2}} on {{3}}. Please arrive 10 minutes early with your ID. Reply to reschedule.",
    body_samples: ["Aarav", "Dr. Shah", "Thu 4pm"],
    buttons: [
      { type: "QUICK_REPLY", text: "I'll be there" },
      { type: "QUICK_REPLY", text: "Reschedule" },
    ],
  }),
  s("clinic", {
    id: "clinic_reminder",
    title: "Visit reminder",
    name: "clinic_reminder",
    category: "Utility",
    body_text:
      "Hi {{1}}, reminder: {{2}} tomorrow at {{3}}. Fasting required? We'll confirm at reception. See you then.",
    body_samples: ["Sana", "your visit", "9am"],
    buttons: [{ type: "QUICK_REPLY", text: "Confirmed" }],
  }),
];

export function startersByIndustry(industry: StarterIndustryId): StarterTemplate[] {
  return STARTER_TEMPLATES.filter((t) => t.industry === industry);
}

/** @deprecated Use startersByIndustry */
export function startersByColumn(column: StarterColumnId): StarterTemplate[] {
  return startersByIndustry(column);
}
