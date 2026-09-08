// SportsGenX source → first-WhatsApp-sequence automation graph.
//
// Three layers, joined by tags:
//
//   ROUTER   (new_contact_created) — one per acquisition source. Reads
//            contacts.source and adds that source's tag. The public API
//            stamps `source` on create (see docs/public-api.md); the
//            Meta Lead Ads webhook stamps `meta_ads`; web forms stamp
//            `web_form`. Adding the source tag is what starts the
//            sequence, so an agent (or the SportsGenX app via PATCH
//            tags) can also start one by hand — that is how "Tournament
//            Created" is entered for a contact who already exists.
//
//   SEQUENCE (tag_added on a source tag) — records the sequence name in
//            the "WhatsApp Sequence" custom field, sends the welcome
//            template and, while the lead has not engaged, two
//            reminders (day 1, day 3) before parking them in nurture.
//            The `condition` fork checks the "Engaged" tag, which every
//            button handler below adds; `stop_tag_ids` re-checks it the
//            moment a parked run comes due. `stop_on_reply` covers a
//            typed reply (button taps do not count as replies — see
//            sequenceStopReason in the engine — hence the tag).
//
//   HANDLER  (interactive_reply) — fires on the exact button label
//            (template quick replies) or button/row id (interactive
//            messages) the lead tapped. Records the answer, and asks the
//            next question as an INTERACTIVE message — the tap opened
//            Meta's 24-hour window, so these need no template. The
//            discovery chain (format → sport → timing → assistance →
//            organiser type) is shared by every sequence.
//
// Reply ids must be unique across handlers: the engine runs EVERY
// automation whose reply_ids contain the id. validateWiring() enforces
// that, and that every id exists on some template button or interactive
// message.

const days = (amount) => ({ step_type: 'wait', step_config: { amount, unit: 'days' } })

const tag = (id) => ({ step_type: 'add_tag', step_config: { tag_id: id } })
const assign = () => ({
  step_type: 'assign_conversation',
  step_config: { mode: 'round_robin' },
})
const text = (t) => ({ step_type: 'send_message', step_config: { text: t } })
const setField = (fieldId, value) => ({
  step_type: 'update_contact_field',
  step_config: { field: `custom:${fieldId}`, value },
})

const tpl = (template_name) => ({
  step_type: 'send_template',
  step_config: {
    template_name,
    language: 'en',
    variables: { 1: '{{contact.first_name|there}}' },
  },
})

/** Interactive reply buttons (≤ 3, titles ≤ 20 chars). Not interpolated. */
const buttons = (body, list, footer) => ({
  step_type: 'send_buttons',
  step_config: {
    kind: 'buttons',
    body,
    ...(footer ? { footer } : {}),
    buttons: list.map(([id, title]) => ({ id, title })),
  },
})

/** Interactive list (≤ 10 rows, titles ≤ 24 chars). Not interpolated. */
const list = (body, button_label, rows, footer) => ({
  step_type: 'send_list',
  step_config: {
    kind: 'list',
    body,
    ...(footer ? { footer } : {}),
    button_label,
    sections: [{ rows: rows.map(([id, title, description]) => ({ id, title, ...(description ? { description } : {}) })) }],
  },
})

const has = (tagId, { yes = [], no = [] }) => ({
  step_type: 'condition',
  step_config: { subject: 'tag_presence', operand: tagId },
  branches: { yes, no },
})

const sourceIs = (value, steps) => ({
  step_type: 'condition',
  step_config: { subject: 'contact_field', operand: 'source', value },
  branches: { yes: steps, no: [] },
})

export const SITE_URL = 'https://web.sportsgenx.com'

// ------------------------------------------------------------
// Interactive messages — the questions asked inside the 24h window.
// Row/button ids are the reply_ids the handlers below listen for.
// ------------------------------------------------------------
const Q = {
  format: list(
    'Great! What would you like to organise? 🏆\n\nPick the format closest to your plan — you can change it later.',
    'Choose format',
    [
      ['lw_q1_knockout', 'Knockout Tournament', 'Single or double elimination'],
      ['lw_q1_league', 'League / Points Table', 'Every team plays, table decides'],
      ['lw_q1_rr', 'Round Robin', 'Groups, then knockouts'],
      ['lw_q1_auction', 'Auction League', 'IPL-style player auction'],
      ['lw_q1_multi', 'Multi-sport Event', 'Sports day, meet or festival'],
      ['lw_q1_unsure', 'Not sure yet', 'We will help you decide'],
    ],
  ),
  sport: list(
    'Which sport is it? 🏏⚽🏸',
    'Choose sport',
    [
      ['lw_q2_cricket', 'Cricket'],
      ['lw_q2_football', 'Football'],
      ['lw_q2_badminton', 'Badminton'],
      ['lw_q2_pickleball', 'Pickleball'],
      ['lw_q2_tennis', 'Tennis'],
      ['lw_q2_tt', 'Table Tennis'],
      ['lw_q2_volleyball', 'Volleyball'],
      ['lw_q2_kabaddi', 'Kabaddi'],
      ['lw_q2_chess', 'Chess'],
      ['lw_q2_other', 'Other sport'],
    ],
  ),
  timing: buttons('When is your next tournament? 📅', [
    ['lw_q3_2w', 'Within 2 weeks'],
    ['lw_q3_3m', 'In 1–3 months'],
    ['lw_q3_tbd', 'Not decided yet'],
  ]),
  assistance: buttons(
    'Would you like to manage it yourself on SportsGenX, or have our team help with the setup and running?',
    [
      ['lw_q4_self', 'I will manage myself'],
      ['lw_q4_setup', 'Need setup help'],
      ['lw_q4_full', 'Full management'],
    ],
  ),
  organiser: list(
    'Last one — which of these describes you best?',
    'Choose one',
    [
      ['lw_q5_individual', 'Individual Organiser'],
      ['lw_q5_academy', 'Academy'],
      ['lw_q5_club', 'Club'],
      ['lw_q5_association', 'Association'],
      ['lw_q5_school', 'School / College'],
      ['lw_q5_corporate', 'Corporate'],
      ['lw_q5_society', 'Society / Community'],
      ['lw_q5_other', 'Other'],
    ],
  ),
  orgNeeds: list(
    'What would you like to manage for your academy or organisation?',
    'Choose one',
    [
      ['org_need_registrations', 'Player registrations', 'Online sign-ups and profiles'],
      ['org_need_fees', 'Fees & payments', 'Collect fees online'],
      ['org_need_batches', 'Batches & attendance', 'Training groups and attendance'],
      ['org_need_coaches', 'Coaches & staff', 'Roles and schedules'],
      ['org_need_internal', 'Internal tournaments', 'In-house leagues and events'],
      ['org_need_all', 'All of the above'],
    ],
  ),
  tcUtilities: list(
    'Here is what your tournament can use on SportsGenX. Which one would you like to explore first?',
    'Choose utility',
    [
      ['tc_util_registrations', 'Online registrations', 'Shareable sign-up link'],
      ['tc_util_fees', 'Fee collection', 'Entry fees paid online'],
      ['tc_util_fixtures', 'Fixtures & scheduling', 'Auto-generated for any format'],
      ['tc_util_scoring', 'Live scoring', 'Ball-by-ball / point-by-point'],
      ['tc_util_standings', 'Standings & results', 'Auto-updated tables'],
      ['tc_util_players', 'Player profiles & stats', 'Career stats for every player'],
      ['tc_util_certificates', 'Certificates', 'Digital certificates and awards'],
    ],
  ),
  refNeed: list(
    'Sure! What are you looking to do?',
    'Choose one',
    [
      ['need_tournament', 'Organise a tournament'],
      ['need_org', 'Manage academy / org'],
      ['need_digitise', 'Digitise a tournament', 'Take an existing event online'],
      ['need_explore', 'Just exploring'],
      ['need_other', 'Something else'],
    ],
  ),
  cta: (body) =>
    buttons(body, [
      ['cta_demo', 'Book a demo'],
      ['cta_talk', 'Talk to our team'],
      ['cta_done', 'All set for now'],
    ]),
  exploreNext: buttons('What would you like to do next?', [
    ['lw_explore_start', 'Start a tournament'],
    ['cta_demo', 'Book a demo'],
    ['cta_talk', 'Talk to our team'],
  ]),
  igNext: buttons('Ready to take your tournament online?', [
    ['ig_digitise', 'Digitise now'],
    ['cta_demo', 'Book a demo'],
    ['cta_talk', 'Talk to our team'],
  ]),
}

/** contacts.source value → sequence. Keys are the REQUIRED_TAGS keys. */
export const SOURCES = [
  { key: 'srcMeta', source: 'meta_ads', label: 'Meta', sequence: 'Meta → Lead Welcome', templates: 'lw' },
  { key: 'srcGoogle', source: 'google', label: 'Google', sequence: 'Google → Lead Welcome', templates: 'lw' },
  { key: 'srcWebsite', source: 'web_form', label: 'Website', sequence: 'Website → Lead Welcome', templates: 'lw' },
  { key: 'srcOrg', source: 'app_organisation', label: 'App · Organisation', sequence: 'Organisation → Onboarding', templates: 'org' },
  { key: 'srcTournament', source: 'app_tournament_created', label: 'App · Tournament Created', sequence: 'Tournament Created → Setup Assistance', templates: 'tc' },
  { key: 'srcReferral', source: 'referral', label: 'Referral', sequence: 'Referral → Qualification', templates: 'ref' },
  { key: 'srcInstagram', source: 'instagram', label: 'Instagram', sequence: 'Instagram → Tournament Digitisation', templates: 'ig' },
]

/**
 * Build every automation. `ids` carries the runtime-resolved uuids —
 * see resolveIds() in create.mjs.
 */
export function buildAutomations(ids) {
  const { tags: T, fields: F } = ids

  /** Tags that mean "stop chasing this lead". */
  const stopTags = [T.engaged, T.interested, T.notInterested, T.nurture]

  const sequence = ({ key, label, sequence: name, templates: p }) => ({
    name: `${name}`,
    description:
      `Starts when the "Source · ${label}" tag is added (the ${label} router adds it for new contacts). ` +
      'Welcome message now, reminders on day 1 and day 3 while the lead has not tapped a button, then nurture.',
    trigger_type: 'tag_added',
    trigger_config: {
      tag_id: T[key],
      stop_on_reply: true,
      stop_tag_ids: stopTags,
    },
    steps: [
      setField(F.sequence, name),
      tpl(`${p}_welcome_instant`),
      days(1),
      has(T.engaged, {
        no: [
          tpl(`${p}_reminder1_d1`),
          days(2),
          has(T.engaged, {
            no: [tpl(`${p}_reminder2_d3`), days(2), tag(T.unresponsive), tag(T.nurture)],
          }),
        ],
      }),
    ],
  })

  const router = ({ key, source, label }) => ({
    name: `Entry · ${label} → Source tag`,
    description:
      `New contact with source = "${source}" gets the "Source · ${label}" tag, which starts its sequence. ` +
      'Imports and other sources do not match and are left alone.',
    trigger_type: 'new_contact_created',
    trigger_config: {},
    steps: [sourceIs(source, [tag(T[key])])],
  })

  const handler = (name, description, replyIds, steps) => ({
    name,
    description,
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: replyIds },
    steps,
  })

  /** "Not engaged in 2 days after a self-serve link" follow-up. */
  const selfExploreFollowUp = [
    days(2),
    has(T.interested, { no: [tpl('fu_check_in_d2')] }),
  ]

  return [
    // ========================================================
    // ROUTERS + SEQUENCES — one pair per source
    // ========================================================
    ...SOURCES.map(router),
    ...SOURCES.map(sequence),

    // ========================================================
    // NURTURE — where an unresponsive lead lands
    // ========================================================
    {
      name: 'Nurture → Day 3 / Day 10 loop',
      description:
        'Two value touches for leads who never engaged. Any button tap (Engaged), a typed reply, or a Not Interested tag ends it.',
      trigger_type: 'tag_added',
      trigger_config: {
        tag_id: T.nurture,
        stop_on_reply: true,
        stop_tag_ids: [T.engaged, T.interested, T.notInterested],
      },
      steps: [days(3), tpl('nur_value_d03'), days(7), tpl('nur_reengage_d10'), tag(T.sequenceCompleted)],
    },

    // ========================================================
    // WELCOME-BUTTON HANDLERS
    // ========================================================
    handler(
      'Reply · Organise a Tournament → Discovery',
      'Lead wants to run a tournament (from any welcome, nurture, explore or referral menu). Starts the discovery chain: format → sport → timing → assistance → organiser type.',
      ['Organise a Tournament', 'Manage Tournaments', 'need_tournament', 'lw_explore_start'],
      [tag(T.engaged), tag(T.intentTournament), Q.format],
    ),
    handler(
      'Reply · Explore SportsGenX → Overview & link',
      'Lead prefers to look around first. Sends the overview and self-serve link, offers next steps, and checks in after two days if they have not moved.',
      ['Explore SportsGenX', 'need_explore'],
      [
        tag(T.engaged),
        tag(T.intentExplore),
        tag(T.selfExplore),
        text(
          'Here is a quick look at SportsGenX, {{contact.first_name|there}} 👇\n\n' +
            '🏆 Tournaments in any format — knockout, league, round robin, auction\n' +
            '📝 Online registrations and fee collection\n' +
            '📊 Auto fixtures, live scoring and standings\n' +
            '👥 Teams, players, academies and associations in one place\n\n' +
            `It is free to start: ${SITE_URL}`,
        ),
        Q.exploreNext,
        ...selfExploreFollowUp,
      ],
    ),
    handler(
      'Reply · Talk to team / Call back → Agent',
      'Lead asked for a human. Tags the callback, assigns the conversation round-robin and acknowledges.',
      ['Talk to Our Team', 'Request Call Back', 'Talk to Expert', 'cta_talk', 'need_other'],
      [
        tag(T.engaged),
        tag(T.interested),
        tag(T.callback),
        assign(),
        text(
          'Sure, {{contact.first_name|there}} 👍 One of our team members will reach out to you shortly on this chat or by call.\n\n' +
            'Meanwhile, tell me briefly what you are planning so we come prepared.',
        ),
      ],
    ),
    handler(
      'Reply · Request Demo → Book slot',
      'Lead wants a demo. Tags Demo Requested, assigns an agent to book the slot and asks for a preferred time.',
      ['Request Demo', 'Book a Demo', 'cta_demo'],
      [
        tag(T.engaged),
        tag(T.interested),
        tag(T.demoRequested),
        assign(),
        text(
          'Great choice, {{contact.first_name|there}} 🎉 Our team will confirm your demo slot on this chat shortly.\n\n' +
            'Which day and time suit you best?',
        ),
      ],
    ),

    // ========================================================
    // DISCOVERY CHAIN — shared by every sequence
    // ========================================================
    handler(
      'Discovery 1 · Format → ask sport',
      'Stores the tournament format in "Tournament Type interested in" and asks the sport.',
      ['lw_q1_knockout', 'lw_q1_league', 'lw_q1_rr', 'lw_q1_auction', 'lw_q1_multi', 'lw_q1_unsure'],
      [setField(F.tournamentType, '{{message.text}}'), Q.sport],
    ),
    handler(
      'Discovery 2 · Sport → ask timing',
      'Stores the sport in "Sports interested in" and asks when the tournament is.',
      [
        'lw_q2_cricket', 'lw_q2_football', 'lw_q2_badminton', 'lw_q2_pickleball', 'lw_q2_tennis',
        'lw_q2_tt', 'lw_q2_volleyball', 'lw_q2_kabaddi', 'lw_q2_chess', 'lw_q2_other',
      ],
      [setField(F.sports, '{{message.text}}'), Q.timing],
    ),
    handler(
      'Discovery 3 · Timing → ask assistance',
      'Stores the date plan in "Next tournament plan" and asks self-managed vs assisted.',
      ['lw_q3_2w', 'lw_q3_3m', 'lw_q3_tbd'],
      [setField(F.nextPlan, '{{message.text}}'), Q.assistance],
    ),
    handler(
      'Discovery 4 · Assistance → ask organiser type',
      'Stores the answer in "Tournament management service needed" and asks the organiser type.',
      ['lw_q4_self', 'lw_q4_setup', 'lw_q4_full'],
      [setField(F.serviceNeeded, '{{message.text}}'), Q.organiser],
    ),
    handler(
      'Discovery 5 · Organiser type → Agent',
      'Stores the organiser type in "Company Type", marks discovery complete and Interested, assigns an agent and wraps up.',
      [
        'lw_q5_individual', 'lw_q5_academy', 'lw_q5_club', 'lw_q5_association',
        'lw_q5_school', 'lw_q5_corporate', 'lw_q5_society', 'lw_q5_other',
      ],
      [
        setField(F.companyType, '{{message.text}}'),
        tag(T.interested),
        tag(T.discoveryComplete),
        assign(),
        text(
          'Thanks, {{contact.first_name|there}}! 🙌 I have everything I need.\n\n' +
            'Our team will reach out on this chat shortly to get you set up. If you would like to start right away, it is free:\n' +
            SITE_URL,
        ),
      ],
    ),

    // ========================================================
    // ORGANISATION & ACADEMY
    // ========================================================
    handler(
      'Reply · Manage Academy / Org → Needs',
      'Organisation wants academy / club management. Asks what they need to manage.',
      ['Manage Academy / Org', 'need_org'],
      [tag(T.engaged), tag(T.intentAcademy), Q.orgNeeds],
    ),
    handler(
      'Org · Need captured → Offer demo',
      'Stores the need in "Features interested in" and offers a demo of those utilities.',
      ['org_need_registrations', 'org_need_fees', 'org_need_batches', 'org_need_coaches', 'org_need_internal', 'org_need_all'],
      [
        setField(F.features, '{{message.text}}'),
        Q.cta('Noted 👍 SportsGenX handles that for academies and organisations of every size. Would you like a quick demo of these utilities?'),
      ],
    ),

    // ========================================================
    // TOURNAMENT CREATED
    // ========================================================
    handler(
      'Reply · Add Players → How-to',
      'Sends the add-players steps and the app link, then offers help.',
      ['Add Players'],
      [
        tag(T.engaged),
        tag(T.intentAddPlayers),
        text(
          'Adding players takes two minutes, {{contact.first_name|there}} 👇\n\n' +
            '1. Open your tournament → Teams / Players\n' +
            '2. Add them one by one, or import from a sheet\n' +
            '3. Or share your registration link and let participants sign up themselves\n\n' +
            SITE_URL,
        ),
        Q.cta('Need a hand with any of this?'),
      ],
    ),
    handler(
      'Reply · Explore Utilities → List',
      'Shows the tournament utilities list.',
      ['Explore Utilities'],
      [tag(T.engaged), Q.tcUtilities],
    ),
    handler(
      'Tournament · Utility captured → Offer help',
      'Stores the utility in "Features interested in" and offers a demo or setup help.',
      [
        'tc_util_registrations', 'tc_util_fees', 'tc_util_fixtures', 'tc_util_scoring',
        'tc_util_standings', 'tc_util_players', 'tc_util_certificates',
      ],
      [
        setField(F.features, '{{message.text}}'),
        Q.cta('Good pick 👍 It is already available inside your tournament. Want us to walk you through it?'),
      ],
    ),
    handler(
      'Reply · Get Setup Help → Agent',
      'High-intent: the lead has a tournament and wants help finishing it. Tags, assigns and acknowledges.',
      ['Get Setup Help'],
      [
        tag(T.engaged),
        tag(T.interested),
        tag(T.setupHelp),
        assign(),
        text(
          'On it, {{contact.first_name|there}} 🙌 A SportsGenX specialist will help you complete the setup on this chat shortly.\n\n' +
            'Tell me which part you are stuck on — players, fixtures, scoring or registrations.',
        ),
      ],
    ),

    // ========================================================
    // REFERRAL
    // ========================================================
    handler(
      'Reply · Reply Here → Need menu',
      'Referral lead chose to talk here. Shows the need menu, which routes into the right chain.',
      ['Reply Here'],
      [tag(T.engaged), Q.refNeed],
    ),

    // ========================================================
    // INSTAGRAM
    // ========================================================
    handler(
      'Reply · Digitise My Tournament → Sport',
      'Existing tournament to take online. Skips the format question and starts the chain at the sport.',
      ['Digitise My Tournament', 'need_digitise', 'ig_digitise'],
      [tag(T.engaged), tag(T.intentDigitise), Q.sport],
    ),
    handler(
      'Reply · Explore Features → Benefits & link',
      'Sends the digitisation benefits and link, offers next steps, and checks in after two days.',
      ['Explore Features'],
      [
        tag(T.engaged),
        tag(T.intentExplore),
        tag(T.selfExplore),
        text(
          'Here is what digitising your tournament with SportsGenX looks like 👇\n\n' +
            '📝 Online registrations and entry fees\n' +
            '📅 Fixtures generated in seconds, any format\n' +
            '📊 Live scoring, standings and player stats\n' +
            '📣 A shareable live page for players and fans\n\n' +
            `Free to start: ${SITE_URL}`,
        ),
        Q.igNext,
        ...selfExploreFollowUp,
      ],
    ),

    // ========================================================
    // SHARED SMALL HANDLERS
    // ========================================================
    handler(
      'Reply · All set → Close loop',
      'Lead is done for now. Acknowledges and leaves the door open.',
      ['cta_done', 'All Good'],
      [
        tag(T.engaged),
        text('Perfect 👍 All the best with your tournament, {{contact.first_name|there}}! I am here on WhatsApp whenever you need anything.'),
      ],
    ),
    handler(
      'Reply · I have a question → Agent',
      'Question from the self-explore check-in. Tags the objection and puts a human on the chat.',
      ['I Have a Question'],
      [
        tag(T.engaged),
        tag(T.objection),
        assign(),
        text('Of course, {{contact.first_name|there}} — ask away 🙂 Our team is on this chat and will answer shortly.'),
      ],
    ),
    handler(
      'Reply · Not right now → Deferred',
      'Soft decline from nurture. Marks the lead deferred and signs off gracefully.',
      ['Not Right Now'],
      [
        tag(T.engaged),
        tag(T.deferred),
        text('No problem at all, {{contact.first_name|there}} 🙂 Whenever you plan your next tournament, just message here and I will pick it right up. Wishing you a great season! 🏆'),
      ],
    ),
  ]
}

/** Tags the flow needs. Existing tags are reused by name; the rest are created. */
export const REQUIRED_TAGS = [
  // Source tags — the routers add these; adding one starts its sequence.
  { key: 'srcMeta', name: 'Source · Meta', color: '#1877f2' },
  { key: 'srcGoogle', name: 'Source · Google', color: '#ea4335' },
  { key: 'srcWebsite', name: 'Source · Website', color: '#0ea5e9' },
  { key: 'srcOrg', name: 'Source · App Organisation', color: '#8b5cf6' },
  { key: 'srcTournament', name: 'Source · Tournament Created', color: '#f97316' },
  { key: 'srcReferral', name: 'Source · Referral', color: '#22c55e' },
  { key: 'srcInstagram', name: 'Source · Instagram', color: '#e1306c' },
  // Sequence state
  { key: 'engaged', name: 'Engaged', color: '#14b8a6' },
  { key: 'discoveryComplete', name: 'Discovery Complete', color: '#16a34a' },
  { key: 'intentTournament', name: 'Intent · Organise Tournament', color: '#f59e0b' },
  { key: 'intentExplore', name: 'Intent · Explore', color: '#a3a3a3' },
  { key: 'intentAcademy', name: 'Intent · Manage Academy', color: '#7c3aed' },
  { key: 'intentAddPlayers', name: 'Intent · Add Players', color: '#fb923c' },
  { key: 'intentDigitise', name: 'Intent · Digitise Tournament', color: '#db2777' },
  { key: 'setupHelp', name: 'Setup Help Requested', color: '#ef4444' },
  // Reused from the existing tag set — matched by exact name.
  { key: 'unresponsive', name: 'Unresponsive', color: '#64748b' },
  { key: 'nurture', name: 'Nurture Campaign', color: '#94a3b8' },
  { key: 'notInterested', name: 'Not Interested', color: '#dc2626' },
  { key: 'callback', name: 'Callback Requested', color: '#f59e0b' },
  { key: 'selfExplore', name: 'Self Explore', color: '#0ea5e9' },
  { key: 'objection', name: 'Objection / Question', color: '#fb923c' },
  { key: 'interested', name: 'Interested', color: '#3b82f6' },
  { key: 'demoRequested', name: 'Demo Requested', color: '#3b82f6' },
  { key: 'deferred', name: 'Deferred : Future Interested', color: '#3b82f6' },
  { key: 'sequenceCompleted', name: 'Sequence Completed', color: '#64748b' },
]

/** Custom fields the handlers write. Existing ones are reused by name; missing ones are created (text). */
export const REQUIRED_FIELDS = [
  { key: 'sequence', name: 'WhatsApp Sequence' },
  { key: 'companyType', name: 'Company Type' },
  { key: 'tournamentType', name: 'Tournament Type interested in' },
  { key: 'sports', name: 'Sports interested in' },
  { key: 'nextPlan', name: 'Next tournament plan' },
  { key: 'serviceNeeded', name: 'Tournament management service needed' },
  { key: 'features', name: 'Features interested in' },
]
