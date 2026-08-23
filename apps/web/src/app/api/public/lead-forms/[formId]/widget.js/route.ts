// ============================================================
// GET /api/public/lead-forms/[formId]/widget.js
//
// Public — no auth. This is the entire embed integration: a landing
// page pastes exactly one tag,
//
//   <script src="https://<crm-domain>/api/public/lead-forms/<formId>/widget.js" async></script>
//
// and gets a fully self-contained lead form with zero data-attributes
// and zero second round-trip — this route bakes the form's `fields`/
// `style` config directly into the generated script so the widget never
// has to fetch its own config separately.
//
// Runs on the default Node runtime (not `edge`) — it reads the form
// config through the pg.Pool-backed DB client, which is Node-only.
// ============================================================

import { supabaseAdmin } from '@/lib/web-forms/admin-client'
import { getBaseUrl } from '@/lib/http/base-url'

interface LeadFormField {
  id: string
  type: 'text' | 'email' | 'phone' | 'textarea' | 'select'
  label: string
  placeholder?: string
  required?: boolean
  options?: string[]
}

interface LeadFormStyle {
  primaryColor?: string
  buttonText?: string
  fontFamily?: string
  borderRadius?: string
  successMessage?: string
}

const NOOP_SCRIPT = `console.warn("[wacrm] lead form is unavailable or has been paused.");`

function randomFieldName(): string {
  // Randomized per response so a scraper can't hardcode one fixed
  // honeypot field name across every site embedding this CRM.
  return `hp_${Math.random().toString(36).slice(2, 10)}`
}

/** Prevents a `</script` sequence in admin-authored config (labels,
 *  success message, etc) from prematurely closing the <script> tag a
 *  host page wraps this response in. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script')
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ formId: string }> },
) {
  const { formId } = await params
  const admin = supabaseAdmin()

  const { data: form, error } = await admin
    .from('lead_forms')
    .select('id, status, fields, style')
    .eq('id', formId)
    .maybeSingle()

  if (error || !form || form.status !== 'active') {
    return new Response(NOOP_SCRIPT, {
      status: 200,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    })
  }

  const fields = (form.fields as LeadFormField[] | null) ?? []
  const style = (form.style as LeadFormStyle | null) ?? {}
  const honeypotName = randomFieldName()
  const baseUrl = getBaseUrl(_request, { logPrefix: '[widget.js]' })
  const submitUrl = `${baseUrl}/api/public/lead-forms/${formId}/submit`

  const script = `
(function () {
  var FIELDS = ${safeJson(fields)};
  var STYLE = ${safeJson(style)};
  var HONEYPOT = ${safeJson(honeypotName)};
  var SUBMIT_URL = ${safeJson(submitUrl)};
  var SUCCESS_MESSAGE = STYLE.successMessage || "Thanks! We'll be in touch.";
  var PRIMARY = STYLE.primaryColor || "#111827";
  var FONT = STYLE.fontFamily || "system-ui, -apple-system, sans-serif";
  var RADIUS = STYLE.borderRadius || "8px";
  var BUTTON_TEXT = STYLE.buttonText || "Submit";

  var scriptEl = document.currentScript;
  var host = document.createElement("div");
  if (scriptEl && scriptEl.parentNode) {
    scriptEl.parentNode.insertBefore(host, scriptEl.nextSibling);
  } else {
    document.body.appendChild(host);
  }

  var root = host.attachShadow({ mode: "open" });
  var style2 = document.createElement("style");
  style2.textContent =
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:" + FONT + "}" +
    ".wf-field{margin-bottom:12px}" +
    ".wf-label{display:block;margin-bottom:4px;font-size:14px;color:#374151}" +
    ".wf-input,.wf-textarea,.wf-select{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:" + RADIUS + ";font-size:14px}" +
    ".wf-btn{background:" + PRIMARY + ";color:#fff;border:none;padding:10px 16px;border-radius:" + RADIUS + ";font-size:14px;cursor:pointer;width:100%}" +
    ".wf-btn:disabled{opacity:0.6;cursor:default}" +
    ".wf-error{color:#dc2626;font-size:12px;margin-top:4px}" +
    ".wf-success{color:#065f46;font-size:14px}" +
    ".wf-honeypot{position:absolute;left:-9999px;top:-9999px}";
  root.appendChild(style2);

  var form = document.createElement("form");
  var fieldEls = {};

  FIELDS.forEach(function (f) {
    var wrap = document.createElement("div");
    wrap.className = "wf-field";
    var label = document.createElement("label");
    label.className = "wf-label";
    label.textContent = f.label + (f.required ? " *" : "");
    wrap.appendChild(label);

    var input;
    if (f.type === "textarea") {
      input = document.createElement("textarea");
      input.className = "wf-textarea";
      input.rows = 3;
    } else if (f.type === "select") {
      input = document.createElement("select");
      input.className = "wf-select";
      (f.options || []).forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      });
    } else {
      input = document.createElement("input");
      input.className = "wf-input";
      input.type = f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text";
    }
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.required) input.required = true;
    wrap.appendChild(input);

    var err = document.createElement("div");
    err.className = "wf-error";
    wrap.appendChild(err);

    fieldEls[f.id] = { input: input, err: err };
    form.appendChild(wrap);
  });

  // Honeypot — invisible to a human, visible to a naive bot that fills
  // every input it finds.
  var hp = document.createElement("input");
  hp.type = "text";
  hp.name = HONEYPOT;
  hp.tabIndex = -1;
  hp.autocomplete = "off";
  hp.className = "wf-honeypot";
  form.appendChild(hp);

  var submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "wf-btn";
  submitBtn.textContent = BUTTON_TEXT;
  form.appendChild(submitBtn);

  var banner = document.createElement("div");
  banner.style.display = "none";
  form.appendChild(banner);

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    Object.keys(fieldEls).forEach(function (id) {
      fieldEls[id].err.textContent = "";
    });

    var values = {};
    FIELDS.forEach(function (f) {
      values[f.id] = fieldEls[f.id].input.value;
    });

    submitBtn.disabled = true;
    var body = {};
    body.values = values;
    body.hp = hp.value;

    fetch(SUBMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (result) {
        if (result.status === 201 && result.data.ok) {
          root.innerHTML = "";
          var success = document.createElement("div");
          success.className = "wf-success";
          success.textContent = result.data.message || SUCCESS_MESSAGE;
          root.appendChild(style2);
          root.appendChild(success);
          return;
        }
        if (result.status === 400 && result.data.errors) {
          Object.keys(result.data.errors).forEach(function (id) {
            if (fieldEls[id]) fieldEls[id].err.textContent = result.data.errors[id];
          });
        } else {
          banner.style.display = "block";
          banner.className = "wf-error";
          banner.textContent = "Something went wrong. Please try again.";
        }
        submitBtn.disabled = false;
      })
      .catch(function () {
        banner.style.display = "block";
        banner.className = "wf-error";
        banner.textContent = "Something went wrong. Please try again.";
        submitBtn.disabled = false;
      });
  });

  root.appendChild(form);
})();
`.trim()

  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  })
}
