// SportsGenX "New Lead → Won" WhatsApp templates.
//
// Naming convention (Meta allows only [a-z0-9_]):
//   s<NN>_<stage-slug>_<purpose>_<timing>
//   e.g. s01_new_lead_reminder1_2h  →  Stage 01 · New Lead · Reminder 1 · +2h
//
// Every stage message carries QUICK_REPLY buttons. Meta mirrors a
// quick-reply button's LABEL into `button.payload` on the inbound
// webhook, so the label doubles as the routing key — the
// `interactive_reply` automations in automations.mjs match on these
// exact strings. Changing a label here means changing the matching
// `reply_ids` there.
//
// `sample_values.body` is the example Meta requires for {{1}}; without
// it the submit is rejected before review.

export const LANGUAGE = 'en'
export const SITE_URL = 'https://web.sportsgenx.com'
export const FOOTER = 'SportsGenX · From Lead to Loyal Customer'

const qr = (...labels) => labels.map((text) => ({ type: 'QUICK_REPLY', text }))
const url = (text, u = SITE_URL) => ({ type: 'URL', text, url: u })
const sample = (v = 'Rahul') => ({ body: [v] })

/**
 * Every template below is one row for `message_templates` and one POST
 * to /{waba_id}/message_templates. `label` is CRM-side documentation
 * only — it never reaches Meta.
 */
export const TEMPLATES = [
  // ----------------------------------------------------------
  // Stage 01 — NEW LEAD
  // ----------------------------------------------------------
  {
    name: 's01_new_lead_welcome_instant',
    label: 'Stage 01 · New Lead · Welcome · Instant',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 👋\n\n' +
      'Thanks for reaching out to SportsGenX — the complete tournament management platform.\n\n' +
      'We help organizers, academies and associations run tournaments end to end: fixtures, live scores, teams, players and final standings.\n\n' +
      'Would you like to see how it works for your tournament?',
    footer_text: FOOTER,
    buttons: qr('Yes, tell me more', 'Not right now'),
    sample_values: sample(),
  },
  {
    name: 's01_new_lead_reminder1_2h',
    label: 'Stage 01 · New Lead · Reminder 1 · +2 hours',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, just following up on my earlier message about SportsGenX 🏆\n\n' +
      'Setting up a tournament takes under 10 minutes with us — fixtures, live scores and standings are all automatic.\n\n' +
      'Shall I show you how?',
    footer_text: FOOTER,
    buttons: qr('Yes, show me', 'Not right now'),
    sample_values: sample(),
  },
  {
    name: 's01_new_lead_reminder2_24h',
    label: 'Stage 01 · New Lead · Reminder 2 · +24 hours',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, one last check from my side 🙂\n\n' +
      'If you are planning a tournament — knockout, league, round robin or auction — SportsGenX can run it for you.\n\n' +
      'Tap below and I will help you get started.',
    footer_text: FOOTER,
    buttons: [...qr('I am interested', 'Not right now'), url('Explore SportsGenX')],
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Stage 02 — CONTACT ATTEMPT
  // ----------------------------------------------------------
  {
    name: 's02_contact_attempt_message_d0',
    label: 'Stage 02 · Contact Attempt · First message · Day 0',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 👋\n\n' +
      'Just checking whether you saw my last message about SportsGenX.\n\n' +
      'I am here to help you set up your tournament — happy to answer anything on WhatsApp, or we can do a quick call if that is easier.\n\n' +
      'How would you like to continue?',
    footer_text: FOOTER,
    buttons: qr('Continue on WhatsApp', 'Request a call back', 'Not interested'),
    sample_values: sample(),
  },
  {
    name: 's02_contact_attempt_reminder_d1',
    label: 'Stage 02 · Contact Attempt · Reminder · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, still keen to help you with your tournament 🏆\n\n' +
      'If now is not a good time, no problem — just tell me and I will check back later.\n\n' +
      'Would you like to continue?',
    footer_text: FOOTER,
    buttons: qr('Yes, continue', 'Not right now'),
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Stage 03 — QUALIFICATION (customer type)
  // ----------------------------------------------------------
  {
    name: 's03_qualification_customer_type_d0',
    label: 'Stage 03 · Qualification · Customer type · Day 0',
    category: 'Marketing',
    body_text:
      'Perfect, {{1}}! 🙌\n\n' +
      'So I can suggest the right setup, tell me a little about you.\n\n' +
      'Which of these describes you best?',
    footer_text: FOOTER,
    buttons: qr('Organizer', 'Academy', 'Association', 'Community / Club', 'Other'),
    sample_values: sample(),
  },
  {
    name: 's03_qualification_reminder_d1',
    label: 'Stage 03 · Qualification · Reminder · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, a gentle reminder 🙂\n\n' +
      'Let me know which one describes you best and I will share the setup that fits your tournaments.',
    footer_text: FOOTER,
    buttons: qr('Organizer', 'Academy', 'Association', 'Community / Club', 'Other'),
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Stage 04 — DISCOVERY (tournament type)
  // ----------------------------------------------------------
  {
    name: 's04_discovery_tournament_type_d0',
    label: 'Stage 04 · Discovery · Tournament type · Day 0',
    category: 'Marketing',
    body_text:
      'Great, {{1}}! 🎯\n\n' +
      'One more thing — what type of tournament are you planning?\n\n' +
      'This helps me show you exactly the right features.',
    footer_text: FOOTER,
    buttons: qr(
      'Knockout (KO)',
      'Points League (PL)',
      'Auction',
      'Draw',
      'League',
      'Round Robin (RR)',
      'KO + League',
      'Mixed / Other',
    ),
    sample_values: sample(),
  },
  {
    name: 's04_discovery_reminder_d1',
    label: 'Stage 04 · Discovery · Reminder · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, still here whenever you are ready 🏆\n\n' +
      'Just pick your tournament format below and I will show you how SportsGenX handles it.',
    footer_text: FOOTER,
    buttons: qr(
      'Knockout (KO)',
      'Points League (PL)',
      'Auction',
      'Draw',
      'League',
      'Round Robin (RR)',
      'KO + League',
      'Mixed / Other',
    ),
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Stage 05 — DEMO / SELF-EXPLORE
  // ----------------------------------------------------------
  {
    name: 's05_demo_invitation_d0',
    label: 'Stage 05 · Demo · Invitation · Day 0',
    category: 'Marketing',
    body_text:
      'Thanks {{1}}! 🙏\n\n' +
      'From what you have shared, I can show you exactly how SportsGenX would run your tournament.\n\n' +
      'Would you like a short demo, or would you prefer to explore on your own?',
    footer_text: FOOTER,
    buttons: qr('Yes, show me a demo', 'I will explore on my own', 'Not now'),
    sample_values: sample(),
  },
  {
    name: 's05_demo_reminder_d1',
    label: 'Stage 05 · Demo · Reminder · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, just checking back 🙂\n\n' +
      'A 15-minute demo is usually enough to see everything. Or I can send you access so you can explore at your own pace.\n\n' +
      'What works better for you?',
    footer_text: FOOTER,
    buttons: qr('Yes, show me a demo', 'I will explore on my own', 'Not now'),
    sample_values: sample(),
  },
  {
    name: 's05_demo_scheduled_confirm_d0',
    label: 'Stage 05 · Demo · Slot confirmation · Day 0',
    category: 'Marketing',
    body_text:
      'Excellent, {{1}}! 🎉\n\n' +
      'Our team will confirm your demo slot on this chat shortly.\n\n' +
      'In the meantime, feel free to take a quick look at the platform.',
    footer_text: FOOTER,
    buttons: [url('View SportsGenX')],
    sample_values: sample(),
  },
  {
    name: 's05_demo_self_explore_access_d0',
    label: 'Stage 05 · Self-Explore · Access & resources · Day 0',
    category: 'Marketing',
    body_text:
      'Perfect, {{1}} 👍\n\n' +
      'Here is your access to explore SportsGenX at your own pace — create a tournament, add teams and watch live scoring in action. It is free to start.\n\n' +
      'I am right here on WhatsApp if you get stuck.',
    footer_text: FOOTER,
    buttons: [...qr('Ask me a question'), url('Start free')],
    sample_values: sample(),
  },
  {
    name: 's05_demo_not_now_nurture_d0',
    label: 'Stage 05 · Not Now · Nurture handover · Day 0',
    category: 'Marketing',
    body_text:
      'No problem at all, {{1}} 🙂\n\n' +
      'I will keep you posted with useful tournament tips now and then. Whenever you are ready to plan your next one, just reply here.\n\n' +
      'Wishing you a great season! 🏆',
    footer_text: FOOTER,
    buttons: qr('Actually, show me a demo'),
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Stage 06 — POST-DEMO DECISION
  // ----------------------------------------------------------
  {
    name: 's06_post_demo_followup_d0',
    label: 'Stage 06 · Post-Demo · Follow-up · Day 0',
    category: 'Marketing',
    body_text:
      'Thanks for your time, {{1}}! 🙏\n\n' +
      'How did you find the demo? Your honest feedback helps me suggest the best next step for you.',
    footer_text: FOOTER,
    buttons: qr('Interested', 'Need more information', 'I have some concerns', 'Not interested'),
    sample_values: sample(),
  },
  {
    name: 's06_post_demo_reminder_d1',
    label: 'Stage 06 · Post-Demo · Reminder · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, just following up on the demo 🙂\n\n' +
      'Let me know where you stand and I will take it forward from there.',
    footer_text: FOOTER,
    buttons: qr('Interested', 'Need more information', 'I have some concerns', 'Not interested'),
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Stage 07 — OFFER & NEGOTIATION
  // ----------------------------------------------------------
  {
    name: 's07_offer_proposal_d0',
    label: 'Stage 07 · Offer · Proposal · Day 0',
    category: 'Marketing',
    body_text:
      'Great, {{1}}! 🎯\n\n' +
      'Based on your requirements I have put together the plan that fits your tournaments best — everything you need, at the right price.\n\n' +
      'Our team will share the full proposal on this chat. Anything you would like to check first?',
    footer_text: FOOTER,
    buttons: qr('Send me the proposal', 'I have a question', 'Discuss pricing'),
    sample_values: sample(),
  },
  {
    name: 's07_offer_reminder_d1',
    label: 'Stage 07 · Offer · Reminder · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, just checking in on the proposal 🙂\n\n' +
      'If anything needs adjusting — price, features or timing — tell me and we will work it out together.',
    footer_text: FOOTER,
    buttons: qr('I am ready to proceed', 'I have a question', 'Not right now'),
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Stage 08 — WON & PAYMENT  (Utility: post-purchase, transactional)
  // ----------------------------------------------------------
  {
    name: 's08_won_payment_received_d0',
    label: 'Stage 08 · Won · Payment received · Day 0',
    category: 'Utility',
    body_text:
      'Thank you, {{1}}! 🙏\n\n' +
      'Your payment has been received and your SportsGenX account is confirmed. We are excited to have you on board 🏆\n\n' +
      'Our onboarding team will reach out shortly to get you fully set up.',
    footer_text: FOOTER,
    buttons: [url('Open SportsGenX')],
    sample_values: sample(),
  },
  {
    name: 's08_won_onboarding_welcome_d1',
    label: 'Stage 08 · Won · Onboarding welcome · Day 1',
    category: 'Utility',
    body_text:
      'Welcome aboard, {{1}}! 🎉\n\n' +
      'Here is what happens next:\n' +
      '1. Account and tournament setup\n' +
      '2. Adding your teams and players\n' +
      '3. Live scoring walkthrough\n\n' +
      'Your support team is always one WhatsApp message away.',
    footer_text: FOOTER,
    buttons: qr('Start onboarding', 'Talk to support'),
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Stage 09 — NURTURE CAMPAIGN (drip for unresponsive / not-now)
  // ----------------------------------------------------------
  {
    name: 's09_nurture_value_d03',
    label: 'Stage 09 · Nurture · Value tip · Day 3',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 🏆\n\n' +
      'A quick tip: most organizers lose hours on fixtures and score sheets. SportsGenX generates fixtures for knockout, league and round-robin formats in seconds.\n\n' +
      'Want to see it on your own tournament?',
    footer_text: FOOTER,
    buttons: qr('Yes, show me', 'Not right now'),
    sample_values: sample(),
  },
  {
    name: 's09_nurture_social_proof_d07',
    label: 'Stage 09 · Nurture · Social proof · Day 7',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 👋\n\n' +
      'Academies and associations run their full seasons on SportsGenX — live scores, standings and player stats that participants follow on their phones.\n\n' +
      'Shall I show you how it would look for your event?',
    footer_text: FOOTER,
    buttons: qr('Yes, show me', 'Not right now'),
    sample_values: sample(),
  },
  {
    name: 's09_nurture_reengage_d14',
    label: 'Stage 09 · Nurture · Re-engage · Day 14',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, last note from me for now 🙂\n\n' +
      'Whenever you plan your next tournament, SportsGenX is free to start — no setup cost.\n\n' +
      'I will be right here when you need me.',
    footer_text: FOOTER,
    buttons: [...qr('I am planning one now'), url('Start free')],
    sample_values: sample(),
  },
]

export const TEMPLATE_NAMES = TEMPLATES.map((t) => t.name)
