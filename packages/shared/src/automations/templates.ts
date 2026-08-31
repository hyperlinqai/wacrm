import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '../types'
import type {
  CatalogIcon,
  TemplateBadge,
  TemplateGoal,
} from '../templates/catalog-types'

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'
  | 'abandoned_cart'
  | 'vip_tag'
  | 'after_hours_close'
  | 'keyword_catalog'

export interface TemplateStepSeed {
  step_type: AutomationStepType
  step_config: AutomationStepConfig
  branch?: 'yes' | 'no' | null
  parent_index?: number | null
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: AutomationTriggerConfig
  steps: TemplateStepSeed[]
  icon: CatalogIcon
  goals: Exclude<TemplateGoal, 'all'>[]
  triggerKind: 'keyword' | 'first_inbound' | 'new_message'
  badges?: TemplateBadge[]
  recommended?: boolean
  industry?: string
}

export const AUTOMATION_TEMPLATES: Record<TemplateSlug, AutomationTemplateDefinition> = {
  welcome_message: {
    slug: 'welcome_message',
    name: 'Welcome new chats',
    description: 'Greet first-time WhatsApp contacts and tag them as a lead.',
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    icon: 'MessageSquare',
    goals: ['engage', 'support'],
    triggerKind: 'first_inbound',
    badges: ['popular'],
    recommended: true,
    industry: 'Customer support',
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: 'After-hours auto-reply',
    description: 'Tell people you are offline overnight so nobody is left waiting.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    icon: 'Clock',
    goals: ['support', 'ops'],
    triggerKind: 'new_message',
    badges: ['popular'],
    industry: 'Customer support',
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.",
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Pricing keyword qualifier',
    description: 'When someone mentions pricing or quote, ask one question then assign sales.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricing', 'quote', 'buy'],
      match_type: 'contains',
    },
    icon: 'Users',
    goals: ['leads', 'sales'],
    triggerKind: 'keyword',
    badges: ['popular'],
    industry: 'Sales',
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?",
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: '24-hour follow-up nudge',
    description: 'If the contact goes quiet, send a polite check-in the next day.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    icon: 'PhoneCall',
    goals: ['sales', 'engage'],
    triggerKind: 'new_message',
    industry: 'Sales',
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Just circling back — did you have any other questions for us? Happy to help!",
        },
      },
    ],
  },
  abandoned_cart: {
    slug: 'abandoned_cart',
    name: 'Cart recovery reminder',
    description: 'Keyword “cart” or “checkout” waits 2 hours, then sends a discount nudge.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['cart', 'checkout', 'payment'],
      match_type: 'contains',
    },
    icon: 'ShoppingBag',
    goals: ['sales'],
    triggerKind: 'keyword',
    badges: ['new'],
    recommended: true,
    industry: 'E-commerce',
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 2, unit: 'hours' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Still thinking it over? Complete checkout in the next 4 hours and use SAVE10 for 10% off. Reply HELP if the link failed.",
        },
      },
    ],
  },
  vip_tag: {
    slug: 'vip_tag',
    name: 'VIP keyword tag',
    description: 'Tag wholesale / partner chats the moment they mention those words.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['wholesale', 'distributor', 'partner'],
      match_type: 'contains',
    },
    icon: 'Star',
    goals: ['leads', 'ops'],
    triggerKind: 'keyword',
    industry: 'B2B',
    steps: [
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Thanks — we'll treat this as a wholesale enquiry. A merchandiser will share MOQ and rate cards.",
        },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  after_hours_close: {
    slug: 'after_hours_close',
    name: 'Close stale night chats',
    description: 'After an after-hours reply, close the conversation so morning inbox stays clean.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    icon: 'Clock',
    goals: ['ops', 'support'],
    triggerKind: 'new_message',
    industry: 'Operations',
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '22:00-07:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "We've logged this. The desk reopens at 9am and will pick up where you left off.",
        },
        parent_index: 0,
        branch: 'yes',
      },
      {
        step_type: 'close_conversation',
        step_config: {},
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  keyword_catalog: {
    slug: 'keyword_catalog',
    name: 'Keyword → catalog link',
    description: 'Anyone asking for price list or brochure gets the catalog URL instantly.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricelist', 'brochure', 'pdf'],
      match_type: 'contains',
    },
    icon: 'Link',
    goals: ['sales', 'engage'],
    triggerKind: 'keyword',
    badges: ['popular'],
    industry: 'Retail',
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Here's the latest catalog: https://example.com/catalog — reply with product codes to place an order on this chat.",
        },
      },
    ],
  },
}

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null
}
