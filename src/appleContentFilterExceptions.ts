// Reviewed false positives in Apple's automatic adult-content classification.
// Keep full HTTPS origins with a trailing slash; never exempt a parent domain
// or remove explicit deny rules. WLU's questionnaire and its email-link host
// are explicitly approved; these exceptions do not bypass TLS validation.
export const APPLE_CONTENT_FILTER_PERMITTED_URLS = Object.freeze([
  "https://wlu.marriagepact.com/",
  "https://url8871.marriagepact.com/"
]);
