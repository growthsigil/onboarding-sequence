/**
 * Turn a plain-text email body (with placeholder tokens already merged) into a
 * clean, responsive HTML email, and expose small text helpers.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Bare URLs → links (stop before common trailing punctuation).
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;

function inlineHtml(line: string): string {
  let out = "";
  let last = 0;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(line)) !== null) {
    out += escapeHtml(line.slice(last, m.index));
    const url = m[1];
    out += `<a href="${escapeAttr(url)}" style="color:#2f6df6;text-decoration:underline;word-break:break-word;">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  out += escapeHtml(line.slice(last));
  return out;
}

/** Text → HTML: blank lines split paragraphs; single newlines become <br>. */
export function bodyToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 16px;line-height:1.6;">${block.split("\n").map(inlineHtml).join("<br>")}</p>`)
    .join("\n");
}

/** Wrap a body in a minimal, email-client-safe single-column shell. */
export function renderEmailHtml(params: {
  business: string;
  bodyText: string;
  unsubscribeUrl?: string;
  preheader?: string;
}): string {
  const { business, bodyText, unsubscribeUrl } = params;
  const preheader = (params.preheader || "").slice(0, 140);
  const bodyHtml = bodyToHtml(bodyText);
  const footer = unsubscribeUrl
    ? `You're receiving this because you signed up with ${escapeHtml(business)}. <a href="${escapeAttr(unsubscribeUrl)}" style="color:#8a8f98;text-decoration:underline;">Unsubscribe</a>.`
    : `You're receiving this because you signed up with ${escapeHtml(business)}.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(business)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
  <tr>
    <td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e8eb;">
        <tr>
          <td style="padding:28px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:-0.01em;">${escapeHtml(business)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1f2937;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 28px;border-top:1px solid #eef0f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#8a8f98;">
            ${footer}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
