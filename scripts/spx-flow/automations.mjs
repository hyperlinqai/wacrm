// SportsGenX "New Lead → Won" automation graph.
//
// Two kinds of automation make up the flow:
//
//   DRIP  (one per stage) — fires on `tag_added` for that stage's tag,
//         sends the stage message, waits, and on NO REPLY sends a
//         reminder and finally parks the lead in the nurture campaign.
//         `stop_on_reply` + `stop_tag_ids` on trigger_config kill a
//         parked run the moment the lead answers or moves on, so a
//         reminder can never chase someone who already replied.
//
//   REPLY (interactive_reply) — fires on the button LABEL the lead
//         tapped, records what they said, and adds the NEXT stage's
//         tag. Adding that tag is what starts the next drip, so the
//         eight stages chain themselves.
//
// The `condition` step in every drip is the diagram's "Wait for Reply →
// Reply / No Reply" fork, expressed as a yes/no branch on whether the
// next stage's tag is already present.
//
// Stage 08 is deliberately NOT entered automatically — an agent adds
// the "Stage 08 · Won & Payment" tag by hand once payment lands, and
// that tag_added starts the win/onboarding sequence.

const days = (amount) => ({ step_type: 'wait', step_config: { amount, unit: 'days' } })
const minutes = (amount) => ({ step_type: 'wait', step_config: { amount, unit: 'minutes' } })
const hours = (amount) => ({ step_type: 'wait', step_config: { amount, unit: 'hours' } })

const tag = (id) => ({ step_type: 'add_tag', step_config: { tag_id: id } })
const assign = () => ({
  step_type: 'assign_conversation',
  step_config: { mode: 'round_robin' },
})
const text = (t) => ({ step_type: 'send_message', step_config: { text: t } })

const tpl = (template_name) => ({
  step_type: 'send_template',
  step_config: {
    template_name,
    language: 'en',
    variables: { 1: '{{contact.first_name|there}}' },
  },
})

/** The diagram's "Wait for Reply" fork: has the lead moved on yet? */
const replyFork = (nextStageTagId, { onReply = [], onNoReply = [] }) => ({
  step_type: 'condition',
  step_config: { subject: 'tag_presence', operand: nextStageTagId },
  branches: { yes: onReply, no: onNoReply },
})

/**
 * Build every automation. `ids` carries the runtime-resolved uuids —
 * see resolveIds() in apply.mjs.
 */
export function buildAutomations(ids) {
  const { tags: T, fields: F, pipeline } = ids

  /** Tags that mean "this lead is no longer waiting at this stage". */
  const terminal = [T.unresponsive, T.notInterested, T.nurture, T.lost]

  /** A stage drip: message → wait → (replied? stop : remind → give up). */
  const stageDrip = ({
    name,
    description,
    triggerTagId,
    nextStageTagId,
    firstTemplate,
    reminderTemplate,
    waitAmount = 1,
    waitUnit = 'days',
    giveUpTags,
    extraNoReply = [],
  }) => ({
    name,
    description,
    trigger_type: 'tag_added',
    trigger_config: {
      tag_id: triggerTagId,
      stop_on_reply: true,
      stop_tag_ids: [nextStageTagId, ...terminal].filter(Boolean),
    },
    steps: [
      tpl(firstTemplate),
      { step_type: 'wait', step_config: { amount: waitAmount, unit: waitUnit } },
      replyFork(nextStageTagId, {
        onReply: [],
        onNoReply: [
          tpl(reminderTemplate),
          days(1),
          ...extraNoReply,
          ...giveUpTags.map(tag),
        ],
      }),
    ],
  })

  return [
    // ========================================================
    // 01 — NEW LEAD  (the only entry point: a contact is created)
    // ========================================================
    {
      name: 'Stage 01 · New Lead — Welcome & Reminders',
      description:
        'Entry point. Welcomes every new lead instantly, then chases twice (+2h, +24h) before parking them in the nurture campaign. Skips bulk imports.',
      trigger_type: 'new_contact_created',
      trigger_config: {
        stop_on_reply: true,
        stop_tag_ids: [T.stage02, ...terminal].filter(Boolean),
      },
      steps: [
        // Bulk CSV/Excel imports also insert contacts — without this
        // guard a 900-row import would WhatsApp every one of them.
        {
          step_type: 'condition',
          step_config: { subject: 'contact_field', operand: 'source', value: 'import' },
          branches: {
            yes: [],
            no: [
              tag(T.stage01),
              tpl('s01_new_lead_welcome_instant'),
              minutes(30),
              replyFork(T.stage02, {
                onReply: [],
                onNoReply: [
                  hours(2),
                  tpl('s01_new_lead_reminder1_2h'),
                  hours(22),
                  tpl('s01_new_lead_reminder2_24h'),
                  days(1),
                  tag(T.unresponsive),
                  tag(T.nurture),
                ],
              }),
            ],
          },
        },
      ],
    },

    // ========================================================
    // 02 — CONTACT ATTEMPT
    // ========================================================
    stageDrip({
      name: 'Stage 02 · Contact Attempt — Message & Reminder',
      description:
        'Asks the lead how they want to be contacted. No reply after 2 days → hands the conversation to an agent for a call/email attempt, then marks unresponsive.',
      triggerTagId: T.stage02,
      nextStageTagId: T.stage03,
      firstTemplate: 's02_contact_attempt_message_d0',
      reminderTemplate: 's02_contact_attempt_reminder_d1',
      // Diagram's "Try Another Channel (Call / Email)" — a human step.
      extraNoReply: [assign()],
      giveUpTags: [T.unresponsive, T.nurture],
    }),

    // ========================================================
    // 03 — QUALIFICATION
    // ========================================================
    stageDrip({
      name: 'Stage 03 · Qualification — Customer Type',
      description:
        'Asks whether the lead is an organizer, academy, association or club. The answer is written to the "Company Type" custom field by the reply handler.',
      triggerTagId: T.stage03,
      nextStageTagId: T.stage04,
      firstTemplate: 's03_qualification_customer_type_d0',
      reminderTemplate: 's03_qualification_reminder_d1',
      giveUpTags: [T.unresponsive, T.nurture],
    }),

    // ========================================================
    // 04 — DISCOVERY
    // ========================================================
    stageDrip({
      name: 'Stage 04 · Discovery — Tournament Type',
      description:
        'Asks which tournament format they are planning (KO, league, auction …). The answer lands in the "Tournament Type interested in" custom field.',
      triggerTagId: T.stage04,
      nextStageTagId: T.stage05,
      firstTemplate: 's04_discovery_tournament_type_d0',
      reminderTemplate: 's04_discovery_reminder_d1',
      giveUpTags: [T.unresponsive, T.nurture],
    }),

    // ========================================================
    // 05 — DEMO / SELF-EXPLORE
    // ========================================================
    stageDrip({
      name: 'Stage 05 · Demo — Invitation & Reminder',
      description:
        'Offers a live demo or self-serve access. The three replies (demo / explore / not now) are each handled by their own reply automation.',
      triggerTagId: T.stage05,
      nextStageTagId: T.stage06,
      firstTemplate: 's05_demo_invitation_d0',
      reminderTemplate: 's05_demo_reminder_d1',
      giveUpTags: [T.unresponsive, T.nurture],
    }),

    // ========================================================
    // 06 — POST-DEMO DECISION
    // ========================================================
    stageDrip({
      name: 'Stage 06 · Post-Demo — Outcome Follow-up',
      description:
        'Asks how the demo went. Fires two days after the demo/self-explore handover so it lands after the demo actually happened.',
      triggerTagId: T.stage06,
      nextStageTagId: T.stage07,
      firstTemplate: 's06_post_demo_followup_d0',
      reminderTemplate: 's06_post_demo_reminder_d1',
      giveUpTags: [T.unresponsive, T.nurture],
    }),

    // ========================================================
    // 07 — OFFER & NEGOTIATION
    // ========================================================
    stageDrip({
      name: 'Stage 07 · Offer & Negotiation — Proposal',
      description:
        'Sends the proposal message and chases once. No reply → marked Lost and dropped into nurture rather than left in limbo.',
      triggerTagId: T.stage07,
      nextStageTagId: T.stage08,
      firstTemplate: 's07_offer_proposal_d0',
      reminderTemplate: 's07_offer_reminder_d1',
      giveUpTags: [T.lost, T.nurture],
    }),

    // ========================================================
    // 08 — WON & PAYMENT  (entered by hand: agent adds the tag)
    // ========================================================
    {
      name: 'Stage 08 · Won & Payment — Confirmation & Onboarding',
      description:
        'MANUAL ENTRY: an agent adds the "Stage 08 · Won & Payment" tag once payment is received. Confirms the payment, opens a Won deal, then sends the onboarding welcome a day later.',
      trigger_type: 'tag_added',
      trigger_config: { tag_id: T.stage08 },
      steps: [
        tpl('s08_won_payment_received_d0'),
        tag(T.paid),
        {
          step_type: 'create_deal',
          step_config: {
            pipeline_id: pipeline.id,
            stage_id: pipeline.wonStageId,
            title: '{{contact.name|New customer}} — SportsGenX',
            value: 0,
          },
        },
        days(1),
        tpl('s08_won_onboarding_welcome_d1'),
        tag(T.onboarding),
        assign(),
      ],
    },

    // ========================================================
    // 09 — NURTURE CAMPAIGN (the diagram's "loop back to nurture")
    // ========================================================
    {
      name: 'Stage 09 · Nurture Campaign — Day 3 / 7 / 14 Drip',
      description:
        'Where every unresponsive, "not now" and lost lead lands. Three value touches over two weeks; any reply or a move back into the pipeline ends the run immediately.',
      trigger_type: 'tag_added',
      trigger_config: {
        tag_id: T.nurture,
        stop_on_reply: true,
        stop_tag_ids: [
          T.interested,
          T.stage02,
          T.stage03,
          T.stage04,
          T.stage05,
          T.stage06,
          T.stage07,
          T.stage08,
          T.notInterested,
        ].filter(Boolean),
      },
      steps: [
        days(3),
        tpl('s09_nurture_value_d03'),
        days(4),
        tpl('s09_nurture_social_proof_d07'),
        days(7),
        tpl('s09_nurture_reengage_d14'),
        tag(T.sequenceCompleted),
      ],
    },

    // ========================================================
    // REPLY HANDLERS — one per meaningful button answer.
    // reply_ids are the exact QUICK_REPLY labels from templates.mjs.
    // ========================================================
    {
      name: 'Reply · Interested → Stage 02',
      description:
        'Positive reply to any Stage 01 or nurture message. Tags the lead Interested and moves them to Stage 02, which starts the contact-attempt drip.',
      trigger_type: 'interactive_reply',
      trigger_config: {
        reply_ids: [
          'Yes, tell me more',
          'Yes, show me',
          'I am interested',
          'I am planning one now',
        ],
      },
      steps: [tag(T.interested), tag(T.stage02)],
    },
    {
      name: 'Reply · Not right now → Nurture',
      description:
        'Soft decline on any stage. Marks the lead as deferred and hands them to the nurture campaign instead of dropping them.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['Not right now', 'Not now'] },
      steps: [tpl('s05_demo_not_now_nurture_d0'), tag(T.deferred), tag(T.nurture)],
    },
    {
      name: 'Reply · Continue on WhatsApp → Stage 03',
      description: 'Lead chose to keep talking here. Moves them into qualification.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['Continue on WhatsApp', 'Yes, continue'] },
      steps: [tag(T.stage03)],
    },
    {
      name: 'Reply · Request a call back → Agent',
      description:
        'Lead asked to be called. Tags them, assigns the conversation to an agent and acknowledges immediately.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['Request a call back'] },
      steps: [
        tag(T.callback),
        assign(),
        text(
          'Sure, {{contact.first_name|there}} 👍 Our team will call you shortly. If you have a preferred time, just tell me here.',
        ),
        tag(T.stage03),
      ],
    },
    {
      name: 'Reply · Not interested → Closed',
      description:
        'Hard decline on any stage. Stops every running sequence via the Not Interested stop tag and sends a graceful sign-off.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['Not interested'] },
      steps: [
        tag(T.notInterested),
        text(
          'Understood, {{contact.first_name|there}} — thanks for letting me know 🙏 If anything changes, just message here and I will pick it right up.',
        ),
      ],
    },
    {
      name: 'Reply · Customer type captured → Stage 04',
      description:
        'Stage 03 answer. Writes the tapped option into the "Company Type" custom field, then moves the lead to discovery.',
      trigger_type: 'interactive_reply',
      trigger_config: {
        reply_ids: ['Organizer', 'Academy', 'Association', 'Community / Club', 'Other'],
      },
      steps: [
        {
          step_type: 'update_contact_field',
          step_config: { field: `custom:${F.companyType}`, value: '{{message.text}}' },
        },
        tag(T.stage04),
      ],
    },
    {
      name: 'Reply · Tournament type captured → Stage 05',
      description:
        'Stage 04 answer. Writes the tapped format into "Tournament Type interested in", then moves the lead to the demo stage.',
      trigger_type: 'interactive_reply',
      trigger_config: {
        reply_ids: [
          'Knockout (KO)',
          'Points League (PL)',
          'Auction',
          'Draw',
          'League',
          'Round Robin (RR)',
          'KO + League',
          'Mixed / Other',
        ],
      },
      steps: [
        {
          step_type: 'update_contact_field',
          step_config: { field: `custom:${F.tournamentType}`, value: '{{message.text}}' },
        },
        tag(T.stage05),
      ],
    },
    {
      name: 'Reply · Demo requested → Book slot',
      description:
        'Lead wants a live demo. Confirms, assigns an agent to book the slot, and queues the post-demo follow-up two days out.',
      trigger_type: 'interactive_reply',
      trigger_config: {
        reply_ids: ['Yes, show me a demo', 'Actually, show me a demo'],
      },
      steps: [
        tag(T.demoRequested),
        tag(T.demoScheduled),
        tpl('s05_demo_scheduled_confirm_d0'),
        assign(),
        days(2),
        tag(T.stage06),
      ],
    },
    {
      name: 'Reply · Self-explore → Send access',
      description:
        'Lead prefers to explore alone. Sends access and still follows up two days later to hear how it went.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['I will explore on my own'] },
      steps: [
        tag(T.selfExplore),
        tpl('s05_demo_self_explore_access_d0'),
        days(2),
        tag(T.stage06),
      ],
    },
    {
      name: 'Reply · Post-demo outcome → Stage 07',
      description:
        'Stage 06 answer. A reply mentioning concerns is routed to a human as an objection; everything else is tagged Interested. Both move on to the offer stage.',
      trigger_type: 'interactive_reply',
      trigger_config: {
        reply_ids: ['Interested', 'Need more information', 'I have some concerns'],
      },
      steps: [
        {
          step_type: 'condition',
          step_config: { subject: 'message_content', operand: 'concerns', value: 'concerns' },
          branches: {
            yes: [tag(T.objection), assign()],
            no: [tag(T.interested)],
          },
        },
        tag(T.stage07),
      ],
    },
    {
      name: 'Reply · Ready to proceed → Agent closes',
      description:
        'Lead wants the proposal or is ready to buy. Hands over to a human — Stage 08 is entered by hand once payment actually lands.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['Send me the proposal', 'I am ready to proceed'] },
      steps: [
        tag(T.interested),
        assign(),
        text(
          'Brilliant, {{contact.first_name|there}} 🎉 Our team is preparing your proposal and will share it right here shortly.',
        ),
      ],
    },
    {
      name: 'Reply · Question or pricing → Agent',
      description:
        'Any "I have a question" / "Discuss pricing" tap. Tags the objection and puts a human on the conversation straight away.',
      trigger_type: 'interactive_reply',
      trigger_config: {
        reply_ids: ['I have a question', 'Discuss pricing', 'Ask me a question'],
      },
      steps: [
        tag(T.objection),
        assign(),
        text(
          'Of course, {{contact.first_name|there}} — ask away 🙂 Our team is on this chat and will answer shortly.',
        ),
      ],
    },
    {
      name: 'Reply · Onboarding / support → Agent',
      description:
        'Post-payment taps from the onboarding welcome. Assigns the conversation so onboarding starts without delay.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['Start onboarding', 'Talk to support'] },
      steps: [
        tag(T.onboarding),
        assign(),
        text(
          'Welcome aboard, {{contact.first_name|there}} 🎉 Our onboarding team is on it and will guide you step by step.',
        ),
      ],
    },
  ]
}

/** Tags the flow needs. Existing tags are reused by name; the rest are created. */
export const REQUIRED_TAGS = [
  { key: 'stage01', name: 'Stage 01 · New Lead', color: '#ef4444' },
  { key: 'stage02', name: 'Stage 02 · Contact Attempt', color: '#f97316' },
  { key: 'stage03', name: 'Stage 03 · Qualification', color: '#eab308' },
  { key: 'stage04', name: 'Stage 04 · Discovery', color: '#22c55e' },
  { key: 'stage05', name: 'Stage 05 · Demo / Self-Explore', color: '#06b6d4' },
  { key: 'stage06', name: 'Stage 06 · Post-Demo Decision', color: '#3b82f6' },
  { key: 'stage07', name: 'Stage 07 · Offer & Negotiation', color: '#8b5cf6' },
  { key: 'stage08', name: 'Stage 08 · Won & Payment', color: '#ec4899' },
  { key: 'unresponsive', name: 'Unresponsive', color: '#64748b' },
  { key: 'nurture', name: 'Nurture Campaign', color: '#94a3b8' },
  { key: 'notInterested', name: 'Not Interested', color: '#dc2626' },
  { key: 'lost', name: 'Lost', color: '#71717a' },
  { key: 'callback', name: 'Callback Requested', color: '#f59e0b' },
  { key: 'selfExplore', name: 'Self Explore', color: '#0ea5e9' },
  { key: 'demoScheduled', name: 'Demo Scheduled', color: '#14b8a6' },
  { key: 'objection', name: 'Objection / Question', color: '#fb923c' },
  // Reused from the existing tag set — matched by exact name.
  { key: 'interested', name: 'Interested', color: '#3b82f6' },
  { key: 'demoRequested', name: 'Demo Requested', color: '#3b82f6' },
  { key: 'deferred', name: 'Deferred : Future Interested', color: '#3b82f6' },
  { key: 'onboarding', name: 'Onboarding', color: '#22c55e' },
  { key: 'paid', name: 'Paid', color: '#22c55e' },
  { key: 'sequenceCompleted', name: 'Sequence Completed', color: '#64748b' },
]
