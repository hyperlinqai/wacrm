// SportsGenX source → first-WhatsApp-sequence templates.
//
// One welcome template plus two reminders per sequence. Everything a
// lead sees AFTER tapping a button is an interactive message defined
// in automations.mjs — it goes out inside Meta's 24-hour service
// window, so it needs no template and no review.
//
// Naming (Meta allows only [a-z0-9_]):
//   <seq>_<purpose>_<timing>
//   lw  = Lead Welcome (Meta / Google / Website share these)
//   org = Organisation & Academy onboarding
//   tc  = Tournament Created setup assistance
//   ref = Referral qualification
//   ig  = Instagram tournament digitisation
//   fu  = generic follow-up, nur = nurture loop
//
// Every QUICK_REPLY label is a routing key: Meta mirrors the label into
// `button.payload` on the inbound webhook, and the `interactive_reply`
// automations in automations.mjs match on it verbatim. Change a label
// here and the matching `reply_ids` entry must change with it —
// validateWiring() in lib.mjs fails the run if they drift.
//
// `sample_values.body` is the example Meta requires for {{1}}.

export const LANGUAGE = 'en'
export const SITE_URL = 'https://web.sportsgenx.com'
export const FOOTER = 'SportsGenX · Tournaments, made simple'

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
  // 01–03 · META / GOOGLE / WEBSITE → Lead Welcome & Requirement Discovery
  // ----------------------------------------------------------
  {
    name: 'lw_welcome_instant',
    label: 'Lead Welcome · Welcome · Instant',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 👋\n\n' +
      'Thank you for your interest in SportsGenX.\n\n' +
      'We help organisers, academies, clubs and associations organise and manage tournaments digitally — from registrations and fixtures to scoring, payments and player management.\n\n' +
      'What would you like to explore?',
    footer_text: FOOTER,
    buttons: qr('Organise a Tournament', 'Explore SportsGenX', 'Talk to Our Team'),
    sample_values: sample(),
  },
  {
    name: 'lw_reminder1_d1',
    label: 'Lead Welcome · Reminder 1 · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, just checking in 🙂\n\n' +
      'Are you planning a tournament, or looking to manage your academy, club or association digitally?\n\n' +
      'Tap below and I will point you in the right direction.',
    footer_text: FOOTER,
    buttons: qr('Organise a Tournament', 'Explore SportsGenX', 'Talk to Our Team'),
    sample_values: sample(),
  },
  {
    name: 'lw_reminder2_d3',
    label: 'Lead Welcome · Reminder 2 · Day 3',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, one last note from me for now 🏆\n\n' +
      'Whenever you plan your next tournament, SportsGenX is free to start — registrations, fixtures, live scoring, standings and payments in one place.\n\n' +
      'I am right here on WhatsApp when you need me.',
    footer_text: FOOTER,
    buttons: [...qr('Organise a Tournament', 'Talk to Our Team'), url('Visit SportsGenX')],
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // 04 · APP REGISTRATION – ORGANISATION / ACADEMY → Onboarding
  // ----------------------------------------------------------
  {
    name: 'org_welcome_instant',
    label: 'Organisation · Welcome · Instant',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 👋\n\n' +
      'Welcome to SportsGenX! Your organisation account is ready.\n\n' +
      'You can now manage tournaments, teams, players, registrations and payments — all from one place.\n\n' +
      'What would you like to set up first?',
    footer_text: FOOTER,
    buttons: qr('Manage Tournaments', 'Manage Academy / Org', 'Request Demo'),
    sample_values: sample(),
  },
  {
    name: 'org_reminder1_d1',
    label: 'Organisation · Reminder 1 · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, your SportsGenX organisation account is waiting for you 🏆\n\n' +
      'Most organisations start by creating their first tournament or adding their teams and players.\n\n' +
      'Want a hand getting set up?',
    footer_text: FOOTER,
    buttons: qr('Manage Tournaments', 'Manage Academy / Org', 'Request Demo'),
    sample_values: sample(),
  },
  {
    name: 'org_reminder2_d3',
    label: 'Organisation · Reminder 2 · Day 3',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, quick one 🙂\n\n' +
      'If you would like a guided walkthrough of SportsGenX for your organisation, our team can do it in 15 minutes — tournaments, academy management and payments included.\n\n' +
      'Shall we set one up?',
    footer_text: FOOTER,
    buttons: [...qr('Request Demo', 'Talk to Our Team'), url('Open SportsGenX')],
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // 05 · APP REGISTRATION + DEMO TOURNAMENT CREATED → Setup Assistance
  // ----------------------------------------------------------
  {
    name: 'tc_welcome_instant',
    label: 'Tournament Created · Welcome · Instant',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 🎉\n\n' +
      'Your tournament is created on SportsGenX! Here is how to get it live:\n\n' +
      '1. Add your players or teams\n' +
      '2. Configure the format, fixtures and scoring\n' +
      '3. Share the registration link and go live\n\n' +
      'Where would you like to start?',
    footer_text: FOOTER,
    buttons: qr('Add Players', 'Explore Utilities', 'Get Setup Help'),
    sample_values: sample(),
  },
  {
    name: 'tc_reminder1_d1',
    label: 'Tournament Created · Reminder 1 · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, your tournament is set up but has no players or teams yet 🏏\n\n' +
      'Adding them takes about two minutes — or share your registration link and let participants sign up themselves.\n\n' +
      'Need a hand?',
    footer_text: FOOTER,
    buttons: [...qr('Add Players', 'Get Setup Help'), url('Open SportsGenX')],
    sample_values: sample(),
  },
  {
    name: 'tc_reminder2_d3',
    label: 'Tournament Created · Reminder 2 · Day 3',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, we would love to see your tournament go live 🏆\n\n' +
      'If anything is holding you back — fixtures, scoring, registrations or payments — tell us. Setup help is free.',
    footer_text: FOOTER,
    buttons: qr('Get Setup Help', 'Explore Utilities'),
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // 06 · REFERENCE → Referral Qualification
  // ----------------------------------------------------------
  {
    name: 'ref_welcome_instant',
    label: 'Referral · Welcome · Instant',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 👋\n\n' +
      'You were referred to SportsGenX — thank you for connecting with us!\n\n' +
      'We help organisers, academies, clubs and associations manage tournaments digitally: registrations, fixtures, live scoring, payments and player management.\n\n' +
      'How can we help you?',
    footer_text: FOOTER,
    buttons: qr('Reply Here', 'Request Call Back', 'Request Demo'),
    sample_values: sample(),
  },
  {
    name: 'ref_reminder1_d1',
    label: 'Referral · Reminder 1 · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, following up on my note 🙂\n\n' +
      'Tell me what you are planning — a tournament, a league, an academy or an association — and I will match you with the right SportsGenX setup.',
    footer_text: FOOTER,
    buttons: qr('Reply Here', 'Request Call Back', 'Request Demo'),
    sample_values: sample(),
  },
  {
    name: 'ref_reminder2_d3',
    label: 'Referral · Reminder 2 · Day 3',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, one last check-in 🏆\n\n' +
      'If you have an upcoming tournament or manage an academy, SportsGenX can help you run it smoothly.\n\n' +
      'Reply anytime and I will take it from there.',
    footer_text: FOOTER,
    buttons: [...qr('Request Call Back', 'Request Demo'), url('Visit SportsGenX')],
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // 07 · INSTAGRAM POSTS → Tournament Digitisation
  // ----------------------------------------------------------
  {
    name: 'ig_welcome_instant',
    label: 'Instagram · Welcome · Instant',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 👋\n\n' +
      'Thanks for reaching out from Instagram!\n\n' +
      'Running a tournament? SportsGenX lets you digitise it end to end — online registrations, fixtures, live scores, standings and payments — so your participants follow everything on their phones.\n\n' +
      'What would you like to do?',
    footer_text: FOOTER,
    buttons: qr('Digitise My Tournament', 'Explore Features', 'Talk to Expert'),
    sample_values: sample(),
  },
  {
    name: 'ig_reminder1_d1',
    label: 'Instagram · Reminder 1 · Day 1',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, do you have an upcoming tournament? 🏏\n\n' +
      'Tell me the sport and when it is happening, and I will show you how it would look live on SportsGenX.',
    footer_text: FOOTER,
    buttons: qr('Digitise My Tournament', 'Explore Features', 'Talk to Expert'),
    sample_values: sample(),
  },
  {
    name: 'ig_reminder2_d3',
    label: 'Instagram · Reminder 2 · Day 3',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, last note from me 🏆\n\n' +
      'Digitising your tournament means no manual score sheets, automatic fixtures and standings, and a shareable live page for players and fans. Free to start.',
    footer_text: FOOTER,
    buttons: [...qr('Digitise My Tournament', 'Talk to Expert'), url('See Features')],
    sample_values: sample(),
  },

  // ----------------------------------------------------------
  // Shared follow-up (after a self-explore) + nurture loop
  // ----------------------------------------------------------
  {
    name: 'fu_check_in_d2',
    label: 'Follow-up · Self-explore check-in · Day 2',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, how has exploring SportsGenX been going? 🙂\n\n' +
      'If you would like a quick walkthrough or have a question, I am right here.',
    footer_text: FOOTER,
    buttons: qr('Book a Demo', 'I Have a Question', 'All Good'),
    sample_values: sample(),
  },
  {
    name: 'nur_value_d03',
    label: 'Nurture · Value tip · Day 3',
    category: 'Marketing',
    body_text:
      'Hi {{1}} 🏆\n\n' +
      'A quick tip: most organisers lose hours on fixtures and score sheets. SportsGenX generates fixtures for knockout, league and round-robin formats in seconds, and scores update live for everyone.\n\n' +
      'Planning a tournament soon?',
    footer_text: FOOTER,
    buttons: qr('Organise a Tournament', 'Not Right Now'),
    sample_values: sample(),
  },
  {
    name: 'nur_reengage_d10',
    label: 'Nurture · Re-engage · Day 10',
    category: 'Marketing',
    body_text:
      'Hi {{1}}, last note from me for now 🙂\n\n' +
      'Academies and associations run their full seasons on SportsGenX — registrations, live scores, standings and player stats their participants follow on their phones.\n\n' +
      'Whenever your next tournament comes up, it is free to start.',
    footer_text: FOOTER,
    buttons: [...qr('Organise a Tournament', 'Not Right Now'), url('Start Free')],
    sample_values: sample(),
  },
]

export const TEMPLATE_NAMES = TEMPLATES.map((t) => t.name)
