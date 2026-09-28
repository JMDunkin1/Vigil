const leaveBlockedPage = document.querySelector<HTMLAnchorElement>("#leaveBlockedPage");

leaveBlockedPage?.addEventListener("click", (event) => {
  event.preventDefault();
  blockedPageBack();
});

export {};
import { blockedPageBack } from "../src/blockedPageBack.js";
