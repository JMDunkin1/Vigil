const leaveBlockedPage = document.querySelector<HTMLAnchorElement>("#leaveBlockedPage");

leaveBlockedPage?.addEventListener("click", (event) => {
  event.preventDefault();
  location.replace("about:blank");
});

export {};
