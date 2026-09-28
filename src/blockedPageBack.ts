// This function is also embedded in classic extension scripts and block pages.
// Keep it self-contained: ordinary history navigation still runs browser guards.
export function blockedPageBack(): void {
  if (history.length > 1) {
    history.back();
    return;
  }
  let status = document.querySelector<HTMLElement>("#vigilBackStatus");
  if (!status) {
    status = document.createElement("p");
    status.id = "vigilBackStatus";
    status.className = "message";
    status.setAttribute("role", "status");
    (document.querySelector("main") || document.body).append(status);
  }
  status.textContent = "There isn’t a previous page in this tab. Close this tab or enter another address.";
}
