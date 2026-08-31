import type {
  CollectInputNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  StartNodeConfig,
} from "./types";
import type { FlowTemplate, FlowTemplateNode } from "./template-types";
import type { CatalogIcon, TemplateBadge, TemplateGoal } from "../templates/catalog-types";

interface LinearOpts {
  slug: string;
  name: string;
  description: string;
  icon: CatalogIcon;
  keywords: string[];
  intro: string;
  questions?: Array<{ prompt: string; varKey: string }>;
  closing?: string;
  handoffNote: string;
  goals: Exclude<TemplateGoal, "all">[];
  badges?: TemplateBadge[];
  recommended?: boolean;
  industry: string;
}

export function linearLeadFlow(opts: LinearOpts): FlowTemplate {
  const questions = opts.questions ?? [];
  const nodes: FlowTemplateNode[] = [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" } as StartNodeConfig,
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: opts.intro,
        next_node_key: questions[0] ? `ask_${questions[0].varKey}` : opts.closing ? "closing" : "handoff",
      } as SendMessageNodeConfig,
    },
  ];

  questions.forEach((q, i) => {
    const next =
      i < questions.length - 1
        ? `ask_${questions[i + 1].varKey}`
        : opts.closing
          ? "closing"
          : "handoff";
    nodes.push({
      node_key: `ask_${q.varKey}`,
      node_type: "collect_input",
      config: {
        prompt_text: q.prompt,
        var_key: q.varKey,
        next_node_key: next,
      } as CollectInputNodeConfig,
    });
  });

  if (opts.closing) {
    nodes.push({
      node_key: "closing",
      node_type: "send_message",
      config: {
        text: opts.closing,
        next_node_key: "handoff",
      } as SendMessageNodeConfig,
    });
  }

  nodes.push({
    node_key: "handoff",
    node_type: "handoff",
    config: { note: opts.handoffNote } as HandoffNodeConfig,
  });

  return {
    slug: opts.slug,
    name: opts.name,
    description: opts.description,
    icon: opts.icon,
    trigger_type: "keyword",
    trigger_config: {
      keywords: opts.keywords,
      match_type: "contains",
    } as KeywordTriggerConfig,
    entry_node_id: "start",
    nodes,
    goals: opts.goals,
    triggerKind: "keyword",
    badges: opts.badges ?? [],
    recommended: opts.recommended,
    industry: opts.industry,
  };
}

export function menuFlow(opts: {
  slug: string;
  name: string;
  description: string;
  icon: CatalogIcon;
  keywords: string[];
  prompt: string;
  buttons: Array<{ id: string; title: string; reply: string }>;
  goals: Exclude<TemplateGoal, "all">[];
  badges?: TemplateBadge[];
  recommended?: boolean;
  industry: string;
  trigger?: "keyword" | "first_inbound_message";
}): FlowTemplate {
  const nodes: FlowTemplateNode[] = [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "menu" } as StartNodeConfig,
    },
    {
      node_key: "menu",
      node_type: "send_buttons",
      config: {
        text: opts.prompt,
        footer_text: "Tap a button to continue.",
        buttons: opts.buttons.map((b) => ({
          reply_id: b.id,
          title: b.title,
          next_node_key: `reply_${b.id}`,
        })),
      } as SendButtonsNodeConfig,
    },
    ...opts.buttons.map((b) => ({
      node_key: `reply_${b.id}`,
      node_type: "send_message" as const,
      config: {
        text: b.reply,
        next_node_key: "end",
      } as SendMessageNodeConfig,
    })),
    { node_key: "end", node_type: "end", config: {} },
  ];

  return {
    slug: opts.slug,
    name: opts.name,
    description: opts.description,
    icon: opts.icon,
    trigger_type: opts.trigger ?? "keyword",
    trigger_config:
      opts.trigger === "first_inbound_message"
        ? {}
        : ({ keywords: opts.keywords, match_type: "contains" } as KeywordTriggerConfig),
    entry_node_id: "start",
    nodes,
    goals: opts.goals,
    triggerKind: opts.trigger === "first_inbound_message" ? "first_inbound" : "keyword",
    badges: opts.badges ?? [],
    recommended: opts.recommended,
    industry: opts.industry,
  };
}

export function listFaqFlow(opts: {
  slug: string;
  name: string;
  description: string;
  icon: CatalogIcon;
  keywords: string[];
  prompt: string;
  topics: Array<{ id: string; title: string; answer: string }>;
  goals: Exclude<TemplateGoal, "all">[];
  badges?: TemplateBadge[];
  recommended?: boolean;
  industry: string;
}): FlowTemplate {
  const nodes: FlowTemplateNode[] = [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "topics" } as StartNodeConfig,
    },
    {
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: opts.prompt,
        button_label: "View options",
        sections: [
          {
            title: "Choose a topic",
            rows: opts.topics.map((t) => ({
              reply_id: t.id,
              title: t.title,
              next_node_key: `ans_${t.id}`,
            })),
          },
        ],
      } as SendListNodeConfig,
    },
    ...opts.topics.map((t) => ({
      node_key: `ans_${t.id}`,
      node_type: "send_message" as const,
      config: {
        text: t.answer,
        next_node_key: "end",
      } as SendMessageNodeConfig,
    })),
    { node_key: "end", node_type: "end", config: {} },
  ];

  return {
    slug: opts.slug,
    name: opts.name,
    description: opts.description,
    icon: opts.icon,
    trigger_type: "keyword",
    trigger_config: {
      keywords: opts.keywords,
      match_type: "contains",
    } as KeywordTriggerConfig,
    entry_node_id: "start",
    nodes,
    goals: opts.goals,
    triggerKind: "keyword",
    badges: opts.badges ?? [],
    recommended: opts.recommended,
    industry: opts.industry,
  };
}

export const INDUSTRY_FLOW_TEMPLATES: FlowTemplate[] = [
  linearLeadFlow({
    slug: "property_inquiry",
    name: "Property info auto-reply",
    description:
      "Qualify buyers and renters: capture locality, budget, and BHK, then hand off to a property advisor.",
    icon: "Home",
    keywords: ["property", "flat", "villa", "rent", "site visit"],
    intro:
      "Thanks for your interest in our listings. I'll take 3 quick details so an advisor can send matching options.",
    questions: [
      { prompt: "Which city or locality are you looking in?", varKey: "locality" },
      { prompt: "What's your budget range?", varKey: "budget" },
      { prompt: "How many bedrooms (BHK) do you need?", varKey: "bhk" },
    ],
    closing:
      "Got it. An advisor will WhatsApp matching properties and brochure PDFs shortly.",
    handoffNote:
      "Property lead — locality={{vars.locality}}, budget={{vars.budget}}, bhk={{vars.bhk}}.",
    goals: ["leads", "sales"],
    badges: ["popular", "new"],
    recommended: true,
    industry: "Real estate",
  }),
  listFaqFlow({
    slug: "order_status",
    name: "Order & shipping lookup",
    description:
      "Let shoppers tap tracking, returns, or size help without waiting for an agent.",
    icon: "ShoppingBag",
    keywords: ["order", "track", "shipping", "return"],
    prompt: "How can we help with your order?",
    topics: [
      {
        id: "track",
        title: "Track my order",
        answer:
          "Reply with your order ID (e.g. HQ-1042) and we'll send the live tracking link.",
      },
      {
        id: "return",
        title: "Start a return",
        answer:
          "Returns are free within 7 days. Send a photo of the item plus your order ID to begin pickup.",
      },
      {
        id: "size",
        title: "Size / fit help",
        answer:
          "Share your usual size and the product name — we'll confirm the best fit before you buy.",
      },
    ],
    goals: ["support", "sales"],
    badges: ["popular"],
    recommended: true,
    industry: "E-commerce",
  }),
  linearLeadFlow({
    slug: "booking_request",
    name: "Appointment booking",
    description:
      "Collect service, preferred slot, and name, then hand off to confirm on the calendar.",
    icon: "Calendar",
    keywords: ["book", "appointment", "slot", "schedule"],
    intro: "Happy to book you in. A few details so we can lock a slot.",
    questions: [
      { prompt: "Which service do you need?", varKey: "service" },
      { prompt: "Preferred day and time?", varKey: "slot" },
      { prompt: "Your name for the booking?", varKey: "name" },
    ],
    closing: "Thanks {{vars.name}}. We'll confirm {{vars.slot}} or offer the next opening.",
    handoffNote:
      "Booking request — service={{vars.service}}, slot={{vars.slot}}, name={{vars.name}}.",
    goals: ["bookings", "ops"],
    badges: ["popular"],
    recommended: true,
    industry: "Services",
  }),
  menuFlow({
    slug: "course_catalog",
    name: "Course catalog delivery",
    description:
      "Students tap a programme and receive fees, start dates, and a registration link.",
    icon: "GraduationCap",
    keywords: ["course", "admission", "fees", "learn"],
    prompt: "Which programme are you exploring?",
    buttons: [
      {
        id: "foundation",
        title: "Foundation",
        reply:
          "Foundation batch starts the 1st of every month. Fees and syllabus: https://example.com/foundation — reply SEAT to reserve.",
      },
      {
        id: "pro",
        title: "Professional",
        reply:
          "Professional cohort is 12 weeks with mentor hours. Brochure: https://example.com/pro — reply APPLY for the form.",
      },
      {
        id: "corp",
        title: "Corporate",
        reply:
          "For team training, share headcount and we'll send a custom quote within one business day.",
      },
    ],
    goals: ["leads", "sales"],
    badges: ["new"],
    industry: "Education",
  }),
  listFaqFlow({
    slug: "restaurant_menu",
    name: "Menu & table booking",
    description:
      "Guests browse today's menu, hours, or reserve a table from WhatsApp.",
    icon: "Utensils",
    keywords: ["menu", "table", "reserve", "order"],
    prompt: "Welcome — what would you like?",
    topics: [
      {
        id: "menu",
        title: "Today's menu",
        answer:
          "Today's specials are on https://example.com/menu. Reply ORDER with dishes + quantity for pickup.",
      },
      {
        id: "table",
        title: "Reserve a table",
        answer:
          "Tell us party size, date, and time. We'll confirm or suggest the next available seating.",
      },
      {
        id: "hours",
        title: "Hours & location",
        answer:
          "Open daily 12pm–11pm. Pin: https://maps.example.com — valet after 7pm.",
      },
    ],
    goals: ["bookings", "sales"],
    industry: "Hospitality",
  }),
  linearLeadFlow({
    slug: "clinic_triage",
    name: "Clinic appointment triage",
    description:
      "Capture symptom area, preferred doctor, and slot before a receptionist confirms.",
    icon: "Stethoscope",
    keywords: ["doctor", "clinic", "appointment", "consult"],
    intro:
      "We'll get you to the right clinician. This is not an emergency line — call local emergency services if needed.",
    questions: [
      { prompt: "What is the visit for (e.g. dental, skin, general)?", varKey: "dept" },
      { prompt: "Do you have a preferred doctor, or first available?", varKey: "doctor" },
      { prompt: "Preferred day / time?", varKey: "slot" },
    ],
    closing: "A receptionist will confirm your {{vars.dept}} visit shortly.",
    handoffNote:
      "Clinic triage — dept={{vars.dept}}, doctor={{vars.doctor}}, slot={{vars.slot}}.",
    goals: ["bookings", "support"],
    badges: ["new"],
    industry: "Healthcare",
  }),
  menuFlow({
    slug: "auto_service",
    name: "Vehicle service booking",
    description:
      "Workshops offer periodic service, denting, or breakdown help from one WhatsApp menu.",
    icon: "Car",
    keywords: ["service", "car", "workshop", "breakdown"],
    prompt: "How can the workshop help today?",
    buttons: [
      {
        id: "periodic",
        title: "Periodic service",
        reply:
          "Share make, model, and km reading. We'll quote and offer pickup slots this week.",
      },
      {
        id: "body",
        title: "Dent / paint",
        reply:
          "Send 2–3 photos of the damage plus your pincode. An estimator will reply with a range.",
      },
      {
        id: "rsa",
        title: "Breakdown",
        reply:
          "Share your live location and vehicle number. Roadside assistance will call within 10 minutes.",
      },
    ],
    goals: ["bookings", "support"],
    industry: "Automotive",
  }),
  linearLeadFlow({
    slug: "loan_qualifier",
    name: "Loan / EMI qualifier",
    description:
      "Banks and NBFCs capture amount, tenure, and employment type before a relationship manager calls.",
    icon: "Landmark",
    keywords: ["loan", "emi", "finance", "credit"],
    intro: "We can check eligibility in a few questions. No documents yet.",
    questions: [
      { prompt: "What loan amount are you considering?", varKey: "amount" },
      { prompt: "Preferred tenure (months)?", varKey: "tenure" },
      { prompt: "Salaried or self-employed?", varKey: "employment" },
    ],
    closing: "A relationship manager will share options that fit {{vars.amount}}.",
    handoffNote:
      "Loan lead — amount={{vars.amount}}, tenure={{vars.tenure}}, employment={{vars.employment}}.",
    goals: ["leads", "sales"],
    badges: ["new"],
    industry: "Financial services",
  }),
  menuFlow({
    slug: "catalog_link",
    name: "Send catalog from keywords",
    description:
      "When someone asks for price or catalogue, auto-send the storefront link and a buy CTA.",
    icon: "Link",
    keywords: ["price", "catalog", "catalogue", "pricelist"],
    prompt: "Here's how to browse and order:",
    buttons: [
      {
        id: "shop",
        title: "Open catalog",
        reply:
          "Full catalog: https://example.com/shop — reply with product codes and quantities to place an order here.",
      },
      {
        id: "wholesale",
        title: "Wholesale rates",
        reply:
          "For bulk / reseller pricing, share your company name and monthly volume. A merchandiser will send the sheet.",
      },
      {
        id: "human",
        title: "Talk to sales",
        reply: "Connecting you with sales now. Someone will pick this up shortly.",
      },
    ],
    goals: ["sales", "engage"],
    badges: ["popular"],
    recommended: true,
    industry: "Retail",
  }),
  menuFlow({
    slug: "support_ai_bot",
    name: "WhatsApp support bot",
    description:
      "First inbound gets a triage menu: FAQ, order help, or a human — the pattern teams use before AI replies.",
    icon: "Headphones",
    keywords: ["hi", "hello", "help"],
    trigger: "first_inbound_message",
    prompt: "Hi! I'm the support assistant. What do you need?",
    buttons: [
      {
        id: "faq",
        title: "Common questions",
        reply:
          "Hours, shipping, and warranty are on https://example.com/help. Or type your question in one line.",
      },
      {
        id: "order",
        title: "My order",
        reply: "Send your order ID and we'll look it up.",
      },
      {
        id: "agent",
        title: "Human agent",
        reply: "Handing you to a teammate. Average wait is under 5 minutes in business hours.",
      },
    ],
    goals: ["support", "engage"],
    badges: ["ai", "popular"],
    recommended: true,
    industry: "Customer support",
  }),
  menuFlow({
    slug: "csat_survey",
    name: "Post-purchase survey",
    description:
      "After delivery, ask for a 1–5 rating and a comment, then thank the customer.",
    icon: "Star",
    keywords: ["feedback", "review", "rating"],
    prompt: "How did we do on your recent order?",
    buttons: [
      {
        id: "five",
        title: "Excellent",
        reply:
          "Thank you! A review on Google helps other buyers — https://example.com/review",
      },
      {
        id: "ok",
        title: "Okay",
        reply: "Thanks for the honesty. Reply with one thing we should improve.",
      },
      {
        id: "bad",
        title: "Not happy",
        reply:
          "Sorry we missed the mark. A supervisor will join this chat to make it right.",
      },
    ],
    goals: ["ops", "engage"],
    badges: ["new"],
    industry: "Customer success",
  }),
];
