/**
 * sanitize.ts — the single shared HTML sanitizer for the OpenLog client.
 *
 * Every `dangerouslySetInnerHTML` sink in `client/src` must receive output that
 * has passed through `sanitizeHtml()`. The markdown/ANSI helpers
 * (`renderMarkdown`, `simpleMarkdown`, `toMarkdownHtml`, `ansiToHtml`) call it
 * internally, so content is sanitized once, at the source.
 *
 * Threat model: log lines, container names, remote file contents, shell output
 * and LLM answers are all attacker-influenced text. `<img src=x onerror=...>`
 * and `<script>` are the realistic payloads, with log injection as the vector.
 *
 * Policy (allowlist only — anything not listed is dropped):
 *  - Tags: plain markdown/terminal structure (headings, lists, tables, code,
 *    blockquote, links, inline formatting, `span` for ANSI colors).
 *  - Attributes: `class` (ANSI/Tailwind colors + markdown), `href`, `title`,
 *    table/layout attributes.
 *  - Explicitly forbidden, belt-and-braces on top of the allowlist: `script`,
 *    `style`, `iframe`, `object`/`embed`, form controls, `link`/`meta`/`base`,
 *    SVG/MathML, and every `style`/`srcset`/`formaction` attribute.
 *  - Event handlers (`on*`) are impossible: they are simply not in the
 *    attribute allowlist, and DOMPurify strips them regardless.
 *  - `javascript:` (and any unknown scheme) URLs are blocked by the URI regexp,
 *    with `ALLOW_UNKNOWN_PROTOCOLS: false`.
 *  - `img` is intentionally NOT allowed: this app has no legitimate need to
 *    render images coming from logs/LLM output, and dropping the tag removes
 *    the whole "broken image + onerror" class of payloads outright.
 *  - Fail closed: if DOMPurify cannot run in this environment we return an
 *    empty string rather than handing raw HTML to React.
 */
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = ['script','iframe','object','embed',
  // structure / text
  'p', 'br', 'hr', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small',
  // code
  'code', 'pre', 'kbd', 'samp',
  // quotes / lists
  'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // links
  'a',
  // tables (LLM answers and reports use them)
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
];

const ALLOWED_ATTR = [
  'class',      // ANSI color classes + markdown code language classes
  'href', 'title',
  'colspan', 'rowspan', 'align', 'start',
];

// Defense in depth: even if a tag/attr ever slips into the allowlists above,
// these can never be rendered.
const FORBID_TAGS = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'label', 'fieldset',
  'link', 'meta', 'base', 'template', 'noscript',
  'svg', 'math', 'foreignObject',
  'audio', 'video', 'source', 'track', 'canvas',
];

const FORBID_ATTR = [
  'style', 'srcset', 'formaction', 'action', 'background', 'poster',
  'dynsrc', 'lowsrc', 'xlink:href',
];

// http(s) / mailto / tel, or a relative URL / fragment. This is DOMPurify's
// default policy made explicit: it rejects `javascript:`, `vbscript:`, `data:`
// (except for tags we do not allow anyway) and any unknown scheme.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/**
 * `ALLOWED_URI_REGEXP` admits protocol-relative URLs, because `//evil.example/x`
 * starts with `/` and therefore matches the "relative URL" branch. Browsers
 * resolve it against the page's protocol, i.e. to a FOREIGN origin — so an
 * attacker-influenced log line or LLM answer could render a link that navigates
 * off-site (click-through phishing, referrer/token leakage).
 *
 * Only same-origin references and explicit http(s)/mailto/tel links survive.
 *
 * Exported for direct testing: DOMPurify's own rules mask this function's
 * behaviour (it strips javascript:/data: anyway), so the protocol-relative case
 * is only observable by calling it directly. Removing the hook leaves
 * `//evil.example/x` intact — confirmed by mutation.
 */
export function isSafeHref(href: string): boolean {
  const h = href.trim();
  if (h === '') return false;
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(h)) return true;
  // Any other scheme: javascript:, data:, vbscript:, file:, blob:, …
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return false;
  // Protocol-relative — resolves to another origin. Also reject the backslash
  // variant, which several browsers normalise to '/'.
  if (h.startsWith('//') || h.startsWith('\\\\')) return false;
  // Root-relative, path-relative, query or fragment: stays on this origin.
  return true;
}

// Registered once at module load (DOMPurify hooks are global).
DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (!node.hasAttribute || !node.hasAttribute('href')) return;
  const href = node.getAttribute('href') || '';
  if (!isSafeHref(href)) node.removeAttribute('href');
});

export function sanitizeHtml(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  // Fail closed: never hand unsanitized markup to dangerouslySetInnerHTML.
  if (!DOMPurify.isSupported) return '';

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as string;
}

export default sanitizeHtml;
