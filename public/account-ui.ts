import { get, post } from "./api-client.js";
import { errorMessage } from "./ui-shell.js";

interface AccountUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

interface AccountSession {
  hostedAccountsEnabled: boolean;
  signupsEnabled: boolean;
  authenticated: boolean;
  user: AccountUser | null;
  mode: "local" | "hosted";
}

export function createAccountUi() {
  const dialog = document.querySelector<HTMLDialogElement>("#accountDialog");
  const accountButton = document.querySelector<HTMLButtonElement>("#accountButton");
  const closeButton = document.querySelector<HTMLButtonElement>("#closeAccountDialog");
  const signOutButton = document.querySelector<HTMLButtonElement>("#accountSignOut");
  const signInForm = document.querySelector<HTMLFormElement>("#accountSignInForm");
  const signUpForm = document.querySelector<HTMLFormElement>("#accountSignUpForm");
  if (!dialog || !accountButton || !closeButton || !signOutButton || !signInForm || !signUpForm) {
    return { bind(): void {} };
  }
  const accountDialog = dialog;
  const openAccountButton = accountButton;
  const closeAccountButton = closeButton;
  const logoutButton = signOutButton;
  const loginForm = signInForm;
  const signupForm = signUpForm;

  let session: AccountSession | null = null;

  function bind(): void {
    openAccountButton.addEventListener("click", () => accountDialog.showModal());
    closeAccountButton.addEventListener("click", () => accountDialog.close());
    accountDialog.addEventListener("click", (event) => {
      if (event.target === accountDialog) accountDialog.close();
    });

    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-auth-panel]")) {
      button.addEventListener("click", () => selectAuthPanel(button.dataset.authPanel || "signin"));
    }

    loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitAuthForm("/api/account/login", loginForm);
    });
    signupForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitAuthForm("/api/account/signup", signupForm);
    });
    logoutButton.addEventListener("click", () => void signOut());
    void refresh();
  }

  async function refresh(): Promise<void> {
    try {
      session = await get<AccountSession>("/api/account/session");
      render();
      if (session.hostedAccountsEnabled && !session.authenticated && !accountDialog.open) accountDialog.showModal();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function submitAuthForm(path: string, form: HTMLFormElement): Promise<void> {
    const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (submit) submit.disabled = true;
    setStatus(path.endsWith("signup") ? "Creating account…" : "Signing in…");
    try {
      session = await post<AccountSession>(path, Object.fromEntries(new FormData(form).entries()));
      form.reset();
      render();
      if (session.authenticated) accountDialog.close();
      window.location.reload();
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function signOut(): Promise<void> {
    logoutButton.disabled = true;
    try {
      session = await post<AccountSession>("/api/account/logout", {});
      render();
      selectAuthPanel("signin");
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      logoutButton.disabled = false;
    }
  }

  function render(): void {
    if (!session) return;
    const signedIn = session.authenticated && Boolean(session.user);
    setHidden("#accountSignedIn", !signedIn);
    setHidden("#accountAuth", signedIn || !session.hostedAccountsEnabled);
    logoutButton.hidden = session.mode !== "hosted";

    const signupTab = document.querySelector<HTMLButtonElement>("[data-auth-panel='signup']");
    if (signupTab) signupTab.hidden = !session.signupsEnabled;
    if (!session.signupsEnabled && !signedIn) selectAuthPanel("signin");

    const user = session.user || {
      id: "",
      name: "Sentinel user",
      email: "",
      role: "member" as const
    };
    const initials = accountInitials(user.name);
    const role = user.role === "admin" ? "Admin account" : "Member account";
    setText("#accountName", user.name);
    setText("#accountRole", signedIn ? role : "Sign in");
    setText("#accountAvatar", signedIn ? initials : "?");
    setText("#accountDialogName", user.name);
    setText("#accountDialogEmail", user.email || "Local administrator");
    setText("#accountDialogRole", role);
    setText("#accountDialogAvatar", initials);
    setText(
      "#accountModeCopy",
      session.mode === "local"
        ? "This administrator profile owns the local Sentinel installation. Hosted accounts can be enabled when the app is deployed."
        : "This account can access the shared Sentinel workspace. Administrators can change protection settings."
    );
    setStatus("");
  }

  function selectAuthPanel(panel: string): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-auth-panel]")) {
      const active = button.dataset.authPanel === panel;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const form of document.querySelectorAll<HTMLFormElement>("[data-auth-form]")) {
      form.hidden = form.dataset.authForm !== panel;
    }
    setStatus("");
  }

  function setStatus(message: string): void {
    setText("#accountAuthStatus", message);
  }

  return { bind };
}

function accountInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase() || "").join("") || "S";
}

function setText(selector: string, value: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element) element.textContent = value;
}

function setHidden(selector: string, hidden: boolean): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element) element.hidden = hidden;
}
